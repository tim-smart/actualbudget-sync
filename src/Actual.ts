/**
 * @since 1.0.0
 */
import { Config, Context, Data, Effect, Layer, Redacted } from "effect"
import * as Api from "@actual-app/api"
import { configProviderNested } from "./internal/utils.js"

export class ActualError extends Data.TaggedError("ActualError")<{
  readonly cause: unknown
}> {}

const make = Effect.gen(function* () {
  const dataDir = yield* Config.string("data").pipe(Config.withDefault("data"))
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

  return { use } as const
}).pipe(Effect.withConfigProvider(configProviderNested("actual")))

export class Actual extends Context.Tag("Actual")<
  Actual,
  Effect.Effect.Success<typeof make>
>() {
  static readonly Live = Layer.scoped(this, make)
}
