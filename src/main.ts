import { Command, Options } from "@effect/cli"
import { Effect, Layer, Struct } from "effect"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import * as Sync from "./Sync.js"
import { Actual } from "./Actual.js"
import { AkahuLive } from "./Bank/Akahu.js"
import { UpBankLive } from "./Bank/Up.js"

const banks = {
  akahu: AkahuLive,
  up: UpBankLive,
} as const

const bank = Options.choice("bank", Struct.keys(banks)).pipe(
  Options.withDescription("Which bank to use"),
)

const accounts = Options.keyValueMap("accounts").pipe(
  Options.withDescription(
    "Accounts to sync, in the format 'actual-account-id=bank-account-id'",
  ),
)

const run = Command.make("actualsync", { bank, accounts }).pipe(
  Command.withHandler(({ accounts }) =>
    Sync.run(
      [...accounts].map(([actualAccountId, bankAccountId]) => ({
        actualAccountId,
        bankAccountId,
      })),
    ),
  ),
  Command.provide(({ bank }) => Layer.mergeAll(banks[bank], Actual.Default)),
  Command.run({
    name: "actualsync",
    version: "0.0.1",
  }),
)

run(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
