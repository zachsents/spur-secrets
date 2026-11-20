// The secrets spur as a stdio MCP server: `bun src/main.ts`. With a word, a one-off on this Mac's
// vault, for its owner at its own terminal:
//   approve <code>   approves the device or spur showing that code
//   status           the vault's devices, spurs and how many items it holds (nothing secret)
//   backup           a copy of the sealed vault file now
import { Effect, Layer } from "effect"
import { Models, serveStdio } from "spur-kit"

import { announce, secretsApp } from "./app.ts"
import { approveCode } from "./ops.ts"
import { backup, devices, openVault, seedGrants, spurs } from "./store.ts"

/** Devices and spurs without their keys. */
const show = <A extends { key: string }>(xs: readonly A[]) => xs.map(({ key: _, ...rest }) => rest)

const vault = await openVault()
seedGrants(vault)

const word = process.argv.at(2)
if (word === "approve") {
  console.log(await approveCode(vault, process.argv.at(3) ?? ""))
  process.exit(0)
} else if (word === "status") {
  console.log(
    JSON.stringify(
      {
        vault: vault.keys.vault,
        keyVersion: vault.keys.version,
        items: vault.items.size,
        devices: show(devices(vault)),
        spurs: show(spurs(vault)),
      },
      null,
      1,
    ),
  )
  process.exit(0)
} else if (word === "backup") {
  console.log(backup(vault))
  process.exit(0)
} else if (word !== undefined) {
  console.error(`Unknown command ${word}: approve <code>, status or backup`)
  process.exit(2)
}

const app = secretsApp(vault)

// A copy of the sealed vault a day, kept for two weeks.
const backups = Effect.forever(
  Effect.andThen(
    Effect.sync(() => backup(vault)),
    Effect.sleep("6 hours"),
  ),
)

const background = Layer.effectDiscard(
  Effect.gen(function* starting() {
    yield* Effect.forkScoped(announce)
    yield* Effect.forkScoped(Effect.ignore(backups))
  }),
)

await serveStdio(app, Layer.provideMerge(background, Models.layer))
