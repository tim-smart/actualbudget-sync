/**
 * @since 1.0.0
 */
import {
  Array,
  Config,
  Data,
  Effect,
  Layer,
  Redacted,
  Schema,
  ServiceMap,
} from "effect"
import * as Api from "@actual-app/api"
import ApiPackage from "@actual-app/api/package.json" with { type: "json" }
import { Npm } from "./Npm.ts"
import { NodeHttpClient } from "@effect/platform-node"
import { TransactionEntity } from "@actual-app/api/@types/loot-core/src/types/models/transaction.js"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

export type Query = ReturnType<typeof Api.q>

export class ActualError extends Data.TaggedError("ActualError")<{
  readonly cause: unknown
}> {}

export class Actual extends ServiceMap.Service<Actual>()("Actual", {
  make: Effect.gen(function* () {
    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
    )
    const npm = yield* Npm
    const dataDir = yield* Config.string("ACTUAL_DATA").pipe(
      Config.withDefault(() => "data"),
    )
    const server = yield* Config.url("ACTUAL_SERVER")
    const password = yield* Config.redacted("ACTUAL_PASSWORD")
    const encryptionPassword = yield* Config.string(
      "ACTUAL_ENCRYPTION_PASSWORD",
    ).pipe(Config.withDefault(() => undefined))
    const syncId = yield* Config.string("ACTUAL_SYNC_ID")

    if (!server.pathname.endsWith("/")) {
      server.pathname += "/"
    }

    const serverVersion = httpClient.get(`${server.toString()}info`).pipe(
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(
          Schema.Struct({
            build: Schema.Struct({
              version: Schema.String,
            }),
          }),
        ),
      ),
      Effect.map((_) => _.build.version),
    )

    const api = yield* Effect.gen(function* () {
      const version = yield* serverVersion
      if (version === ApiPackage.version) {
        return Api
      }
      yield* Effect.logInfo(
        "Actual API version mismatch. Attempting to update.",
      ).pipe(
        Effect.annotateLogs({
          serverVersion: version,
          localVersion: ApiPackage.version,
        }),
      )
      const name = yield* npm.install({
        packageName: "@actual-app/api",
        version,
      })
      return yield* Effect.promise(() => import(name) as Promise<typeof Api>)
    }).pipe(
      Effect.tapCause(Effect.logWarning),
      Effect.orElseSucceed(() => Api),
      Effect.annotateLogs({
        module: "Actual",
        method: "getApi",
      }),
    )

    const use = <A>(
      f: (api: typeof Api) => Promise<A>,
    ): Effect.Effect<A, ActualError> =>
      Effect.tryPromise({
        try: () => f(api),
        catch: (cause) => new ActualError({ cause }),
      })

    yield* Effect.acquireRelease(
      use((_) =>
        _.init({
          dataDir,
          serverURL: server.toString(),
          password: Redacted.value(password),
        }),
      ),
      () => Effect.promise(() => api.shutdown()),
    )

    const sync = Effect.promise(() => api.sync())

    yield* use((_) =>
      _.downloadBudget(
        syncId,
        encryptionPassword ? { password: encryptionPassword } : {},
      ),
    )
    yield* Effect.addFinalizer(() => sync)
    yield* sync

    const query = <A>(f: (q: (typeof Api)["q"]) => Query) =>
      use(({ aqlQuery, q }) => aqlQuery(f(q))).pipe(
        // oxlint-disable-next-line typescript/no-explicit-any
        Effect.map((result: any) => result.data as ReadonlyArray<A>),
      )

    const findImported = (importedIds: ReadonlyArray<string>) =>
      importedIds.length === 0
        ? Effect.succeed(new Map<never, never>())
        : query<TransactionEntity>((q) =>
            q("transactions")
              .select(["*"])
              .filter({
                $or: importedIds.map((imported_id) => ({ imported_id })),
              })
              .withDead(),
          ).pipe(
            Effect.map(
              Array.reduce(
                new Map<string, TransactionEntity>(),
                (acc, item) => {
                  acc.set(item.imported_id!, item)
                  return acc
                },
              ),
            ),
          )

    return { use, query, findImported } as const
  }),
}) {
  static layer = Layer.effect(this)(this.make).pipe(
    Layer.provide([NodeHttpClient.layerUndici, Npm.layer]),
  )
}
