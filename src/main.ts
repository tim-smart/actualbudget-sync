import { Command, Flag } from "effect/unstable/cli"
import { Effect, Layer, Option, Struct } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as Sync from "./Sync.ts"
import { Actual } from "./Actual.ts"
import { AkahuLive } from "./Bank/Akahu.ts"
import { UpBankLive } from "./Bank/Up.ts"

const banks = {
  akahu: AkahuLive,
  up: UpBankLive,
} as const

const bank = Flag.choice("bank", Struct.keys(banks)).pipe(
  Flag.withDescription("Which bank to use"),
)

const accounts = Flag.keyValuePair("accounts").pipe(
  Flag.withDescription(
    "Accounts to sync, in the format 'actual-account-id=bank-account-id'",
  ),
)

const categorize = Flag.boolean("categorize").pipe(
  Flag.withAlias("c"),
  Flag.withDescription(
    "If the bank supports categorization, try to categorize transactions",
  ),
)

const categories = Flag.keyValuePair("categories").pipe(
  Flag.optional,
  Flag.withDescription(
    "Requires --categorize to have any effect. Maps the banks values to actual values with the format 'bank-category=actual-category'",
  ),
)

const actualsync = Command.make("actualsync", {
  bank,
  accounts,
  categorize,
  categories,
}).pipe(
  Command.withHandler(({ accounts, categorize, categories, bank }) =>
    Sync.run({
      accounts: Object.entries(accounts).map(
        ([actualAccountId, bankAccountId]) => ({
          actualAccountId,
          bankAccountId,
        }),
      ),
      categorize,
      categoryMapping: Option.getOrUndefined(
        Option.map(categories, (categoriesOption) =>
          Object.entries(categoriesOption).map(
            ([bankCategory, actualCategory]) => ({
              bankCategory,
              actualCategory,
            }),
          ),
        ),
      ),
    }).pipe(Effect.provide(Layer.mergeAll(banks[bank], Actual.layer))),
  ),
)

const run = Command.runWith(actualsync, {
  version: "0.0.1",
})

run(process.argv).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
