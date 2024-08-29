/**
 * @since 1.0.0
 */
import { BigDecimal, DateTime, Effect } from "effect"
import { Bank } from "./Bank.js"
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

    yield* Effect.forEach(accounts, ({ bankAccountId, actualAccountId }) =>
      Effect.gen(function* () {
        const transactions = yield* bank.exportAccount(bankAccountId)
        const ids = transactions.flatMap((t) => (t.id ? [t.id] : []))
        const imported = yield* actual.findImportedIds(ids)
        const filtered = transactions.filter(
          (t) => !t.id || !imported.includes(t.id),
        )
        yield* actual.use((_) =>
          _.importTransactions(
            actualAccountId,
            filtered.map((t) => ({
              imported_id: t.id,
              date: DateTime.formatIsoDate(t.dateTime),
              payee_name: t.payee,
              amount: amountToInt(t.amount),
              notes: t.notes,
              cleared: t.cleared,
            })),
          ),
        )
      }),
    )
  })
