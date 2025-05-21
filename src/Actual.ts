/**
 * @since 1.0.0
 */
import { Array, Config, Data, Effect, Redacted, Schema } from "effect"
import * as Api from "@actual-app/api"
import * as ApiPackage from "@actual-app/api/package.json"
import { configProviderNested } from "./internal/utils.js"
import { HttpClient, HttpClientResponse } from "@effect/platform"
import { Npm } from "./Npm.js"
import { NodeHttpClient } from "@effect/platform-node"

export type Query = ReturnType<typeof Api.q>

export class ActualError extends Data.TaggedError("ActualError")<{
  readonly cause: unknown
}> {}

export class Actual extends Effect.Service<Actual>()("Actual", {
  dependencies: [NodeHttpClient.layerUndici, Npm.Default],
  scoped: Effect.gen(function* () {
    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
    )
    const npm = yield* Npm
    const dataDir = yield* Config.string("data").pipe(
      Config.withDefault("data"),
    )
    const server = yield* Config.string("server")
    const password = yield* Config.redacted("password")
    const syncId = yield* Config.string("syncId")

    const serverVersion = httpClient.get(`${server}info`).pipe(
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
      Effect.tapErrorCause(Effect.logWarning),
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
          serverURL: server,
          password: Redacted.value(password),
        }),
      ),
      () => Effect.promise(() => api.shutdown()),
    )

    const sync = Effect.promise(() => api.sync())

    yield* use((_) => _.downloadBudget(syncId))
    yield* Effect.addFinalizer(() => sync)
    yield* sync

    const query = <A>(f: (q: (typeof Api)["q"]) => Query) =>
      use(({ runQuery, q }) => runQuery(f(q))).pipe(
        Effect.map((result: any) => result.data as ReadonlyArray<A>),
      )

    const findImportedIds = (importedIds: ReadonlyArray<string>) =>
      importedIds.length === 0
        ? Effect.succeed([])
        : query<{ imported_id: string }>((q) =>
            q("transactions")
              .select(["*"])
              .filter({
                $or: importedIds.map((imported_id) => ({ imported_id })),
              })
              .withDead(),
          ).pipe(Effect.map(Array.map((row) => row.imported_id)))

    return { use, query, findImportedIds } as const
  }).pipe(Effect.withConfigProvider(configProviderNested("actual"))),
}) {}
