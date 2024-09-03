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
  Stream,
} from "effect"
import { configProviderNested } from "../internal/utils.js"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import * as S from "@effect/schema/Schema"
import { AccountTransaction, Bank } from "../Bank.js"

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
    HttpClient.retry({
      while: (err) =>
        err._tag === "ResponseError" && err.response.status >= 429,
      schedule: Schedule.exponential(500),
      times: 5,
    }),
    HttpClient.transformResponse(Effect.orDie),
  )
  const timeZone = yield* DateTime.zoneMakeNamed("Pacific/Auckland")

  const stream = <S extends S.Schema.Any>(schema: S) => {
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

  const refresh = client.get("/refresh").pipe(Effect.asVoid, Effect.scoped)

  const pendingTransactions = stream(PendingTransaction)
  const transactions = stream(Transaction)

  const accountTransactions = (accountId: string) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now
      const start = now.pipe(DateTime.subtract({ days: 30 }))

      yield* refresh

      const last30Days = yield* pendingTransactions(
        HttpClientRequest.get(`/accounts/${accountId}/transactions/pending`, {
          urlParams: { start: DateTime.formatIso(start) },
        }),
      ).pipe(
        Stream.merge(
          transactions(
            HttpClientRequest.get(`/accounts/${accountId}/transactions`, {
              urlParams: { start: DateTime.formatIso(start) },
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

  return Bank.of({
    exportAccount(accountId) {
      return accountTransactions(accountId)
    },
  })
}).pipe(
  Effect.withConfigProvider(configProviderNested("akahu")),
  Layer.effect(Bank),
  Layer.provide(NodeHttpClient.layerUndici),
)

export class Meta extends S.Class<Meta>("Meta")({
  particulars: S.optional(S.Union(S.Null, S.String)),
  code: S.String,
  logo: S.optional(S.String),
  other_account: S.optional(S.String),
  reference: S.optional(S.String),
}) {}

export class Merchant extends S.Class<Merchant>("Merchant")({
  _id: S.String,
  name: S.String,
  website: S.optional(S.String),
  nzbn: S.optional(S.String),
}) {}

export class PersonalFinance extends S.Class<PersonalFinance>(
  "PersonalFinance",
)({
  _id: S.String,
  name: S.String,
}) {}

export class Groups extends S.Class<Groups>("Groups")({
  personal_finance: PersonalFinance,
}) {}

export class Category extends S.Class<Category>("Category")({
  _id: S.String,
  name: S.String,
  groups: Groups,
}) {}

export const ConnectionId = S.String.pipe(S.brand("ConnectionId"))
export const AccountId = S.String.pipe(S.brand("AccountId"))
export const UserId = S.String.pipe(S.brand("UserId"))

export class Transaction extends S.Class<Transaction>("Transaction")({
  _id: S.String,
  _account: AccountId,
  _user: UserId,
  _connection: ConnectionId,
  created_at: S.DateTimeUtc,
  updated_at: S.DateTimeUtc,
  date: S.DateTimeUtc,
  description: S.String,
  amount: S.BigDecimalFromNumber,
  balance: S.BigDecimalFromNumber,
  type: S.String,
  hash: S.String,
  meta: Meta,
  merchant: S.optional(Merchant),
  category: S.optional(Category),
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

export class Cursor extends S.Class<Cursor>("Cursor")({
  next: S.NullOr(S.String),
}) {}

export class PendingTransaction extends S.Class<PendingTransaction>(
  "PendingTransaction",
)({
  _user: UserId,
  _account: AccountId,
  _connection: ConnectionId,
  date: S.DateTimeUtc,
  description: S.String,
  amount: S.BigDecimal,
  type: S.String,
  updated_at: S.DateTimeUtc,
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

export const PaginatedResponse = <S extends S.Schema.Any>(schema: S) =>
  S.Struct({
    success: S.Boolean,
    items: S.Chunk(schema),
    cursor: S.optional(Cursor),
  })