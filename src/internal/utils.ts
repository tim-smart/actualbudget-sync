import { ConfigProvider } from "effect"

export const configProviderNested = (prefix: string) =>
  ConfigProvider.fromEnv().pipe(
    ConfigProvider.nested(prefix),
    ConfigProvider.constantCase,
  )
