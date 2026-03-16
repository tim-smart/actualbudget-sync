/**
 * @since 1.0.0
 */
import {
  Array,
  BigDecimal,
  DateTime,
  Duration,
  Effect,
  Fiber,
  pipe,
} from "effect"
import {
  type AccountTransaction,
  AccountTransactionOrder,
  Bank,
} from "./Bank.ts"
import { Actual, ActualError } from "./Actual.ts"

const bigDecimal100 = BigDecimal.fromNumberUnsafe(100)
const amountToInt = (amount: BigDecimal.BigDecimal) =>
  amount.pipe(BigDecimal.multiply(bigDecimal100), BigDecimal.toNumberUnsafe)

export const runCollect = Effect.fnUntraced(function* (options: {
  readonly accounts: ReadonlyArray<{
    readonly bankAccountId: string
    readonly actualAccountId: string
  }>
  readonly categorize: boolean
  readonly categoryMapping?: ReadonlyArray<{
    readonly bankCategory: string
    readonly actualCategory: string
  }>
  readonly categories: ReadonlyArray<{
    readonly id: string
    readonly name: string
  }>
  readonly payees: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly transfer_acct?: string
  }>
  readonly syncDuration: Duration.Duration
}) {
  const bank = yield* Bank
  const importId = makeImportId()

  const categoryId = (transaction: AccountTransaction) => {
    const categoryName =
      options.categoryMapping?.find(
        (mapping) => mapping.bankCategory === transaction.category,
      )?.actualCategory ?? transaction.category
    const category = options.categories.find(
      (c) => c.name.toLowerCase() === categoryName?.toLowerCase(),
    )
    return category ? category.id : undefined
  }

  const transferAccountId = (transaction: AccountTransaction) => {
    const transferToAccount = options.accounts.find(
      ({ bankAccountId }) => bankAccountId === transaction.transfer,
    )?.actualAccountId
    return options.payees.find((it) => it.transfer_acct === transferToAccount)
      ?.id
  }

  const now = yield* DateTime.now
  const since = DateTime.subtractDuration(now, options.syncDuration)

  return yield* Effect.forEach(
    options.accounts,
    Effect.fnUntraced(function* ({ bankAccountId, actualAccountId }) {
      const transactions = yield* bank.exportAccount(bankAccountId, {
        since,
      })
      const ids: Array<string> = []
      const forImport = pipe(
        transactions,
        // oxlint-disable-next-line unicorn/no-array-sort
        Array.sort(AccountTransactionOrder),
        // oxlint-disable-next-line oxc/no-map-spread
        Array.map((transaction): ImportTransaction => {
          const imported_id = importId(bankAccountId, transaction)
          const category = options.categorize && categoryId(transaction)
          const transferPayee =
            transaction.transfer && transferAccountId(transaction)

          ids.push(imported_id)

          return {
            account: actualAccountId,
            imported_id,
            date: DateTime.formatIsoDate(transaction.dateTime),
            ...(transferPayee
              ? { payee: transferPayee }
              : { payee_name: transaction.payee }),
            amount: amountToInt(transaction.amount),
            notes: transaction.notes,
            cleared: transaction.cleared,
            ...(category ? { category } : undefined),
          }
        }),
      )
      return {
        transactions: forImport,
        ids,
        actualAccountId,
      }
    }),
  )
})

type ImportTransaction =
  | {
      category?: string | undefined
      amount: number
      notes: string | undefined
      cleared: boolean | undefined
      payee: string
      account: string
      imported_id: string
      date: string
    }
  | {
      category?: string | undefined
      amount: number
      notes: string | undefined
      cleared: boolean | undefined
      payee_name: string
      account: string
      imported_id: string
      date: string
    }

export const run = Effect.fnUntraced(function* (options: {
  readonly accounts: ReadonlyArray<{
    readonly bankAccountId: string
    readonly actualAccountId: string
  }>
  readonly categorize: boolean
  readonly categoryMapping?: ReadonlyArray<{
    readonly bankCategory: string
    readonly actualCategory: string
  }>
  readonly syncDuration: Duration.Duration
  readonly clearedOnly: boolean
}) {
  const actual = yield* Actual
  const categories = yield* actual.use((_) => _.getCategories())
  const payees = yield* actual.use((_) => _.getPayees())

  const results = yield* runCollect({
    ...options,
    categories,
    payees,
  })

  // Pre-collect alreadyImported for all accounts before any updates or imports
  const allAlreadyImported = yield* Effect.forEach(
    results,
    ({ ids, actualAccountId }) =>
      actual
        .findImported(ids, actualAccountId)
        .pipe(Effect.map((imported) => ({ actualAccountId, imported }))),
  )

  // Pass 1: apply all updates (cleared + payee name + transfer payee correction)
  const allUpdates = Array.empty<Fiber.Fiber<unknown, ActualError>>()
  for (const { transactions, actualAccountId } of results) {
    const { imported: alreadyImported } = allAlreadyImported.find(
      (r) => r.actualAccountId === actualAccountId,
    )!
    for (const transaction of transactions) {
      if (options.clearedOnly && !transaction.cleared) {
        continue
      }

      const existing = alreadyImported.get(transaction.imported_id)
      if (!existing) {
        continue
      }

      if (transaction.cleared && !existing.cleared) {
        allUpdates.push(
          yield* Effect.forkChild(
            actual.use((_) =>
              _.updateTransaction(existing.id, {
                cleared: true,
                amount: transaction.amount,
                ...(!existing.category && transaction.category
                  ? { category: transaction.category }
                  : {}),
              }),
            ),
          ),
        )

        const existingPayee = payees.find((p) => p.id === existing.payee)
        if (
          existingPayee &&
          "payee_name" in transaction &&
          transaction.payee_name !== existing.imported_payee &&
          existingPayee.name === existing.imported_payee
        ) {
          allUpdates.push(
            yield* Effect.forkChild(
              actual.use((_) =>
                _.updatePayee(existingPayee.id, {
                  name: transaction.payee_name,
                }),
              ),
            ),
          )
        }
      }

      if ("payee" in transaction && existing.payee !== transaction.payee) {
        allUpdates.push(
          yield* Effect.forkChild(
            actual.use((_) =>
              _.updateTransaction(existing.id, {
                payee: transaction.payee,
              }),
            ),
          ),
        )
      }
    }
  }
  yield* Fiber.awaitAll(allUpdates)

  // Pass 2: collect new transactions and import them
  for (const { transactions, actualAccountId } of results) {
    const { imported: alreadyImported } = allAlreadyImported.find(
      (r) => r.actualAccountId === actualAccountId,
    )!
    let toImport: typeof transactions = []
    for (const transaction of transactions) {
      if (options.clearedOnly && !transaction.cleared) {
        continue
      }

      const existing = alreadyImported.get(transaction.imported_id)
      if (!existing) {
        toImport.push(transaction)
      }
    }
    yield* actual.use((_) => _.importTransactions(actualAccountId, toImport))
  }
}, Effect.scoped)

const makeImportId = () => {
  const counters = new Map<string, number>()
  return (accountId: string, self: AccountTransaction) => {
    if (self.externalId !== undefined) return self.externalId
    const dateParts = DateTime.toParts(self.dateTime)
    const dateString = `${dateParts.year.toString().padStart(4, "0")}${dateParts.month.toString().padStart(2, "0")}${dateParts.day.toString().padStart(2, "0")}`
    const amountInt = amountToInt(self.amount)
    const prefix = `${dateString}${amountInt}`
    const key = `${accountId}:${prefix}`
    const count = counters.has(key) ? counters.get(key)! + 1 : 1
    counters.set(key, count)
    return `${prefix}-${count}`
  }
}

export const testCategories = [
  { id: "1", name: "Transport" },
  { id: "2", name: "Groceries" },
  { id: "3", name: "Internet" },
  { id: "4", name: "Rent" },
]

export const testPayees = [
  { id: "1", name: "Acme" },
  { id: "2", name: "Bobs" },
  { id: "3", name: "Cafe" },
  { id: "4", name: "Deli" },
  { id: "5", name: "Verizon" },
  { id: "6", name: "Checking", transfer_acct: "actual-checking" },
  { id: "7", name: "Savings", transfer_acct: "actual-savings" },
]

export const runTest = Effect.fnUntraced(function* (options: {
  readonly categorize: boolean
  readonly categoryMapping?: ReadonlyArray<{
    readonly bankCategory: string
    readonly actualCategory: string
  }>
}) {
  const results = yield* runCollect({
    ...options,
    accounts: [
      {
        bankAccountId: "checking",
        actualAccountId: "actual-checking",
      },
      {
        bankAccountId: "savings",
        actualAccountId: "actual-savings",
      },
    ],
    categories: testCategories,
    payees: testPayees,
    syncDuration: Duration.days(30),
  })
  return results.flatMap((account) =>
    account.transactions.map((transaction) => ({
      ...transaction,
      account: account.actualAccountId,
    })),
  )
})
