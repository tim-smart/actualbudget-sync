import { BigDecimal, DateTime, Effect, Layer, Stream } from "effect"
import {
  AccountId,
  Akahu,
  AkahuLayer,
  ConnectionId,
  PendingTransaction,
  Transaction,
  UserId,
} from "./Akahu.ts"
import { assert, it } from "@effect/vitest"
import { runTest } from "../Sync.ts"

const AkahuTest = Layer.succeed(Akahu)(
  Akahu.of({
    lastRefreshed: DateTime.now,
    refresh: Effect.void,
    transactions: (accountId: string) =>
      accountId === "checking"
        ? Stream.make(
            new PendingTransaction({
              _user: UserId.makeUnsafe("1"),
              _account: AccountId.makeUnsafe("1"),
              _connection: ConnectionId.makeUnsafe("1"),
              date: DateTime.makeUnsafe("2021-01-01T00:00:00Z"),
              description: "Pending transaction",
              amount: BigDecimal.fromStringUnsafe("100.50"),
            }),
            new Transaction({
              _id: "1",
              _user: UserId.makeUnsafe("1"),
              _account: AccountId.makeUnsafe("1"),
              _connection: ConnectionId.makeUnsafe("1"),
              date: DateTime.makeUnsafe("2021-01-02T00:00:00Z"),
              description: "Transaction",
              amount: BigDecimal.fromStringUnsafe("200.50"),
            }),
          )
        : Stream.empty,
  }),
)

const BankTest = AkahuLayer.pipe(Layer.provide(AkahuTest))

it.layer(BankTest)("Akahu", (it) => {
  it.effect("Sync", () =>
    Effect.gen(function* () {
      const results = yield* runTest({ categorize: false })
      assert.deepStrictEqual(results, [
        {
          imported_id: "2021010110050-1",
          date: "2021-01-01",
          payee_name: "Pending transaction",
          amount: 10050,
          notes: undefined,
          cleared: false,
          account: "actual-checking",
        },
        {
          imported_id: "2021010220050-1",
          date: "2021-01-02",
          payee_name: "Transaction",
          amount: 20050,
          notes: "Transaction",
          cleared: true,
          account: "actual-checking",
        },
      ])
    }),
  )
})
