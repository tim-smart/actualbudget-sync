/**
 * @since 1.0.0
 */
import { Config, Data, Effect, Layer, ServiceMap } from "effect"
import * as Api from "playwright"

export class PlaywrightError extends Data.TaggedError("PlaywrightError")<{
  readonly cause: unknown
}> {}

export class Browser extends ServiceMap.Service<Browser, Api.Browser>()(
  "Playwright/Browser",
) {
  static readonly layerChromium = (options?: Api.LaunchOptions) =>
    Layer.effect(this)(
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => Api.chromium.launch(options),
          catch: (cause) => new PlaywrightError({ cause }),
        }),
        (browser) => Effect.promise(() => browser.close()),
      ),
    )

  static Live = Layer.unwrap(
    Effect.gen(this, function* () {
      const isProd = yield* Config.string("NODE_ENV").pipe(
        Config.map((env) => env === "production"),
        Config.withDefault(() => false),
      )

      return this.layerChromium({
        headless: isProd,
        args: isProd ? ["--no-sandbox"] : [],
      })
    }),
  )
}

export class BrowserContext extends ServiceMap.Service<
  BrowserContext,
  Api.BrowserContext
>()("Playwright/BrowserContext") {
  static layer = (options?: Api.BrowserContextOptions) =>
    Layer.effect(this)(
      Effect.flatMap(Browser.asEffect(), (browser) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: () => browser.newContext(options),
            catch: (cause) => new PlaywrightError({ cause }),
          }),
          (context) => Effect.promise(() => context.close()),
        ),
      ),
    )

  static Live = this.layer().pipe(Layer.provide(Browser.Live))
}

export class Page extends ServiceMap.Service<Page, Api.Page>()(
  "Playwright/Page",
) {
  static layer = Layer.effect(this)(
    Effect.flatMap(BrowserContext.asEffect(), (context) =>
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => context.newPage(),
          catch: (cause) => new PlaywrightError({ cause }),
        }),
        (page) => Effect.promise(() => page.close()),
      ),
    ),
  )

  static Live = this.layer.pipe(Layer.provide(BrowserContext.Live))
}
