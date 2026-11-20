// The bun process, over Electrobun's RPC: it holds the vault, and the view asks it for everything.
// Commands from the menu bar and the agent come in, as does word that something changed; what the
// user saw goes out as UI events, and the agent can ask what's shown.
import { Electroview } from "electrobun/view"
import { useEffect, useEffectEvent } from "react"

import type { AppRPC, Command, Seen, Shown } from "../shared/rpc.ts"
import { queryClient, SECRETS } from "./query.ts"

const listeners = new Set<(c: Command) => void>()
let shownNow: () => Shown = () => ({
  page: "items",
  item: null,
  query: "",
  listed: 0,
  locked: true,
})

export const rpc = Electroview.defineRPC<AppRPC>({
  // Long enough for Touch ID, or the Mac's password.
  maxRequestTime: 120_000,
  handlers: {
    requests: { shown: () => shownNow() },
    messages: {
      command: (c) => {
        for (const l of listeners) {
          l(c)
        }
      },
      changed: () => {
        void queryClient.invalidateQueries({ queryKey: SECRETS })
      },
    },
  },
})

void new Electroview({ rpc })

/** The bun process's answers to the view's asks. */
export const ask = rpc.request

/** Runs what the menu bar or the agent asks, and answers what's shown. */
export const useBridge = (run: (c: Command) => void, shown: () => Shown) => {
  const chosen = useEffectEvent(run)
  const answer = useEffectEvent(shown)
  useEffect(() => {
    const l = (c: Command) => {
      chosen(c)
    }
    listeners.add(l)
    shownNow = () => answer()
    return () => {
      listeners.delete(l)
    }
  }, [])
}

/** Tells Switch the user is looking at `item` on `surface`, and how long they stayed. */
export const useSeen = (surface: string, item: string | undefined) => {
  useEffect(() => {
    const at = performance.now()
    const where: Seen = item === undefined ? { surface } : { surface, item }
    rpc.send.seen(where)
    return () => {
      rpc.send.left({ ...where, ms: Math.round(performance.now() - at) })
    }
  }, [surface, item])
}
