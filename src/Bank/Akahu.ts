import {
  Array,
  Brand,
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
  SchemaGetter,
  ServiceMap,
  Stream,
} from "effect"
import { AccountTransaction, Bank, BankError } from "../Bank.ts"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { BigDecimalFromNumber } from "../Schema.ts"
import { NodeHttpClient } from "@effect/platform-node"

export class Akahu extends ServiceMap.Service<Akahu>()("Bank/Akahu", {
  make: Effect.gen(function* () {
    const appToken = yield* Config.redacted("AKAHU_APP_TOKEN")
    const userToken = yield* Config.redacted("AKAHU_USER_TOKEN")
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

    const stream = <S extends Schema.Top>(schema: S) => {
      const Page = PaginatedResponse(schema)
      return (request: HttpClientRequest.HttpClientRequest) => {
        const getPage = (cursor: string) =>
          pipe(
            request,
            cursor ? HttpClientRequest.setUrlParam("cursor", cursor) : identity,
            client.execute,
            Effect.flatMap(HttpClientResponse.schemaBodyJson(Page)),
            Effect.orDie,
          )

        return Stream.paginate("", (cursor: string) =>
          getPage(cursor).pipe(
            Effect.map(
              ({ items, cursor }) =>
                [items, Option.fromNullishOr(cursor?.next)] as const,
            ),
          ),
        )
      }
    }

    const refresh = client.post("/refresh").pipe(Effect.asVoid)
    const accounts = stream(Account)(HttpClientRequest.get("/accounts"))
    const pendingTransactions = stream(PendingTransaction)
    const transactions = stream(Transaction)
    const lastRefreshed = accounts.pipe(
      Stream.map((account) => account.refreshed.transactions),
      Stream.runFold(Option.none<DateTime.Utc>, (acc, curr) =>
        Option.match(acc, {
          onNone: () => Option.some(curr),
          onSome: (dt) => Option.some(DateTime.min(dt, curr)),
        }),
      ),
      Effect.flatMap(Effect.fromYieldable),
      Effect.orDie,
    )

    const accountTransactions = Effect.fnUntraced(function* (
      accountId: string,
    ) {
      const now = yield* DateTime.now
      const lastMonth = now.pipe(DateTime.subtract({ days: 30 }))
      return pendingTransactions(
        HttpClientRequest.get(`/accounts/${accountId}/transactions/pending`, {
          urlParams: {
            start: DateTime.formatIso(lastMonth),
            amount_as_number: true,
          },
        }),
      ).pipe(
        Stream.merge(
          transactions(
            HttpClientRequest.get(`/accounts/${accountId}/transactions`, {
              urlParams: { start: DateTime.formatIso(lastMonth) },
            }),
          ),
        ),
      )
    }, Stream.unwrap)

    return {
      transactions: accountTransactions,
      refresh,
      lastRefreshed,
    } as const
  }),
}) {
  static layer = Layer.effect(this)(this.make).pipe(
    Layer.provide(NodeHttpClient.layerUndici),
  )
}

export const AkahuLayer = Effect.gen(function* () {
  const akahu = yield* Akahu
  const timeZone = DateTime.zoneMakeNamedUnsafe("Pacific/Auckland")

  yield* Effect.log("Refreshing Akahu transactions")
  const beforeRefresh = yield* akahu.lastRefreshed
  yield* akahu.refresh

  yield* akahu.lastRefreshed.pipe(
    Effect.flatMap((refreshed) =>
      DateTime.isGreaterThanOrEqualTo(refreshed, beforeRefresh)
        ? Effect.void
        : new BankError({
            reason: "Unknown",
            bank: "Akahu",
            cause: new Error("Refresh did not update transactions"),
          }).asEffect(),
    ),
    Effect.retry({
      times: 5,
      schedule: Schedule.exponential(500),
    }),
    Effect.catchCause(Effect.log),
  )

  return Bank.of({
    exportAccount: (accountId: string) =>
      pipe(
        akahu.transactions(accountId),
        Stream.runCollect,
        Effect.map(Array.map((t) => t.accountTransaction(timeZone))),
      ),
  })
}).pipe(Effect.annotateLogs({ service: "Bank/Akahu" }), (_) =>
  Layer.effect(Bank)(_),
)

export const AkahuLive = AkahuLayer.pipe(Layer.provide(Akahu.layer))

export class Merchant extends Schema.Class<Merchant>("Merchant")({
  name: Schema.String,
}) {}

export class Category extends Schema.Class<Category>("Category")({
  _id: Schema.String,
  name: Schema.String,
}) {}

export const ConnectionId: Schema.refine<
  string & Brand.Brand<"ConnectionId">,
  Schema.String
> = Schema.String.pipe(Schema.brand("ConnectionId"))
export const AccountId = Schema.String.pipe(Schema.brand("AccountId"))
export const UserId = Schema.String.pipe(Schema.brand("UserId"))

export class Transaction extends Schema.Class<Transaction>("Transaction")({
  _id: Schema.String,
  _account: AccountId,
  _user: UserId,
  _connection: ConnectionId,
  date: Schema.DateTimeUtc,
  description: Schema.String,
  amount: BigDecimalFromNumber,
  merchant: Schema.optional(Merchant),
  category: Schema.optional(Category),
}) {
  accountTransaction(timeZone: DateTime.TimeZone): AccountTransaction {
    return {
      dateTime: this.date.pipe(DateTime.setZone(timeZone)),
      amount: this.amount,
      payee: this.merchant?.name ?? this.description,
      category: this.category?.name,
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
  amount: BigDecimalFromNumber,
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

const OptionalDateTimeUtc = Schema.optional(Schema.DateTimeUtc).pipe(
  Schema.decodeTo(Schema.DateTimeUtc, {
    decode: SchemaGetter.withDefault(DateTime.nowUnsafe),
    encode: SchemaGetter.passthrough(),
  }),
)

export class Refreshed extends Schema.Class<Refreshed>("Refreshed")({
  meta: Schema.DateTimeUtc,
  transactions: OptionalDateTimeUtc,
  party: OptionalDateTimeUtc,
}) {}

export class Account extends Schema.Class<Account>("AccountElement")({
  _id: AccountId,
  name: Schema.String,
  refreshed: Refreshed,
}) {}

export const PaginatedResponse = <S extends Schema.Top>(schema: S) =>
  Schema.Struct({
    success: Schema.Boolean,
    items: Schema.Array(schema),
    cursor: Schema.optional(Cursor),
  })
