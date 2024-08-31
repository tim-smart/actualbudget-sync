/**
 * @since 1.0.0
 */
import { Array, BigDecimal, DateTime, Effect, pipe } from "effect"
import { AccountTransaction, AccountTransactionOrder, Bank } from "./Bank.js"
import { Actual } from "./Actual.js"

const bigDecimal100 = BigDecimal.fromNumber(100)
const amountToInt = (amount: BigDecimal.BigDecimal) =>
  amount.pipe(BigDecimal.multiply(bigDecimal100), BigDecimal.unsafeToNumber)

export const run = (
  accounts: ReadonlyArray<{
    readonly bankAccountId: string
    readonly actualAccountId: string
  }>,
) =>
  Effect.gen(function* () {
    const actual = yield* Actual
    const bank = yield* Bank
    const importId = makeImportId()

    yield* Effect.forEach(accounts, ({ bankAccountId, actualAccountId }) =>
      Effect.gen(function* () {
        const transactions = yield* bank.exportAccount(bankAccountId)
        const ids: Array<string> = []
        const forImport = pipe(
          transactions,
          Array.sort(AccountTransactionOrder),
          Array.map((t) => {
            const imported_id = importId(t)
            ids.push(imported_id)
            return {
              imported_id,
              date: DateTime.formatIsoDate(t.dateTime),
              payee_name: t.payee,
              amount: amountToInt(t.amount),
              notes: t.notes,
              cleared: t.cleared,
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
