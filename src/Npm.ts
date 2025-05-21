import {
  FileSystem,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  Path,
} from "@effect/platform"
import {
  NodeFileSystem,
  NodeHttpClient,
  NodePath,
  NodeSink,
} from "@effect/platform-node"
import { Data, Effect, Stream } from "effect"
import * as Tar from "tar"

export class Npm extends Effect.Service<Npm>()("Npm", {
  dependencies: [
    NodeHttpClient.layerUndici,
    NodeFileSystem.layer,
    NodePath.layer,
  ],
  effect: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        HttpClientRequest.prependUrl("https://registry.npmjs.org"),
      ),
      HttpClient.filterStatusOk,
    )

    const tarball = (packageName: string, version: string) => {
      const lastPart = packageName.split("/").pop()!
      return client.get(`/${packageName}/-/${lastPart}-${version}.tgz`).pipe(
        HttpClientResponse.stream,
        Stream.mapError((cause) => new NpmError({ cause, method: "tarball" })),
      )
    }

    const install = Effect.fn("Npm.install")(function* (options: {
      readonly packageName: string
      readonly version: string
    }) {
      const directory = `${options.packageName.replace(/^@/g, "").replace(/\//g, "-")}-${options.version}`
      const dir = path.join("node_modules", directory)
      if (yield* fs.exists(dir)) {
        return directory
      }

      yield* Effect.orDie(fs.makeDirectory(dir, { recursive: true }))
      const sink = NodeSink.fromWritable(
        () =>
          Tar.x({
            C: dir,
            strip: 1,
          }),
        (cause) => new NpmError({ cause, method: "install" }),
      )
      yield* Stream.run(tarball(options.packageName, options.version), sink)
      return directory
    })

    return { install } as const
  }),
}) {}

export class NpmError extends Data.TaggedError("NpmError")<{
  method: string
  cause: unknown
}> {}
