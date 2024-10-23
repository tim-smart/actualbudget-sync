/**
 * @since 1.0.0
 */
import { Array, BigDecimal, DateTime, Effect, pipe } from "effect"
import { AccountTransaction, AccountTransactionOrder, Bank } from "./Bank.js"
import { Actual } from "./Actual.js"

const bigDecimal100 = BigDecimal.fromNumber(100)
const amountToInt = (amount: BigDecimal.BigDecimal) =>
  amount.pipe(BigDecimal.multiply(bigDecimal100), BigDecimal.unsafeToNumber)

export const run = (options: {
  readonly accounts: ReadonlyArray<{
    readonly bankAccountId: string
    readonly actualAccountId: string
  }>
  readonly categorize: boolean
  readonly categoryMapping?: ReadonlyArray<{
    readonly bankCategory: string
    readonly actualCategory: string
  }>
}) =>
  Effect.gen(function* () {
    const actual = yield* Actual
    const bank = yield* Bank
    const importId = makeImportId()

    const categories = yield* actual.use((_) => _.getCategories())
    const categoryId = (transaction: AccountTransaction) => {
      const categoryName =
        options.categoryMapping?.find(
          (mapping) => mapping.bankCategory === transaction.category,
        )?.actualCategory ?? transaction.category
      const category = categories.find(
        (c) => c.name.toLowerCase() === categoryName?.toLowerCase(),
      )
      return category ? category.id : undefined
    }

    const payees = yield* actual.use((_) => _.getPayees())
    const transferAccountId = (transaction: AccountTransaction) => {
      const transferToAccount = options.accounts.find(
        ({ bankAccountId }) => bankAccountId === transaction.transfer,
      )?.actualAccountId
      return payees.find((it) => it.transfer_acct === transferToAccount)?.id
    }

    yield* Effect.forEach(
      options.accounts,
      ({ bankAccountId, actualAccountId }) =>
        Effect.gen(function* () {
          const transactions = yield* bank.exportAccount(bankAccountId)
          const ids: Array<string> = []
          const forImport = pipe(
            transactions,
            Array.sort(AccountTransactionOrder),
            Array.map((transaction) => {
              const imported_id = importId(transaction)
              const category = options.categorize && categoryId(transaction)
              const transferPayee =
                transaction.transfer && transferAccountId(transaction)

              ids.push(imported_id)

              return {
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
          const alreadyImported = yield* actual.findImportedIds(ids)
          const filtered = forImport.filter(
            (t) => !alreadyImported.includes(t.imported_id),
          )
          yield* actual.use((_) =>
            _.importTransactions(actualAccountId, filtered),
          )
        }),
    )
  })

const makeImportId = () => {
  const counters = new Map<string, number>()
  return (self: AccountTransaction) => {
    const dateParts = DateTime.toParts(self.dateTime)
    const dateString = `${dateParts.year.toString().padStart(4, "0")}${dateParts.month.toString().padStart(2, "0")}${dateParts.day.toString().padStart(2, "0")}`
    const amountInt = amountToInt(self.amount)
    const prefix = `${dateString}${amountInt}`
    const count = counters.has(prefix) ? counters.get(prefix)! + 1 : 1
    counters.set(prefix, count)
    return `${prefix}-${count}`
  }
}
