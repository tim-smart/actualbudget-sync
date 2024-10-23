/**
 * @since 1.0.0
 */
import { BigDecimal, Context, Data, DateTime, Effect, Order } from "effect"

export class BankError extends Data.TaggedError("BankError")<{
  readonly reason: "AccountNotFound" | "Unauthorized" | "Unknown"
  readonly bank: string
  readonly cause?: unknown
}> {}

export class Bank extends Context.Tag("Bank")<
  Bank,
  {
    readonly exportAccount: (
      accountId: string,
    ) => Effect.Effect<ReadonlyArray<AccountTransaction>, BankError>
  }
>() {}

export interface AccountTransaction {
  readonly dateTime: DateTime.DateTime
  readonly amount: BigDecimal.BigDecimal
  readonly payee: string
  readonly notes?: string
  readonly cleared?: boolean
  readonly category?: string
  readonly transfer?: string
}

export const AccountTransactionOrder = Order.struct({
  dateTime: DateTime.Order,
  amount: BigDecimal.Order,
  payee: Order.string,
})
