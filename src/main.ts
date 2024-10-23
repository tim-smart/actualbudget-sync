import { Command, Options } from "@effect/cli"
import { Effect, Layer, Struct, Option } from "effect"
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

const categorize = Options.boolean("categorize").pipe(
  Options.withAlias("c"),
  Options.withDescription(
    "If the bank supports categorization, try to categorize transactions",
  ),
)

const categories = Options.keyValueMap("categories").pipe(
  Options.optional,
  Options.withDescription(
    "Requires --categorize to have any effect. Maps the banks values to actual values with the format 'bank-category=actual-category'",
  ),
)

const run = Command.make("actualsync", { bank, accounts, categorize, categories }).pipe(
  Command.withHandler(({ accounts, categorize, categories }) =>
    Sync.run({
      accounts: [...accounts].map(([actualAccountId, bankAccountId]) => ({
        actualAccountId,
        bankAccountId,
      })),
      categorize,
      categoryMapping: Option.getOrUndefined(
        Option.map(categories,
          (categoriesOption) => [...categoriesOption].map(([bankCategory, actualCategory]) => ({ bankCategory, actualCategory }))))
    }),
  ),
  Command.provide(({ bank }) => Layer.mergeAll(banks[bank], Actual.Default)),
  Command.run({
    name: "actualsync",
    version: "0.0.1",
  }),
)

run(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
