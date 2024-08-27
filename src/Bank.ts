/**
 * @since 1.0.0
 */
import { BigDecimal, Context, Data, DateTime, Effect } from "effect"

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
  readonly id?: string
  readonly dateTime: DateTime.DateTime
  readonly amount: BigDecimal.BigDecimal
  readonly payee: string
  readonly notes?: string
  readonly cleared?: boolean
}
