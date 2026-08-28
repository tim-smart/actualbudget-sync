import { BigDecimal, DateTime, Duration, Effect, Layer, Stream } from "effect"
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
import { run, runTest } from "../Sync.ts"
import { Actual } from "../Actual.ts"
import type * as Api from "@actual-app/api"
import type { TransactionEntity } from "@actual-app/api/@types/loot-core/src/types/models/transaction.js"

const AkahuTest = Layer.succeed(Akahu)(
  Akahu.of({
    lastRefreshed: DateTime.now,
    refresh: Effect.succeed({ success: true }),
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
              created_at: DateTime.makeUnsafe("2021-01-03T20:00:00Z"),
              description: "Transaction",
              amount: BigDecimal.fromStringUnsafe("200.50"),
            }),
            new Transaction({
              _id: "2",
              _user: UserId.makeUnsafe("1"),
              _account: AccountId.makeUnsafe("1"),
              _connection: ConnectionId.makeUnsafe("1"),
              date: DateTime.makeUnsafe("2021-01-03T00:00:00Z"),
              description: "No created_at",
              amount: BigDecimal.fromStringUnsafe("300.75"),
            }),
          )
        : Stream.empty,
  }),
)

const BankTest = AkahuLayer.pipe(Layer.provide(AkahuTest))

const makeActualStub = (alreadyImported: ReadonlyArray<TransactionEntity>) => {
  const updateCalls: Array<{
    id: string
    fields: Record<string, unknown>
  }> = []
  const importCalls: Array<{
    accountId: string
    transactions: ReadonlyArray<{ imported_id: string; date: string }>
  }> = []
  const api = {
    getCategories: async () => [],
    getPayees: async () => [],
    updateTransaction: async (id: string, fields: Record<string, unknown>) => {
      updateCalls.push({ id, fields })
    },
    updatePayee: async () => {},
    importTransactions: async (
      accountId: string,
      transactions: ReadonlyArray<{ imported_id: string; date: string }>,
    ) => {
      importCalls.push({ accountId, transactions })
      return { errors: [], added: [], updated: [] }
    },
  } as unknown as typeof Api
  const existingMap = new Map(
    alreadyImported.map((tx) => [tx.imported_id!, tx]),
  )
  const layer = Layer.succeed(Actual)(
    Actual.of({
      use: (f) => Effect.promise(() => f(api)),
      query: () => Effect.die("not implemented"),
      findImported: () => Effect.succeed(existingMap),
    }),
  )
  return { layer, updateCalls, importCalls }
}

const existingUncleared = {
  id: "existing-1",
  imported_id: "2021010220050-1",
  cleared: false,
  payee: "payee-1",
  imported_payee: "Transaction",
} as unknown as TransactionEntity

const runOptions = {
  accounts: [{ bankAccountId: "checking", actualAccountId: "actual-checking" }],
  categorize: false,
  syncDuration: Duration.days(30),
  clearedOnly: false,
} as const

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
        {
          imported_id: "2021010330075-1",
          date: "2021-01-03",
          payee_name: "No created_at",
          amount: 30075,
          notes: "No created_at",
          cleared: true,
          account: "actual-checking",
        },
      ])
    }),
  )

  it.effect("Sync with settledDate", () =>
    Effect.gen(function* () {
      const results = yield* runTest({ categorize: false, settledDate: true })
      assert.deepStrictEqual(results, [
        {
          // Pending transactions have no settled date, so nothing changes
          imported_id: "2021010110050-1",
          date: "2021-01-01",
          payee_name: "Pending transaction",
          amount: 10050,
          notes: undefined,
          cleared: false,
          account: "actual-checking",
        },
        {
          // The date comes from created_at (2021-01-03T20:00:00Z is
          // 2021-01-04 in Pacific/Auckland), while the imported_id stays
          // derived from the transaction date to keep matching stable
          imported_id: "2021010220050-1",
          date: "2021-01-04",
          payee_name: "Transaction",
          amount: 20050,
          notes: "Transaction",
          cleared: true,
          account: "actual-checking",
        },
        {
          // Without created_at, the transaction date is used as-is
          imported_id: "2021010330075-1",
          date: "2021-01-03",
          payee_name: "No created_at",
          amount: 30075,
          notes: "No created_at",
          cleared: true,
          account: "actual-checking",
        },
      ])
    }),
  )

  it.effect(
    "run updates date and cleared when a pending transaction settles with settledDate",
    () =>
      Effect.gen(function* () {
        const actual = makeActualStub([existingUncleared])
        yield* run({ ...runOptions, settledDate: true }).pipe(
          Effect.provide(actual.layer),
        )
        assert.deepStrictEqual(actual.updateCalls, [
          {
            id: "existing-1",
            fields: {
              cleared: true,
              amount: 20050,
              date: "2021-01-04",
            },
          },
        ])
        assert.deepStrictEqual(
          actual.importCalls.flatMap((call) =>
            call.transactions.map((tx) => tx.imported_id),
          ),
          ["2021010110050-1", "2021010330075-1"],
        )
      }),
  )

  it.effect("run does not update the date without settledDate", () =>
    Effect.gen(function* () {
      const actual = makeActualStub([existingUncleared])
      yield* run({ ...runOptions, settledDate: false }).pipe(
        Effect.provide(actual.layer),
      )
      assert.deepStrictEqual(actual.updateCalls, [
        {
          id: "existing-1",
          fields: {
            cleared: true,
            amount: 20050,
          },
        },
      ])
    }),
  )
})
