/**
 * @since 1.0.0
 */
import { Config, Context, Data, Effect, Layer } from "effect"
import * as Api from "playwright"

export class PlaywrightError extends Data.TaggedError("PlaywrightError")<{
  readonly cause: unknown
}> {}

export class Browser extends Context.Tag("Playwright/Browser")<
  Browser,
  Api.Browser
>() {
  static readonly layerChromium = (options?: Api.LaunchOptions) =>
    Layer.scoped(
      this,
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => Api.chromium.launch(options),
          catch: (cause) => new PlaywrightError({ cause }),
        }),
        (browser) => Effect.promise(() => browser.close()),
      ),
    )

  static Live = Layer.unwrapEffect(
    Effect.gen(this, function* () {
      const isProd = yield* Config.string("NODE_ENV").pipe(
        Config.map((env) => env === "production"),
        Config.withDefault(false),
      )

      return this.layerChromium({
        headless: isProd,
        args: isProd ? ["--no-sandbox"] : [],
      })
    }),
  )
}

export class BrowserContext extends Context.Tag("Playwright/BrowserContext")<
  BrowserContext,
  Api.BrowserContext
>() {
  static layer = (options?: Api.BrowserContextOptions) =>
    Layer.scoped(
      this,
      Effect.flatMap(Browser, (browser) =>
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

export class Page extends Context.Tag("Playwright/Page")<Page, Api.Page>() {
  static layer = Layer.scoped(
    this,
    Effect.flatMap(BrowserContext, (context) =>
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
