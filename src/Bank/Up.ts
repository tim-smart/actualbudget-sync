import {
  Array,
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
import { type AccountTransaction, Bank } from "../Bank.ts"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { BigDecimalFromNumber } from "../Schema.ts"
import type { NonEmptyReadonlyArray } from "effect/Array"
import { RateLimiter } from "effect/unstable/persistence"

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
    HttpClient.withRateLimiter({
      limiter: yield* RateLimiter.RateLimiter,
      window: "1 minute",
      limit: 100,
      key: "bank:up",
    }),
    HttpClient.retryTransient({
      schedule: Schedule.exponential(200),
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

  const accountTransactions = Effect.fnUntraced(function* (
    accountId: string,
    options: { readonly since: DateTime.Utc },
  ) {
    yield* Effect.logInfo("Fetching transactions from Up Bank...")
    let count = 0
    const txs = yield* transactions(
      HttpClientRequest.get(`${baseUrl}/accounts/${accountId}/transactions`, {
        urlParams: {
          "page[size]": 100,
          "filter[since]": DateTime.formatIso(options.since),
        },
      }),
    ).pipe(
      Stream.mapArray(Array.flatMap((t) => t.accountTransactions())),
      Stream.tap(() => {
        count++
        return count % 500 === 0
          ? Effect.logInfo(`Fetched ${count} transactions...`)
          : Effect.void
      }),
      Stream.runCollect,
    )
    yield* Effect.logInfo(
      `Done fetching ${txs.length} transactions from Up Bank`,
    )
    return txs
  })

  return Bank.of({
    exportAccount: accountTransactions,
  })
}).pipe(
  Effect.annotateLogs({ service: "Bank/Up" }),
  Layer.effect(Bank),
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(
    RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
  ),
)

class MoneyObject extends Schema.Class<MoneyObject>("MoneyObject")({
  valueInBaseUnits: BigDecimalFromNumber,
}) {}

const moneyToBigDecimal = (m: MoneyObject) =>
  BigDecimal.divideUnsafe(m.valueInBaseUnits, BigDecimal.fromNumberUnsafe(100))

class Transaction extends Schema.Class<Transaction>("Transaction")({
  id: Schema.String,
  type: Schema.Literal("transactions"),
  attributes: Schema.Struct({
    status: Schema.Literals(["HELD", "SETTLED"]),
    description: Schema.String,
    message: Schema.NullOr(Schema.String),
    amount: MoneyObject,
    settledAt: Schema.NullOr(Schema.DateTimeUtcFromString),
    createdAt: Schema.DateTimeUtcFromString,
    note: Schema.NullOr(Schema.Struct({ text: Schema.String })),
    cashback: Schema.NullOr(
      Schema.Struct({
        description: Schema.String,
        amount: MoneyObject,
      }),
    ),
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
  accountTransactions(): NonEmptyReadonlyArray<AccountTransaction> {
    const dateTime = this.attributes.settledAt ?? this.attributes.createdAt
    const cleared = this.attributes.status === "SETTLED"
    const amount = moneyToBigDecimal(this.attributes.amount)
    const description = this.attributes.description
    const baseNotes =
      this.attributes.note?.text ?? this.attributes.message ?? undefined

    // For Up-specific internal transfers, surface a descriptive note
    const transferId = this.relationships.transferAccount.data?.id
    let notes = baseNotes
    if (transferId !== undefined) {
      if (description === "Round Up") {
        notes = "Round Up"
      } else if (description.startsWith("Cover")) {
        notes = description.replace("from", "-")
      } else if (description.startsWith("Forward")) {
        notes = description.replace("to", "-")
      }
    }

    const base: AccountTransaction = {
      dateTime,
      amount,
      payee: description,
      notes,
      cleared,
      category: this.relationships.category.data?.id,
      transfer: transferId,
    }

    // Perk-up / Happy Hour cashback: emit as a separate incoming transaction
    if (this.attributes.cashback !== null) {
      const cb = this.attributes.cashback
      const cashbackTx: AccountTransaction = {
        dateTime,
        amount: moneyToBigDecimal(cb.amount),
        payee: cb.description,
        notes: baseNotes,
        cleared,
      }
      return [base, cashbackTx]
    }

    return [base]
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
