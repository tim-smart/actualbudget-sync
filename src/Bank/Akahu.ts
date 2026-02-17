import {
  Array,
  Brand,
  Config,
  DateTime,
  Effect,
  flow,
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
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/unstable/httpapi"
import { BigDecimalFromNumber } from "../Schema.ts"
import { NodeHttpClient } from "@effect/platform-node"

export class Akahu extends ServiceMap.Service<Akahu>()("Bank/Akahu", {
  make: Effect.gen(function* () {
    const appToken = yield* Config.redacted("AKAHU_APP_TOKEN")
    const userToken = yield* Config.redacted("AKAHU_USER_TOKEN")
    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        flow(
          HttpClientRequest.prependUrl("https://api.akahu.io/v1"),
          HttpClientRequest.setHeader("X-Akahu-Id", Redacted.value(appToken)),
          HttpClientRequest.bearerToken(Redacted.value(userToken)),
        ),
      ),
      HttpClient.retryTransient({
        schedule: Schedule.exponential(100, 1.5),
        times: 5,
      }),
    )
    const client = yield* HttpApiClient.makeWith(AkahuApi, { httpClient })

    const stream = <A, E, R>(
      f: (
        cursor: string | undefined,
      ) => Effect.Effect<PaginatedResponse<A>, E, R>,
    ) =>
      Stream.paginate(undefined as string | undefined, (cursor) =>
        f(cursor).pipe(
          Effect.map(({ items, cursor }) => [
            items,
            Option.fromNullishOr(cursor?.next),
          ]),
        ),
      )

    const refresh = client.transactions.refresh()
    const accounts = stream((cursor) =>
      client.accounts.list({ query: { cursor } }),
    )
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
      accountId: typeof AccountId.Type,
    ) {
      const now = yield* DateTime.now
      const lastMonth = now.pipe(DateTime.subtract({ days: 30 }))
      return stream((cursor) =>
        client.transactions.pending({
          params: { accountId },
          query: {
            start: lastMonth,
            amount_as_number: "true",
            cursor,
          },
        }),
      ).pipe(
        Stream.merge(
          stream((cursor) =>
            client.transactions.list({
              params: { accountId },
              query: {
                start: lastMonth,
                cursor,
              },
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
  const timeZone = (yield* Effect.serviceOption(DateTime.CurrentTimeZone)).pipe(
    Option.getOrElse(() => DateTime.zoneMakeNamedUnsafe("Pacific/Auckland")),
  )

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
        akahu.transactions(AccountId.makeUnsafe(accountId)),
        Stream.runCollect,
        Effect.map(Array.map((t) => t.accountTransaction(timeZone))),
        Effect.mapError(
          (cause) =>
            new BankError({
              reason: "Unknown",
              bank: "Akahu",
              cause,
            }),
        ),
      ),
  })
}).pipe(Effect.annotateLogs({ service: "Bank/Akahu" }), Layer.effect(Bank))

export const AkahuLive = AkahuLayer.pipe(Layer.provide(Akahu.layer))

// ---- Schema ----

class Merchant extends Schema.Class<Merchant>("Merchant")({
  name: Schema.String,
}) {}

class Category extends Schema.Class<Category>("Category")({
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
  date: Schema.DateTimeUtcFromString,
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

class Cursor extends Schema.Class<Cursor>("Cursor")({
  next: Schema.NullOr(Schema.String),
}) {}

export class PendingTransaction extends Schema.Class<PendingTransaction>(
  "PendingTransaction",
)({
  _user: UserId,
  _account: AccountId,
  _connection: ConnectionId,
  date: Schema.DateTimeUtcFromString,
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

const OptionalDateTimeUtc = Schema.optional(Schema.DateTimeUtcFromString).pipe(
  Schema.decodeTo(Schema.DateTimeUtc, {
    decode: SchemaGetter.withDefault(DateTime.nowUnsafe),
    encode: SchemaGetter.passthrough(),
  }),
)

class Refreshed extends Schema.Class<Refreshed>("Refreshed")({
  meta: Schema.DateTimeUtcFromString,
  transactions: OptionalDateTimeUtc,
  party: OptionalDateTimeUtc,
}) {}

class Account extends Schema.Class<Account>("AccountElement")({
  _id: AccountId,
  name: Schema.String,
  refreshed: Refreshed,
}) {}

interface PaginatedResponse<A> {
  readonly success: boolean
  readonly items: ReadonlyArray<A>
  readonly cursor?: Cursor | undefined
}

const PaginatedResponse = <S extends Schema.Top>(schema: S) =>
  Schema.Struct({
    success: Schema.Boolean,
    items: Schema.Array(schema),
    cursor: Schema.optional(Cursor),
  })

const AkahuApi = HttpApi.make("akahu").add(
  HttpApiGroup.make("transactions").add(
    HttpApiEndpoint.get("list", "/accounts/:accountId/transactions", {
      params: {
        accountId: AccountId,
      },
      query: {
        start: Schema.DateTimeUtcFromString,
        cursor: Schema.optional(Schema.String),
      },
      success: PaginatedResponse(Transaction),
    }),
    HttpApiEndpoint.get(
      "pending",
      "/accounts/:accountId/transactions/pending",
      {
        params: {
          accountId: AccountId,
        },
        query: {
          start: Schema.DateTimeUtcFromString,
          amount_as_number: Schema.Literal("true"),
          cursor: Schema.optional(Schema.String),
        },
        success: PaginatedResponse(PendingTransaction),
      },
    ),
    HttpApiEndpoint.post("refresh", "/refresh", {
      success: Schema.Void.annotate({
        httpApiStatus: 200,
      }),
    }),
  ),
  HttpApiGroup.make("accounts").add(
    HttpApiEndpoint.get("list", "/accounts", {
      query: {
        cursor: Schema.optional(Schema.String),
      },
      success: PaginatedResponse(Account),
    }),
  ),
)
