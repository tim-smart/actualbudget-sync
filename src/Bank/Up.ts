import {
  BigDecimal,
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
  Stream,
} from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { AccountTransaction, Bank } from "../Bank.ts"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { BigDecimalFromNumber } from "../Schema.ts"

const baseUrl = "https://api.up.com.au/api/v1"

export const UpBankLive = Effect.gen(function* () {
  const userToken = yield* Config.redacted("UP_USER_TOKEN")
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      flow(
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
      const getPage = (url: string) =>
        pipe(
          request,
          HttpClientRequest.setUrl(url),
          client.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Page)),
          Effect.orDie,
        )

      return Stream.paginate(request.url, (url: string) =>
        getPage(url).pipe(
          Effect.map(
            ({ data, links }) =>
              [data, Option.fromNullishOr(links.next)] as const,
          ),
        ),
      )
    }
  }

  const transactions = stream(Transaction)

  const accountTransactions = Effect.fnUntraced(function* (accountId: string) {
    const now = yield* DateTime.now
    const lastMonth = now.pipe(DateTime.subtract({ days: 30 }))
    const last30Days = yield* transactions(
      HttpClientRequest.get(`${baseUrl}/accounts/${accountId}/transactions`, {
        urlParams: { "filter[since]": DateTime.formatIso(lastMonth) },
      }),
    ).pipe(Stream.runCollect)
    return last30Days.map((t) => t.accountTransaction())
  })

  return Bank.of({
    exportAccount: accountTransactions,
  })
}).pipe(
  Effect.annotateLogs({ service: "Bank/Up" }),
  (_) => Layer.effect(Bank)(_),
  Layer.provide(NodeHttpClient.layerUndici),
)

class MoneyObject extends Schema.Class<MoneyObject>("MoneyObject")({
  valueInBaseUnits: BigDecimalFromNumber,
}) {}

class Transaction extends Schema.Class<Transaction>("Transaction")({
  type: Schema.Literal("transactions"),
  attributes: Schema.Struct({
    status: Schema.Literals(["HELD", "SETTLED"]),
    description: Schema.String,
    amount: MoneyObject,
    createdAt: Schema.DateTimeUtcFromString,
    note: Schema.NullOr(Schema.Struct({ text: Schema.String })),
  }),
  relationships: Schema.Struct({
    category: Schema.Struct({
      data: Schema.NullOr(
        Schema.Struct({
          type: Schema.Literal("categories"),
          id: Schema.String,
        }),
      ),
    }),
    transferAccount: Schema.Struct({
      data: Schema.NullOr(
        Schema.Struct({
          type: Schema.Literal("accounts"),
          id: Schema.String,
        }),
      ),
    }),
  }),
}) {
  accountTransaction(): AccountTransaction {
    return {
      dateTime: this.attributes.createdAt,
      amount: BigDecimal.divideUnsafe(
        this.attributes.amount.valueInBaseUnits,
        BigDecimal.fromNumberUnsafe(100),
      ),
      payee: this.attributes.description,
      notes: this.attributes.note?.text,
      cleared: this.attributes.status === "SETTLED",
      category: this.relationships.category.data?.id,
      transfer: this.relationships.transferAccount.data?.id,
    }
  }
}

class Cursor extends Schema.Class<Cursor>("Cursor")({
  prev: Schema.NullOr(Schema.String),
  next: Schema.NullOr(Schema.String),
}) {}

const PaginatedResponse = <S extends Schema.Top>(schema: S) =>
  Schema.Struct({
    data: Schema.Array(schema),
    links: Cursor,
  })
