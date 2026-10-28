import { Command, Flag } from "effect/cli"
import {
  Config,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Struct,
} from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as Sync from "./Sync.ts"
import { Actual } from "./Actual.ts"
import { AkahuLive } from "./Bank/Akahu.ts"
import { UpBankLive } from "./Bank/Up.ts"

const banks = {
  akahu: AkahuLive,
  up: UpBankLive,
} as const

const bank = Flag.Literals("bank", Struct.keys(banks)).pipe(
  Flag.withDescription("Which bank to use"),
)

const accounts = Flag.KeyValuePair("accounts").pipe(
  Flag.withDescription(
    "Accounts to sync, in the format 'actual-account-id=bank-account-id'",
  ),
)

const syncDuration = Flag.Int("sync-days").pipe(
  Flag.withDescription("Number of days to sync (default: 30)"),
  Flag.withDefault(30),
  Flag.map(Duration.days),
)

const categorize = Flag.Boolean("categorize").pipe(
  Flag.withAlias("c"),
  Flag.withDefault(false),
  Flag.withDescription(
    "If the bank supports categorization, try to categorize transactions",
  ),
)

const categories = Flag.KeyValuePair("categories").pipe(
  Flag.optional,
  Flag.withDescription(
    "Requires --categorize to have any effect. Maps the banks values to actual values with the format 'bank-category=actual-category'",
  ),
)

const timezone = Flag.String("timezone").pipe(
  Flag.withDescription(
    "The timezone to use to display transaction timestamps. Defaults to the bank timezone.",
  ),
  Flag.withFallbackConfig(Config.String("TIMEZONE")),
  Flag.map((tz) => DateTime.layerCurrentZoneNamed(tz)),
  Flag.withDefault(Layer.empty),
)

const clearedOnly = Flag.Boolean("cleared-only").pipe(
  Flag.withDescription("Only sync cleared transactions"),
  Flag.withAlias("C"),
  Flag.withDefault(false),
)

const actualsync = Command.make("actualsync", {
  bank,
  accounts,
  categorize,
  categories,
  timezone,
  syncDuration,
  clearedOnly,
}).pipe(
  Command.withHandler(
    ({ accounts, categorize, categories, bank, syncDuration, clearedOnly }) =>
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
        syncDuration,
        clearedOnly,
      }).pipe(Effect.provide(Layer.mergeAll(banks[bank], Actual.layer))),
  ),
  Command.provide(({ timezone }) => timezone),
)

Command.run(actualsync, {
  version: "0.0.1",
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
