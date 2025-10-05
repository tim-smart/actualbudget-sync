/**
 * @since 1.0.0
 */
import { BigDecimal, DateTime, Effect, ServiceMap } from "effect"
import { Data, Order } from "effect/data"

export class BankError extends Data.TaggedError("BankError")<{
  readonly reason: "AccountNotFound" | "Unauthorized" | "Unknown"
  readonly bank: string
  readonly cause?: unknown
}> {}

export class Bank extends ServiceMap.Key<
  Bank,
  {
    readonly exportAccount: (
      accountId: string,
    ) => Effect.Effect<ReadonlyArray<AccountTransaction>, BankError>
  }
>()("Bank") {}

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
