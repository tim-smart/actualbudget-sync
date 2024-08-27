# @tim-smart/actualbudget-sync

A library to build Actual Budget sync scripts.

## BNZ Example

The BNZ bank is included in the library (see `src/Bank/Bnz.ts` to see how banks
can be implemented). You can use it like this:

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Actual } from "@tim-smart/actualbudget-sync/Actual"
import { BnzLive } from "@tim-smart/actualbudget-sync/Bank/Bnz"
import * as Sync from "@tim-smart/actualbudget-sync/Sync"
import { Effect, Layer, Logger } from "effect"

const EnvLive = Layer.mergeAll(Actual.Live, BnzLive)

const program = Sync.run([
  {
    bankAccountId: "Savings",
    actualAccountId: "xxxx-xxxx-xxxx-xxxx",
  },
  {
    bankAccountId: "Credit Card",
    actualAccountId: "xxxx-xxxx-xxxx-xxxx",
  },
]).pipe(Effect.provide(EnvLive))

NodeRuntime.runMain(program)
```
