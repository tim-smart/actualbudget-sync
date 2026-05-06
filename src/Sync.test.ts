import { BigDecimal, DateTime, Duration, Effect, Layer, Option } from "effect"
import { assert, it } from "@effect/vitest"
import { Bank } from "./Bank.ts"
import { Actual, ActualError, type Query } from "./Actual.ts"
import { run } from "./Sync.ts"
import type { TransactionEntity } from "@actual-app/api/@types/loot-core/src/types/models/transaction.js"
import type * as Api from "@actual-app/api"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const transferTx = {
  dateTime: DateTime.makeUnsafe(new Date("2024-01-20T10:00:00Z").getTime()),
  amount: BigDecimal.fromStringUnsafe("-200"), // amountToInt → -20000
  payee: "Transfer to Partner",
  transfer: "personal-b", // matches bank account ID
  externalId: "ext-transfer-1",
  cleared: true,
}

const regularTx = {
  dateTime: DateTime.makeUnsafe(new Date("2024-01-21T08:00:00Z").getTime()),
  amount: BigDecimal.fromStringUnsafe("-4.5"), // amountToInt → -450
  payee: "Coffee Shop",
  externalId: "ext-coffee-1",
  cleared: true,
}

const crossPayees = [
  { id: "pa-payee", name: "Personal A", transfer_acct: "actual-personal-a" },
  { id: "pb-payee", name: "Personal B", transfer_acct: "actual-personal-b" },
]

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const makeBankLayer = () =>
  Layer.succeed(Bank)({
    exportAccount: (accountId) =>
      Effect.succeed(accountId === "personal-a" ? [transferTx, regularTx] : []),
  })

const makeMockActualLayer = (opts: {
  counterpartFn: (accountId: string, amount: number, date: string) => boolean
}) => {
  const importCalls: Array<{ accountId: string; transactions: unknown[] }> = []

  const mockApiObj = {
    getCategories: async () => [],
    getPayees: async () => crossPayees,
    importTransactions: async (accountId: string, transactions: unknown[]) => {
      importCalls.push({ accountId, transactions })
    },
  }

  const layer = Layer.succeed(Actual)(
    Actual.of({
      use: <A>(f: (api: typeof Api) => Promise<A>) =>
        Effect.tryPromise({
          try: () => f(mockApiObj as unknown as typeof Api),
          catch: (cause) => new ActualError({ cause }),
        }),
      query: <A>(_f: (q: (typeof Api)["q"]) => Query) =>
        Effect.succeed([] as ReadonlyArray<A>),
      findImported: (_ids: ReadonlyArray<string>, _accountId: string) =>
        Effect.succeed(new Map()),
      findTransferCounterpart: (
        accountId: string,
        amount: number,
        date: string,
      ) =>
        Effect.succeed(
          opts.counterpartFn(accountId, amount, date)
            ? Option.some({
                id: "mock-ct",
                transfer_id: "some-id",
                imported_id: null,
                date,
              } as unknown as TransactionEntity)
            : Option.none(),
        ),
    }),
  )

  return { layer, importCalls }
}

const runOptions = {
  accounts: [
    { bankAccountId: "personal-a", actualAccountId: "actual-personal-a" },
  ],
  transferAccounts: [
    { bankAccountId: "personal-b", actualAccountId: "actual-personal-b" },
  ],
  syncDuration: Duration.days(30),
  categorize: false,
  clearedOnly: false,
} as const

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.effect(
  "run(): skips transfer transaction when counterpart already exists in Actual",
  () =>
    Effect.gen(function* () {
      const { layer: actualLayer, importCalls } = makeMockActualLayer({
        counterpartFn: (_accountId, amount) => amount === -20000,
      })

      yield* run(runOptions).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(makeBankLayer(), actualLayer)),
      )

      const call = importCalls.find((c) => c.accountId === "actual-personal-a")
      assert.exists(
        call,
        "importTransactions should have been called for personal-a",
      )

      const amounts = (call!.transactions as Array<{ amount: number }>).map(
        (t) => t.amount,
      )
      assert.notInclude(
        amounts,
        -20000,
        "transfer should be skipped when counterpart exists",
      )
      assert.include(
        amounts,
        -450,
        "regular transaction should still be imported",
      )
    }),
)

it.effect(
  "run(): imports transfer transaction when no counterpart exists in Actual",
  () =>
    Effect.gen(function* () {
      const { layer: actualLayer, importCalls } = makeMockActualLayer({
        counterpartFn: () => false,
      })

      yield* run(runOptions).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(makeBankLayer(), actualLayer)),
      )

      const call = importCalls.find((c) => c.accountId === "actual-personal-a")
      assert.exists(
        call,
        "importTransactions should have been called for personal-a",
      )

      const amounts = (call!.transactions as Array<{ amount: number }>).map(
        (t) => t.amount,
      )
      assert.include(
        amounts,
        -20000,
        "transfer should be imported when no counterpart exists",
      )
      assert.include(amounts, -450, "regular transaction should be imported")
    }),
)
