import {
  Chunk,
  Config,
  DateTime,
  Effect,
  flow,
  identity,
  Layer,
  Option,
  pipe,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from "effect"
import { configProviderNested } from "../internal/utils.js"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { AccountTransaction, Bank, BankError } from "../Bank.js"

export const AkahuLive = Effect.gen(function* () {
  const appToken = yield* Config.redacted("appToken")
  const userToken = yield* Config.redacted("userToken")
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      flow(
        HttpClientRequest.prependUrl("https://api.akahu.io/v1"),
        HttpClientRequest.setHeader("X-Akahu-Id", Redacted.value(appToken)),
        HttpClientRequest.bearerToken(Redacted.value(userToken)),
        HttpClientRequest.acceptJson,
      ),
    ),
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({
      schedule: Schedule.exponential(500),
      times: 5,
    }),
    HttpClient.transformResponse(Effect.orDie),
  )
  const timeZone = yield* DateTime.zoneMakeNamed("Pacific/Auckland")

  const stream = <S extends Schema.Schema.Any>(schema: S) => {
    const Page = PaginatedResponse(schema)
    return (request: HttpClientRequest.HttpClientRequest) => {
      const getPage = (cursor: string | null) =>
        pipe(
          request,
          cursor ? HttpClientRequest.setUrlParam("cursor", cursor) : identity,
          client.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Page)),
          Effect.scoped,
          Effect.orDie,
        )

      return Stream.paginateChunkEffect(null, (cursor: string | null) =>
        getPage(cursor).pipe(
          Effect.map(
            ({ items, cursor }) =>
              [items, Option.fromNullable(cursor?.next)] as const,
          ),
        ),
      )
    }
  }

  const refresh = client.post("/refresh").pipe(Effect.asVoid, Effect.scoped)
  const accounts = stream(Account)(HttpClientRequest.get("/accounts"))
  const pendingTransactions = stream(PendingTransaction)
  const transactions = stream(Transaction)
  const lastRefreshed = accounts.pipe(
    Stream.map((account) => account.refreshed.transactions),
    Stream.runHead,
    Effect.flatten,
    Effect.orDie,
  )

  const accountTransactions = (accountId: string) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now
      const lastMonth = now.pipe(DateTime.subtract({ days: 30 }))
      const last30Days = yield* pendingTransactions(
        HttpClientRequest.get(`/accounts/${accountId}/transactions/pending`, {
          urlParams: { start: DateTime.formatIso(lastMonth) },
        }),
      ).pipe(
        Stream.merge(
          transactions(
            HttpClientRequest.get(`/accounts/${accountId}/transactions`, {
              urlParams: { start: DateTime.formatIso(lastMonth) },
            }),
          ),
        ),
        Stream.runCollect,
      )
      return last30Days.pipe(
        Chunk.map((t) => t.accountTransaction(timeZone)),
        Chunk.toReadonlyArray,
      )
    })

  yield* Effect.log("Refreshing Akahu transactions")
  const beforeRefresh = yield* lastRefreshed
  yield* refresh

  yield* lastRefreshed.pipe(
    Effect.flatMap((refreshed) =>
      DateTime.greaterThan(refreshed, beforeRefresh)
        ? Effect.void
        : new BankError({
            reason: "Unknown",
            bank: "Akahu",
            cause: new Error("Refresh did not update transactions"),
          }),
    ),
    Effect.retry({
      times: 5,
      schedule: Schedule.exponential(500),
    }),
    Effect.catchAllCause(Effect.log),
  )

  return Bank.of({
    exportAccount(accountId) {
      return accountTransactions(accountId)
    },
  })
}).pipe(
  Effect.withConfigProvider(configProviderNested("akahu")),
  Effect.annotateLogs({ service: "Bank/Akahu" }),
  Layer.effect(Bank),
  Layer.provide(NodeHttpClient.layerUndici),
)

export class Merchant extends Schema.Class<Merchant>("Merchant")({
  name: Schema.String,
}) {}

export class Category extends Schema.Class<Category>("Category")({
  _id: Schema.String,
  name: Schema.String,
}) {}

export const ConnectionId = Schema.String.pipe(Schema.brand("ConnectionId"))
export const AccountId = Schema.String.pipe(Schema.brand("AccountId"))
export const UserId = Schema.String.pipe(Schema.brand("UserId"))

export class Transaction extends Schema.Class<Transaction>("Transaction")({
  _id: Schema.String,
  _account: AccountId,
  _user: UserId,
  _connection: ConnectionId,
  date: Schema.DateTimeUtc,
  description: Schema.String,
  amount: Schema.BigDecimalFromNumber,
  merchant: Schema.optional(Merchant),
}) {
  accountTransaction(timeZone: DateTime.TimeZone): AccountTransaction {
    return {
      dateTime: this.date.pipe(DateTime.setZone(timeZone)),
      amount: this.amount,
      payee: this.merchant?.name ?? this.description,
      notes: this.description,
      cleared: true,
    }
  }
}

export class Cursor extends Schema.Class<Cursor>("Cursor")({
  next: Schema.NullOr(Schema.String),
}) {}

export class PendingTransaction extends Schema.Class<PendingTransaction>(
  "PendingTransaction",
)({
  _user: UserId,
  _account: AccountId,
  _connection: ConnectionId,
  date: Schema.DateTimeUtc,
  description: Schema.String,
  amount: Schema.BigDecimal,
}) {
  accountTransaction(timeZone: DateTime.TimeZone): AccountTransaction {
    return {
      dateTime: this.date.pipe(DateTime.setZone(timeZone)),
      amount: this.amount,
      payee: this.description,
      cleared: false,
    }
  }
}

export class Refreshed extends Schema.Class<Refreshed>("Refreshed")({
  meta: Schema.DateTimeUtc,
  transactions: Schema.DateTimeUtc,
  party: Schema.DateTimeUtc,
}) {}

export class Account extends Schema.Class<Account>("AccountElement")({
  _id: AccountId,
  name: Schema.String,
  refreshed: Refreshed,
}) {}

export const PaginatedResponse = <S extends Schema.Schema.Any>(schema: S) =>
  Schema.Struct({
    success: Schema.Boolean,
    items: Schema.Chunk(schema),
    cursor: Schema.optional(Cursor),
  })
