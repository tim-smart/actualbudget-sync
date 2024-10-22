import {
  BigDecimal,
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
import { AccountTransaction, Bank } from "../Bank.js"

const URL = "https://api.up.com.au/api/v1"

export const UpBankLive = Effect.gen(function* () {
  const userToken = yield* Config.redacted("userToken")
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      flow(
        HttpClientRequest.prependUrl(URL),
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

  const stream = <S extends Schema.Schema.Any>(schema: S) => {
    const Page = PaginatedResponse(schema)
    return (request: HttpClientRequest.HttpClientRequest) => {
      const getPage = (cursor: string | null) =>
        pipe(
          request,
          cursor ? HttpClientRequest.setUrl(cursor.split(URL)[1]) : identity,
          client.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Page)),
          Effect.scoped,
          Effect.orDie,
        )

      return Stream.paginateChunkEffect(null, (cursor: string | null) =>
        getPage(cursor).pipe(
          Effect.map(
            ({ data, links }) =>
              [data, Option.fromNullable(links.next)] as const,
          ),
        ),
      )
    }
  }

  const transactions = stream(Transaction)

  const accountTransactions = (accountId: string) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now
      const lastMonth = now.pipe(DateTime.subtract({ days: 30 }))
      const last30Days = yield* transactions(
        HttpClientRequest.get(`/accounts/${accountId}/transactions`, {
          urlParams: { "filter[since]": DateTime.formatIso(lastMonth) },
        }),
      ).pipe(Stream.runCollect)
      return last30Days.pipe(
        Chunk.map((t) => t.accountTransaction()),
        Chunk.toReadonlyArray,
      )
    })

  return Bank.of({
    exportAccount(accountId) {
      return accountTransactions(accountId)
    },
  })
}).pipe(
  Effect.withConfigProvider(configProviderNested("up")),
  Effect.annotateLogs({ service: "Bank/Up" }),
  Layer.effect(Bank),
  Layer.provide(NodeHttpClient.layerUndici),
)

class MoneyObject extends Schema.Class<MoneyObject>("MoneyObject")({
  valueInBaseUnits: Schema.BigDecimalFromNumber,
}) {}

class Transaction extends Schema.Class<Transaction>("Transaction")({
  type: Schema.Literal("transactions"),
  attributes: Schema.Struct({
    status: Schema.Literal("HELD", "SETTLED"),
    description: Schema.String,
    amount: MoneyObject,
    createdAt: Schema.DateTimeZoned,
    note: Schema.NullOr(Schema.Struct({ text: Schema.String })),
  }),
}) {
  accountTransaction(): AccountTransaction {
    return {
      dateTime: this.attributes.createdAt,
      amount: BigDecimal.unsafeDivide(
        this.attributes.amount.valueInBaseUnits,
        BigDecimal.fromNumber(100),
      ),
      payee: this.attributes.description,
      notes: this.attributes.note?.text,
      cleared: this.attributes.status === "SETTLED",
    }
  }
}

class Cursor extends Schema.Class<Cursor>("Cursor")({
  prev: Schema.NullOr(Schema.String),
  next: Schema.NullOr(Schema.String),
}) {}

const PaginatedResponse = <S extends Schema.Schema.Any>(schema: S) =>
  Schema.Struct({
    data: Schema.Chunk(schema),
    links: Cursor,
  })
