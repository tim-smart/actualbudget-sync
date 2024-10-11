/**
 * @since 1.0.0
 */
import { Array, Config, Data, Effect, Redacted } from "effect"
import * as Api from "@actual-app/api"
import { configProviderNested } from "./internal/utils.js"

export type Query = ReturnType<typeof Api.q>

export class ActualError extends Data.TaggedError("ActualError")<{
  readonly cause: unknown
}> {}

export class Actual extends Effect.Service<Actual>()("Actual", {
  scoped: Effect.gen(function* () {
    const dataDir = yield* Config.string("data").pipe(
      Config.withDefault("data"),
    )
    const server = yield* Config.string("server")
    const password = yield* Config.redacted("password")
    const syncId = yield* Config.string("syncId")

    const use = <A>(
      f: (api: typeof Api) => Promise<A>,
    ): Effect.Effect<A, ActualError> =>
      Effect.tryPromise({
        try: () => f(Api),
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
      () => Effect.promise(() => Api.shutdown()),
    )

    const sync = Effect.promise(() => Api.sync())

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
