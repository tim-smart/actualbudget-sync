import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { FileSystem } from "@effect/platform/FileSystem"
import { Effect, pipe } from "effect"
import * as path from "node:path"

const read = pipe(
  FileSystem,
  Effect.flatMap((fileSystem) => fileSystem.readFileString("package.json")),
  Effect.map((_) => JSON.parse(_)),
  Effect.map((json) => ({
    name: json.name,
    version: json.version,
    description: json.description,
    bin: {
      actualsync: "./main.js",
    },
    repository: json.repository,
    author: json.author,
    license: json.license,
    keywords: json.keywords,
    dependencies: json.dependencies,
  })),
)

const pathTo = path.join("dist", "package.json")

const write = (pkg: object) =>
  pipe(
    FileSystem,
    Effect.flatMap((fileSystem) =>
      fileSystem.writeFileString(pathTo, JSON.stringify(pkg, null, 2)),
    ),
  )

const program = pipe(
  Effect.sync(() => console.log(`copying package.json to ${pathTo}...`)),
  Effect.flatMap(() => read),
  Effect.flatMap(write),
  Effect.provide(NodeFileSystem.layer),
)

Effect.runPromise(program)
