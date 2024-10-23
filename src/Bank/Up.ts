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

const URL = "https://api.up.com.au/api/v1"

export const UpBank = Effect.gen(function* () {
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

  const stream = <S extends S.Schema.Any>(schema: S) => {
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
          urlParams: { 'filter[since]': DateTime.formatIso(lastMonth) },
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

class MoneyObject extends S.Class<MoneyObject>("MoneyObject")({
  currencyCode: S.String,
  value: S.String,
  valueInBaseUnits: S.BigDecimalFromNumber
}) { }


class Transaction extends S.Class<Transaction>("Transaction")({
  type: S.Literal("transactions"),
  id: S.String,
  attributes: S.Struct({
    status: S.Literal("HELD", "SETTLED"),
    rawText: S.NullOr(S.String),
    description: S.String,
    message: S.NullOr(S.String),
    isCategorizable: S.Boolean,
    holdInfo: S.NullOr(S.Struct({
      amount: MoneyObject,
      foreignAmount: S.NullOr(MoneyObject)
    })),
    roundUp: S.NullOr(S.Struct({
      amount: MoneyObject,
      boostAmount: MoneyObject
    })),
    cashBack: S.NullishOr(S.Struct({
      amount: MoneyObject,
      description: S.String
    })),
    amount: MoneyObject,
    foreignAmount: S.NullOr(MoneyObject),
    cardPurchaseMethod: S.NullOr(S.Struct({
      method: S.Literal("BAR_CODE", "OCR", "CARD_PIN", "CARD_DETAILS", "CARD_ON_FILE", "ECOMMERCE", "MAGNETIC_STRIPE", "CONTACTLESS"),
      cardNumberSuffix: S.NullOr(S.String)
    })),
    settledAt: S.NullOr(S.DateTimeZoned),
    createdAt: S.DateTimeZoned,
    transactionType: S.NullOr(S.String),
    note: S.NullOr(S.Struct({ text: S.String })),
    performingCustomer: S.NullOr(S.Struct({ displayName: S.String })),
  })
}) {
  accountTransaction(): AccountTransaction {
    return {
      dateTime: this.attributes.createdAt,
      amount: BigDecimal.unsafeDivide(this.attributes.amount.valueInBaseUnits, BigDecimal.fromNumber(100)),
      payee: this.attributes.description,
      notes: this.attributes.note?.text,
      cleared: this.attributes.status === "SETTLED",
    }
  }
}

class Cursor extends S.Class<Cursor>("Cursor")({
  prev: S.NullOr(S.String),
  next: S.NullOr(S.String),
}) { }

const PaginatedResponse = <S extends S.Schema.Any>(schema: S) =>
  S.Struct({
    data: S.Chunk(schema),
    links: Cursor,
  })
