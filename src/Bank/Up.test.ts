import { BigDecimal, DateTime, Effect, Layer, Stream } from "effect"
import { assert, it } from "@effect/vitest"
import { runTest } from "../Sync"
import { Up, Transaction, UpLayer, MoneyObject } from "./Up"

const UpTest = Layer.succeed(
  Up,
  new Up({
    transactions: (accountId: string) =>
      accountId === "checking"
        ? Stream.make(
            new Transaction({
              type: "transactions",
              attributes: {
                status: "HELD",
                description: "Transaction",
                amount: MoneyObject.make({
                  valueInBaseUnits: BigDecimal.unsafeFromString("200.50"),
                }),
                createdAt: DateTime.unsafeMakeZoned("2024-12-03T13:57:01", {
                  timeZone: "Australia/Brisbane",
                }),
                note: { text: "Transaction note" },
              },
              relationships: {
                category: {
                  data: {
                    type: "categories",
                    id: "test",
                  },
                },
                transferAccount: {
                  data: {
                    type: "accounts",
                    id: "transferAccountId",
                  },
                },
              },
            }),
          )
        : Stream.empty,
  }),
)

const BankTest = UpLayer.pipe(Layer.provide(UpTest))

it.layer(BankTest)("Up", (it) => {
  it.effect("Sync", () =>
    Effect.gen(function* () {
      const results = yield* runTest({ categorize: false })
      assert.deepStrictEqual(results, [
        {
          account: "actual-checking",
          amount: 200.5,
          cleared: false,
          date: "2024-12-03",
          imported_id: "20241203200.5-1",
          notes: "Transaction note",
          payee: "1",
        },
      ])
    }),
  )
})
