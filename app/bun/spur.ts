// The window as a spur, `secrets-app`: tools the agent drives it with, and what the user does in it
// as UI events. It dials the core's /spurs and speaks MCP over that socket, again whenever it drops.
// The window may show secrets, so nothing here pictures it or says a value: no screenshot, ever.
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server"
import { AppEvents, defineApp, left, serve, tool, Viewed } from "spur-kit"
import type { Draft } from "spur-kit"
import { Effect, Queue, Schema } from "effect"

import { PAGES } from "../shared/rpc.ts"
import { withToken } from "./core.ts"
import type { Command, Seen, Shown } from "../shared/rpc.ts"

export interface Window {
  /** Brings the window forward, opening it if it's closed. */
  readonly front: () => void
  readonly send: (c: Command) => void
  readonly shown: () => Promise<Shown>
}

const task = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })

const front = Schema.optionalKey(Schema.Boolean)

const windowApp = ({ front: forward, send, shown }: Window) => {
  const told = (c: Command, bring: boolean | undefined) =>
    Effect.gen(function* telling() {
      send(c)
      if (bring === true) {
        forward()
      }
      // A frame for the window to draw it, so what's shown is after.
      yield* Effect.sleep("150 millis")
      return yield* task(shown)
    })
  return defineApp({
    name: "secrets-app",
    version: "1",
    instructions:
      "The Secrets window on this Mac: open an item, search, show a page, see what's on screen (titles only, never a value). Use secrets go through the secrets tools.",
    tools: [
      tool(
        "open",
        {
          description:
            "Open an item in the Secrets window, by id or name. `front` brings the window forward.",
          input: Schema.Struct({ item: Schema.String, front }),
        },
        (input) => told({ kind: "open", item: input.item }, input.front),
      ),
      tool(
        "find",
        {
          description: "Search the Secrets window's list, as the user would type it.",
          input: Schema.Struct({ query: Schema.String, front }),
        },
        (input) => told({ kind: "search", query: input.query }, input.front),
      ),
      tool(
        "page",
        {
          description:
            "Show a page: items, the password generator, devices, grants, audit, import or export.",
          input: Schema.Struct({ page: Schema.Literals(PAGES), front }),
        },
        (input) => told({ kind: "page", page: input.page }, input.front),
      ),
      tool(
        "shown",
        {
          description:
            "What the window shows now: its page, the item open (id and title), the search, how many are listed, whether it's locked.",
          readOnly: true,
        },
        () => task(shown),
      ),
    ],
  })
}

const parse: (json: string) => JSONRPCMessage = JSON.parse

/** One MCP session over a WebSocket to `url`, until it closes. */
const socketTransport = (url: string) =>
  Effect.callback<Transport, Error>((resume) => {
    const ws = new WebSocket(url)
    const transport: Transport = {
      start: async () => {
        await Promise.resolve()
      },
      send: async (m) => {
        ws.send(JSON.stringify(m))
        await Promise.resolve()
      },
      close: async () => {
        ws.close()
        await Promise.resolve()
      },
    }
    ws.addEventListener("open", () => {
      resume(Effect.succeed(transport))
    })
    ws.addEventListener("message", (e) => {
      if (typeof e.data === "string") {
        transport.onmessage?.(parse(e.data))
      }
    })
    ws.addEventListener("close", () => {
      transport.onclose?.()
      resume(Effect.fail(new Error("Can't reach the core")))
    })
    return Effect.sync(() => {
      ws.close()
    })
  })

/** What the user saw, as UI events: in view, then backed out of or stayed on. */
const draftOf = (s: Seen): Draft => {
  if (s.ms === undefined) {
    return Viewed.make(
      s.item === undefined ? { surface: s.surface } : { surface: s.surface, item: s.item },
    )
  }
  return left(s.surface, s.item, Date.now() - s.ms)
}

const seen = Effect.runSync(Queue.unbounded<Draft>())

/** What the user saw, sent on as UI events while the window is dialed in. */
export const saw = (s: Seen) => {
  Queue.offerUnsafe(seen, draftOf(s))
}

/** Keeps the window dialed in to the core at `core` (http://…). */
export const dialCore = (window: Window, core: string) => {
  const url = new URL("/spurs?name=secrets-app", core)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  const app = windowApp(window)
  const once = Effect.scoped(
    Effect.gen(function* session() {
      const transport = yield* socketTransport(withToken(url).href)
      const done = yield* serve(app, transport)
      yield* done
    }),
  ).pipe(Effect.ignore)
  const program = Effect.gen(function* dialing() {
    const events = yield* AppEvents
    yield* Effect.forkScoped(
      Effect.forever(Effect.flatMap(Queue.take(seen), (d) => Effect.ignore(events.emit(d)))),
    )
    yield* Effect.forever(Effect.andThen(once, Effect.sleep("3 seconds")))
  }).pipe(Effect.scoped, Effect.provide(AppEvents.layer(app)))
  Effect.runFork(program)
}
