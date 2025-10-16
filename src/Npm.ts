import {
  NodeFileSystem,
  NodeHttpClient,
  NodePath,
  NodeSink,
} from "@effect/platform-node"
import { Effect, Layer, ServiceMap } from "effect"
import { Data } from "effect/data"
import { FileSystem, Path } from "effect/platform"
import { Stream } from "effect/stream"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import * as Tar from "tar"

export class Npm extends ServiceMap.Service<Npm>()("Npm", {
  make: Effect.gen(function* () {
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

    const install = Effect.fn(function* (options: {
      readonly packageName: string
      readonly version: string
    }) {
      const directory = `${options.packageName.replace(/^@/g, "").replace(/\//g, "-")}-${options.version}`
      const dir = path.join("node_modules", directory)
      if (yield* fs.exists(dir)) {
        return directory
      }

      yield* Effect.orDie(fs.makeDirectory(dir, { recursive: true }))
      const sink = NodeSink.fromWritable({
        evaluate: () =>
          Tar.x({
            C: dir,
            strip: 1,
          }),
        onError: (cause) => new NpmError({ cause, method: "install" }),
      })
      yield* Stream.run(tarball(options.packageName, options.version), sink)
      return directory
    })

    return { install, tarball } as const
  }),
}) {
  static layer = Layer.effect(this)(this.make).pipe(
    Layer.provide([
      NodeHttpClient.layerUndici,
      NodeFileSystem.layer,
      NodePath.layer,
    ]),
  )
}

export class NpmError extends Data.TaggedError("NpmError")<{
  method: string
  cause: unknown
}> {}