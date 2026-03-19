import { ConfigProvider, Duration, Effect, Layer, Ref } from "effect"
import {
  HttpClient,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { RateLimiter } from "effect/unstable/persistence"
import { assert, it } from "@effect/vitest"
import { UpBankLayer } from "./Up.ts"
import type { Bank } from "../Bank.ts"
import { runCollect, runTest, testCategories, testPayees } from "../Sync.ts"

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

const testConfig = ConfigProvider.layer(
  ConfigProvider.fromEnv({ env: { UP_USER_TOKEN: "test-token" } }),
)

const testRateLimiter = RateLimiter.layer.pipe(
  Layer.provide(RateLimiter.layerStoreMemory),
)

/** Build a fully-wired Bank layer backed by a mock HTTP handler. */
const makeUpTestLayer = (
  handler: (
    req: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
): Layer.Layer<Bank> =>
  UpBankLayer.pipe(
    Layer.provide(
      Layer.succeed(HttpClient.HttpClient)(
        HttpClient.make((req) => handler(req)),
      ),
    ),
    Layer.provide(testRateLimiter),
    Layer.provide(testConfig),
    Layer.orDie,
  )

/** Narrow a runTest/runCollect result to access payee_name safely. */
const payeeName = (tx: object): string | undefined =>
  "payee_name" in tx ? (tx as { payee_name: string }).payee_name : undefined

// ---------------------------------------------------------------------------
// Mock data helpers
// ---------------------------------------------------------------------------

const makeTransaction = (
  id: string,
  overrides?: {
    status?: "HELD" | "SETTLED"
    amountBaseUnits?: number
    description?: string
    settledAt?: string | null
    transferAccountId?: string | null
    cashback?: {
      description: string
      amount: { valueInBaseUnits: number }
    } | null
    categoryId?: string | null
  },
) => ({
  id,
  type: "transactions",
  attributes: {
    status: overrides?.status ?? "SETTLED",
    description: overrides?.description ?? "Coffee",
    message: null,
    amount: {
      currencyCode: "AUD",
      value: -4.5,
      valueInBaseUnits: overrides?.amountBaseUnits ?? -450,
    },
    settledAt:
      overrides?.settledAt === undefined
        ? "2024-01-15T10:00:00+11:00"
        : overrides.settledAt,
    createdAt: "2024-01-15T09:00:00+11:00",
    note: null,
    cashback: overrides?.cashback ?? null,
  },
  relationships: {
    category: {
      data:
        overrides?.categoryId != null
          ? { type: "categories", id: overrides.categoryId }
          : null,
    },
    transferAccount: {
      data:
        overrides?.transferAccountId != null
          ? { type: "accounts", id: overrides.transferAccountId }
          : null,
    },
  },
})

const makePage = (data: unknown[], next: string | null) =>
  new Response(JSON.stringify({ data, links: { prev: null, next } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

// ---------------------------------------------------------------------------
// Test 1a — Server responds with 429; retryTransient retries until success
// ---------------------------------------------------------------------------

it.effect("retries on 429 from Up API and eventually succeeds", () =>
  Effect.gen(function* () {
    const callCount = yield* Ref.make(0)

    const layer = makeUpTestLayer((req) =>
      Effect.gen(function* () {
        const n = yield* Ref.updateAndGet(callCount, (x) => x + 1)
        const response =
          n < 3
            ? new Response(null, { status: 429 })
            : makePage([makeTransaction("t1")], null)
        return HttpClientResponse.fromWeb(req, response)
      }),
    )

    const results = yield* runCollect({
      accounts: [
        { bankAccountId: "checking", actualAccountId: "actual-checking" },
      ],
      syncDuration: Duration.days(30),
      categorize: false,
      categories: testCategories,
      payees: testPayees,
    }).pipe(Effect.provide(layer))

    const txns = results.flatMap((r) => r.transactions)
    // Two 429s then one successful response — three total calls
    assert.equal(yield* Ref.get(callCount), 3)
    assert.equal(txns.length, 1)
    // imported_id is now the stable Up Bank transaction id, not a date+amount derivation
    assert.equal(txns[0].imported_id, "t1")
  }),
)

// ---------------------------------------------------------------------------
// Test 1b — Local RateLimiter smoke: layer wires up without errors
// ---------------------------------------------------------------------------

it.effect("RateLimiter layer initialises without errors", () =>
  Effect.gen(function* () {
    const layer = makeUpTestLayer((req) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          req,
          makePage([makeTransaction("t1")], null),
        ),
      ),
    )

    const results = yield* runCollect({
      accounts: [
        { bankAccountId: "checking", actualAccountId: "actual-checking" },
      ],
      syncDuration: Duration.days(30),
      categorize: false,
      categories: testCategories,
      payees: testPayees,
    }).pipe(Effect.provide(layer))

    assert.equal(results.flatMap((r) => r.transactions).length, 1)
  }),
)

// ---------------------------------------------------------------------------
// Test 2 — Short single-account sync: one page, varied transaction types
// ---------------------------------------------------------------------------

const shortSyncTxns = [
  // Standard SETTLED transaction
  makeTransaction("settled-1", {
    description: "Woolworths",
    amountBaseUnits: -2050,
    settledAt: "2024-01-10T14:00:00+11:00",
  }),
  // HELD (pending) transaction — no settledAt, uses createdAt
  makeTransaction("held-1", {
    status: "HELD",
    description: "Pending Coffee",
    amountBaseUnits: -350,
    settledAt: null,
  }),
  // SETTLED with cashback — must emit two AccountTransactions
  makeTransaction("cashback-1", {
    description: "Perk purchase",
    amountBaseUnits: -1000,
    settledAt: "2024-01-11T10:00:00+11:00",
    cashback: {
      description: "Happy Hour Cashback",
      amount: { valueInBaseUnits: 200 },
    },
  }),
  // Transfer with description "Round Up" — notes should be "Round Up"
  makeTransaction("roundup-1", {
    description: "Round Up",
    amountBaseUnits: -50,
    settledAt: "2024-01-12T10:00:00+11:00",
    transferAccountId: "round-up-account",
  }),
  // Outgoing cover to the joint account (which IS in the sync list via runTest's "savings").
  // In real Up usage this is e.g. "Cover to 2Up Spending" where transferAccount = the joint account.
  makeTransaction("cover-to-1", {
    description: "Cover to Savings",
    amountBaseUnits: -3000,
    settledAt: "2024-01-13T10:00:00+11:00",
    transferAccountId: "savings",
  }),
  // Incoming cover from an external Up user (NOT in the sync list).
  makeTransaction("cover-from-1", {
    description: "Cover from Jane Smith",
    amountBaseUnits: 3000,
    settledAt: "2024-01-13T12:00:00+11:00",
    transferAccountId: "external-jane-up",
  }),
]

// Only return transactions for the "checking" account; "savings" returns empty.
const shortSyncLayer = makeUpTestLayer((req) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      req,
      makePage(req.url.includes("/checking/") ? shortSyncTxns : [], null),
    ),
  ),
)

it.layer(shortSyncLayer)("Short sync (<30 days, <100 transactions)", (it) => {
  it.effect("maps a SETTLED transaction correctly", () =>
    Effect.gen(function* () {
      const results = yield* runTest({ categorize: false })
      const tx = results.find((r) => payeeName(r) === "Woolworths")
      assert.exists(tx)
      assert.equal(tx!.amount, -2050)
      assert.equal(tx!.cleared, true)
    }),
  )

  it.effect("maps a HELD transaction as not cleared", () =>
    Effect.gen(function* () {
      const results = yield* runTest({ categorize: false })
      const tx = results.find((r) => payeeName(r) === "Pending Coffee")
      assert.exists(tx)
      assert.equal(tx!.cleared, false)
      assert.equal(tx!.amount, -350)
    }),
  )

  it.effect("cashback emits a separate second transaction", () =>
    Effect.gen(function* () {
      const results = yield* runTest({ categorize: false })
      const cashbackTxs = results.filter(
        (r) => payeeName(r) === "Happy Hour Cashback",
      )
      assert.equal(cashbackTxs.length, 1)
      assert.equal(cashbackTxs[0].amount, 200)
      assert.equal(cashbackTxs[0].cleared, true)
    }),
  )

  it.effect("Round Up transfer sets notes to 'Round Up'", () =>
    Effect.gen(function* () {
      const results = yield* runTest({ categorize: false })
      // The Round Up transfer account is not in the accounts list, so payee
      // resolution falls back — but notes="Round Up" is set by Up.ts regardless.
      const tx = results.find((r) => r.notes === "Round Up")
      assert.exists(tx)
      assert.equal(tx!.amount, -50)
    }),
  )

  it.effect(
    "Cover to a synced account resolves to a transfer payee (no payee_name)",
    () =>
      Effect.gen(function* () {
        const results = yield* runTest({ categorize: false })
        // "savings" is in the accounts list → transfer resolves to payee "7"
        // notes = "Cover to Savings" (description.replace("from", "-") is a no-op here)
        const tx = results.find((r) => r.notes === "Cover to Savings")
        assert.exists(tx)
        assert.equal(tx!.amount, -3000)
        assert.isFalse(
          "payee_name" in tx!,
          "should use transfer payee, not payee_name",
        )
        assert.equal((tx as unknown as { payee: string }).payee, "7")
      }),
  )

  it.effect(
    "Cover from an external Up user formats notes to 'Cover - $name'",
    () =>
      Effect.gen(function* () {
        const results = yield* runTest({ categorize: false })
        // notes = "Cover from Jane Smith".replace("from", "-") = "Cover - Jane Smith"
        const tx = results.find((r) => r.notes === "Cover - Jane Smith")
        assert.exists(tx)
        assert.equal(tx!.amount, 3000)
      }),
  )
})

// ---------------------------------------------------------------------------
// Test 3 — Long single-account sync: 100 pages × 100 transactions = 10 000
// ---------------------------------------------------------------------------

it.effect(
  "paginates through 10 000 transactions across 100 pages",
  () =>
    Effect.gen(function* () {
      const PAGE_COUNT = 100
      const PER_PAGE = 100

      const layer = makeUpTestLayer((req) =>
        Effect.sync(() => {
          // Extract page index from cursor param embedded in the URL
          const urlObj = new URL(req.url)
          const pageStr = urlObj.searchParams.get("page_index")
          const page = pageStr === null ? 0 : Number(pageStr)

          const txns = Array.from({ length: PER_PAGE }, (_, i) =>
            makeTransaction(`t-${page}-${i}`, {
              amountBaseUnits: -(page * PER_PAGE + i + 1) * 10,
              settledAt: `2024-01-${String((page % 28) + 1).padStart(2, "0")}T10:00:00+11:00`,
            }),
          )

          const nextPage = page < PAGE_COUNT - 1 ? page + 1 : null
          const nextUrl =
            nextPage !== null
              ? `https://api.up.com.au/api/v1/accounts/checking/transactions?page_index=${nextPage}`
              : null

          return HttpClientResponse.fromWeb(req, makePage(txns, nextUrl))
        }),
      )

      const results = yield* runCollect({
        accounts: [
          { bankAccountId: "checking", actualAccountId: "actual-checking" },
        ],
        syncDuration: Duration.days(1000),
        categorize: false,
        categories: testCategories,
        payees: testPayees,
      }).pipe(Effect.provide(layer))

      const allTxns = results.flatMap((r) => r.transactions)
      assert.equal(allTxns.length, PAGE_COUNT * PER_PAGE)
    }),
  { timeout: 30_000 },
)

// ---------------------------------------------------------------------------
// Test 4 — Regression: HELD → SETTLED must preserve imported_id
//
// Previously, imported_id was derived from dateTime (settledAt ?? createdAt).
// When a HELD transaction (using createdAt) later settled with a settledAt
// 1-2 days after createdAt, the imported_id changed — causing Actual Budget
// to treat the settled version as a new transaction and import a duplicate.
//
// Fix: imported_id is now the stable Up Bank transaction id (externalId),
// which never changes between HELD and SETTLED states.
// ---------------------------------------------------------------------------

it.effect(
  "HELD then SETTLED: imported_id must stay stable across the transition",
  () =>
    Effect.gen(function* () {
      const TRANSACTION_ID = "tx-coffee-abc123"

      // First seen as HELD — settledAt is null, so dateTime = createdAt
      // createdAt "2024-01-15T09:00:00+11:00" = UTC 2024-01-14T22:00:00Z → date part "20240114"
      const heldTx = makeTransaction(TRANSACTION_ID, {
        status: "HELD",
        description: "Coffee",
        amountBaseUnits: -450,
        settledAt: null,
      })

      // Same Up Bank transaction, now settled 2 days later
      // settledAt "2024-01-17T10:00:00+11:00" = UTC 2024-01-16T23:00:00Z → date part "20240116"
      const settledTx = makeTransaction(TRANSACTION_ID, {
        status: "SETTLED",
        description: "Coffee",
        amountBaseUnits: -450,
        settledAt: "2024-01-17T10:00:00+11:00",
      })

      const makeLayer = (tx: unknown) =>
        makeUpTestLayer((req) =>
          Effect.succeed(HttpClientResponse.fromWeb(req, makePage([tx], null))),
        )

      const opts = {
        accounts: [
          { bankAccountId: "checking", actualAccountId: "actual-checking" },
        ],
        syncDuration: Duration.days(30),
        categorize: false,
        categories: testCategories,
        payees: testPayees,
      }

      const heldResults = yield* runCollect(opts).pipe(
        Effect.provide(makeLayer(heldTx)),
      )
      const settledResults = yield* runCollect(opts).pipe(
        Effect.provide(makeLayer(settledTx)),
      )

      const heldId = heldResults[0].ids[0]
      const settledId = settledResults[0].ids[0]

      // Both calls represent the same Up Bank transaction. The imported_id must
      // be identical so that Actual Budget's findImported can deduplicate them
      // and update the existing record rather than inserting a second one.
      assert.equal(
        heldId,
        settledId,
        `imported_id changed on settlement: HELD="${heldId}" SETTLED="${settledId}"`,
      )
    }),
)

// ---------------------------------------------------------------------------
// Test 5 — Two separate sync runs sharing the same joint account
// ---------------------------------------------------------------------------

it.effect(
  "two independent sync runs each receive joint account transactions without cross-contamination",
  () =>
    Effect.gen(function* () {
      const personalATxns = [
        makeTransaction("pa-1", {
          description: "Salary",
          amountBaseUnits: 500000,
          settledAt: "2024-01-10T10:00:00+11:00",
        }),
      ]
      const personalBTxns = [
        makeTransaction("pb-1", {
          description: "Freelance",
          amountBaseUnits: 200000,
          settledAt: "2024-01-11T10:00:00+11:00",
        }),
      ]
      const jointTxns = [
        makeTransaction("j-1", {
          description: "Groceries",
          amountBaseUnits: -8500,
          settledAt: "2024-01-12T10:00:00+11:00",
        }),
        makeTransaction("j-2", {
          description: "Netflix",
          amountBaseUnits: -2200,
          settledAt: "2024-01-13T10:00:00+11:00",
        }),
      ]

      const makeHandler =
        (personalAccountId: string, personalTxns: unknown[]) =>
        (req: HttpClientRequest.HttpClientRequest) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              req,
              makePage(
                req.url.includes(personalAccountId)
                  ? personalTxns
                  : req.url.includes("joint-account")
                    ? jointTxns
                    : [],
                null,
              ),
            ),
          )

      const makeRunLayer = (
        personalAccountId: string,
        personalTxns: unknown[],
      ) => makeUpTestLayer(makeHandler(personalAccountId, personalTxns))

      const runAs = (
        personalBankId: string,
        personalActualId: string,
        layer: Layer.Layer<Bank>,
      ) =>
        runCollect({
          accounts: [
            {
              bankAccountId: personalBankId,
              actualAccountId: personalActualId,
            },
            {
              bankAccountId: "joint-account",
              actualAccountId: "actual-joint",
            },
          ],
          syncDuration: Duration.days(30),
          categorize: false,
          categories: testCategories,
          payees: testPayees,
        }).pipe(Effect.provide(layer))

      const [runA, runB] = yield* Effect.all([
        runAs(
          "personal-a",
          "actual-personal-a",
          makeRunLayer("personal-a", personalATxns),
        ),
        runAs(
          "personal-b",
          "actual-personal-b",
          makeRunLayer("personal-b", personalBTxns),
        ),
      ])

      // Each run should see its own personal transactions
      const personalA = runA.find(
        (r) => r.actualAccountId === "actual-personal-a",
      )!
      const personalB = runB.find(
        (r) => r.actualAccountId === "actual-personal-b",
      )!
      assert.equal(personalA.transactions.length, 1)
      assert.equal(payeeName(personalA.transactions[0]), "Salary")
      assert.equal(personalB.transactions.length, 1)
      assert.equal(payeeName(personalB.transactions[0]), "Freelance")

      // Both runs see the same joint transactions
      const jointA = runA.find((r) => r.actualAccountId === "actual-joint")!
      const jointB = runB.find((r) => r.actualAccountId === "actual-joint")!
      assert.equal(jointA.transactions.length, 2)
      assert.equal(jointB.transactions.length, 2)

      // Same imported_ids in both runs — Actual Budget handles deduplication
      assert.deepStrictEqual(jointA.ids, jointB.ids)
    }),
)

// ---------------------------------------------------------------------------
// Test 5 — Cross-account transfer payee resolution and joint-account runs
//
// Part A: within a single run (checking + savings + joint), transfers between
//         accounts in the list resolve to a transfer payee ID; transfers whose
//         target is outside the list fall back to payee_name.
//
// Part B: the same joint transaction (joint → personal-a) resolves to a
//         transfer payee in Run A (which includes personal-a) but falls back
//         to payee_name in Run B (which does not include personal-a).
// ---------------------------------------------------------------------------

it.effect(
  "transfer payees resolve per-run; joint transfers differ between independent sync runs",
  () =>
    Effect.gen(function* () {
      // All payees have an explicit transfer_acct so the payees.find() in
      // transferAccountId() never false-matches on `undefined === undefined`.
      const crossPayees = [
        { id: "6", name: "Checking", transfer_acct: "actual-checking" },
        { id: "7", name: "Savings", transfer_acct: "actual-savings" },
        { id: "joint-payee", name: "Joint", transfer_acct: "actual-joint" },
        {
          id: "pa-payee",
          name: "Personal A",
          transfer_acct: "actual-personal-a",
        },
        {
          id: "pb-payee",
          name: "Personal B",
          transfer_acct: "actual-personal-b",
        },
      ]

      // Shared joint transactions used in both Part A and Part B
      const jointTxns = [
        makeTransaction("joint-grocery", {
          description: "Grocery Store",
          amountBaseUnits: -8500,
          settledAt: "2024-01-22T10:00:00+11:00",
        }),
        // Transfer to personal-a: resolved in Run A, falls back in Run B
        makeTransaction("joint-to-pa", {
          description: "Transfer to Personal A",
          amountBaseUnits: -30000,
          settledAt: "2024-01-23T10:00:00+11:00",
          transferAccountId: "personal-a",
        }),
      ]

      // ── Part A: single run with checking + savings + joint ──────────────

      const checkingTxns = [
        makeTransaction("xfer-to-savings", {
          description: "Transfer to Savings",
          amountBaseUnits: -50000,
          settledAt: "2024-01-20T10:00:00+11:00",
          transferAccountId: "savings",
        }),
        makeTransaction("xfer-to-joint", {
          description: "Transfer to Joint",
          amountBaseUnits: -20000,
          settledAt: "2024-01-21T10:00:00+11:00",
          transferAccountId: "joint",
        }),
      ]

      const savingsTxns = [
        makeTransaction("xfer-from-checking", {
          description: "Transfer from Checking",
          amountBaseUnits: 50000,
          settledAt: "2024-01-20T10:00:00+11:00",
          transferAccountId: "checking",
        }),
      ]

      const singleRunLayer = makeUpTestLayer((req) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            makePage(
              req.url.includes("/checking/")
                ? checkingTxns
                : req.url.includes("/savings/")
                  ? savingsTxns
                  : req.url.includes("/joint/")
                    ? jointTxns
                    : [],
              null,
            ),
          ),
        ),
      )

      const singleRun = yield* runCollect({
        accounts: [
          { bankAccountId: "checking", actualAccountId: "actual-checking" },
          { bankAccountId: "savings", actualAccountId: "actual-savings" },
          { bankAccountId: "joint", actualAccountId: "actual-joint" },
        ],
        syncDuration: Duration.days(30),
        categorize: false,
        categories: testCategories,
        payees: crossPayees,
      }).pipe(Effect.provide(singleRunLayer))

      const checkingAcc = singleRun.find(
        (r) => r.actualAccountId === "actual-checking",
      )!
      const savingsAcc = singleRun.find(
        (r) => r.actualAccountId === "actual-savings",
      )!
      const jointAcc = singleRun.find(
        (r) => r.actualAccountId === "actual-joint",
      )!

      // checking → savings: both in accounts list → transfer payee "7"
      const xferToSavings = checkingAcc.transactions.find(
        (t) => "payee" in t && (t as { payee: string }).payee === "7",
      )
      assert.exists(
        xferToSavings,
        "checking→savings should resolve to Savings transfer payee",
      )
      assert.equal(xferToSavings!.amount, -50000)

      // savings ← checking: both in accounts list → transfer payee "6"
      const xferFromChecking = savingsAcc.transactions.find(
        (t) => "payee" in t && (t as { payee: string }).payee === "6",
      )
      assert.exists(
        xferFromChecking,
        "savings←checking should resolve to Checking transfer payee",
      )
      assert.equal(xferFromChecking!.amount, 50000)

      // checking → joint: both in accounts list → transfer payee "joint-payee"
      const xferToJoint = checkingAcc.transactions.find(
        (t) => "payee" in t && (t as { payee: string }).payee === "joint-payee",
      )
      assert.exists(
        xferToJoint,
        "checking→joint should resolve to Joint transfer payee",
      )
      assert.equal(xferToJoint!.amount, -20000)

      // joint external (no transferAccountId) → falls back to payee_name
      const grocery = jointAcc.transactions.find(
        (t) => payeeName(t) === "Grocery Store",
      )
      assert.exists(grocery, "joint external transaction should use payee_name")

      // joint → personal-a: personal-a NOT in this run's accounts → falls back to payee_name
      const jointToPAFallback = jointAcc.transactions.find(
        (t) => payeeName(t) === "Transfer to Personal A",
      )
      assert.exists(
        jointToPAFallback,
        "joint→personal-a should fall back when personal-a is not in the run",
      )

      // ── Part B: two independent runs sharing the same joint account ─────

      const makeJointRunLayer = (
        personalBankId: string,
        personalTxns: unknown[],
      ) =>
        makeUpTestLayer((req) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              req,
              makePage(
                req.url.includes(`/${personalBankId}/`)
                  ? personalTxns
                  : req.url.includes("/joint/")
                    ? jointTxns
                    : [],
                null,
              ),
            ),
          ),
        )

      const runForUser = (
        personalBankId: string,
        personalActualId: string,
        personalTxns: unknown[],
      ) =>
        runCollect({
          accounts: [
            {
              bankAccountId: personalBankId,
              actualAccountId: personalActualId,
            },
            { bankAccountId: "joint", actualAccountId: "actual-joint" },
          ],
          syncDuration: Duration.days(30),
          categorize: false,
          categories: testCategories,
          payees: crossPayees,
        }).pipe(Effect.provide(makeJointRunLayer(personalBankId, personalTxns)))

      const [runA2, runB2] = yield* Effect.all([
        runForUser("personal-a", "actual-personal-a", [
          makeTransaction("pa-salary", {
            description: "Salary",
            amountBaseUnits: 300000,
            settledAt: "2024-01-15T10:00:00+11:00",
          }),
        ]),
        runForUser("personal-b", "actual-personal-b", [
          makeTransaction("pb-freelance", {
            description: "Freelance",
            amountBaseUnits: 100000,
            settledAt: "2024-01-15T10:00:00+11:00",
          }),
        ]),
      ])

      const jointInRunA = runA2.find(
        (r) => r.actualAccountId === "actual-joint",
      )!
      const jointInRunB = runB2.find(
        (r) => r.actualAccountId === "actual-joint",
      )!

      // Run A: personal-a IS in accounts → joint→personal-a resolves to "pa-payee"
      const resolvedInA = jointInRunA.transactions.find(
        (t) => "payee" in t && (t as { payee: string }).payee === "pa-payee",
      )
      assert.exists(
        resolvedInA,
        "Run A: joint→personal-a should resolve to transfer payee",
      )
      assert.equal(resolvedInA!.amount, -30000)

      // Run B: personal-a NOT in accounts → joint→personal-a falls back to payee_name
      const unresolvedInB = jointInRunB.transactions.find(
        (t) => payeeName(t) === "Transfer to Personal A",
      )
      assert.exists(
        unresolvedInB,
        "Run B: joint→personal-a should fall back to payee_name",
      )
      assert.equal(unresolvedInB!.amount, -30000)

      // Both runs still see all 2 joint transactions
      assert.equal(jointInRunA.transactions.length, 2)
      assert.equal(jointInRunB.transactions.length, 2)

      // Same imported_ids across both runs — Actual Budget deduplicates by imported_id,
      // so the joint→personal-a transfer appears once in the UI regardless of how
      // each run resolved its payee
      assert.deepStrictEqual(
        jointInRunA.ids,
        jointInRunB.ids,
        "joint transaction imported_ids must match across runs so Actual Budget deduplicates them",
      )
    }),
)

// ---------------------------------------------------------------------------
// Test 6a — transferAccounts: joint account transferring to a partner's
//            personal account that is listed only in transferAccounts.
//
// The joint account pays out to personal-b (e.g. splitting expenses). Run A
// syncs [personal-a, joint] and lists personal-b as a transfer-only account.
// The joint → personal-b transaction must resolve to "pb-payee", and
// personal-b's endpoint must never be fetched.
// ---------------------------------------------------------------------------

it.effect(
  "transferAccounts (joint→personal): joint transfer to partner account resolves payee without fetching it",
  () =>
    Effect.gen(function* () {
      const requestedUrls = yield* Ref.make<ReadonlyArray<string>>([])

      const crossPayees = [
        {
          id: "pa-payee",
          name: "Personal A",
          transfer_acct: "actual-personal-a",
        },
        {
          id: "pb-payee",
          name: "Personal B",
          transfer_acct: "actual-personal-b",
        },
        { id: "joint-payee", name: "Joint", transfer_acct: "actual-joint" },
      ]

      const jointTxns = [
        makeTransaction("joint-to-pb", {
          description: "Transfer to Personal B",
          amountBaseUnits: -20000,
          settledAt: "2024-01-20T10:00:00+11:00",
          transferAccountId: "personal-b",
        }),
        makeTransaction("joint-groceries", {
          description: "Groceries",
          amountBaseUnits: -5000,
          settledAt: "2024-01-21T10:00:00+11:00",
        }),
      ]

      const layer = makeUpTestLayer((req) =>
        Effect.gen(function* () {
          yield* Ref.update(requestedUrls, (urls) => [...urls, req.url])
          return HttpClientResponse.fromWeb(
            req,
            makePage(req.url.includes("/joint/") ? jointTxns : [], null),
          )
        }),
      )

      const results = yield* runCollect({
        accounts: [
          { bankAccountId: "personal-a", actualAccountId: "actual-personal-a" },
          { bankAccountId: "joint", actualAccountId: "actual-joint" },
        ],
        transferAccounts: [
          { bankAccountId: "personal-b", actualAccountId: "actual-personal-b" },
        ],
        syncDuration: Duration.days(30),
        categorize: false,
        categories: testCategories,
        payees: crossPayees,
      }).pipe(Effect.provide(layer))

      const jointAcc = results.find(
        (r) => r.actualAccountId === "actual-joint",
      )!

      // joint → personal-b resolves to "pb-payee" via transferAccounts
      const transferTx = jointAcc.transactions.find(
        (t) => "payee" in t && (t as { payee: string }).payee === "pb-payee",
      )
      assert.exists(
        transferTx,
        "joint→personal-b should resolve to pb-payee via transferAccounts",
      )
      assert.equal(transferTx!.amount, -20000)

      // Unrelated joint transaction still falls back to payee_name
      const groceryTx = jointAcc.transactions.find(
        (t) => payeeName(t) === "Groceries",
      )
      assert.exists(groceryTx, "non-transfer transaction should use payee_name")

      const urls = yield* Ref.get(requestedUrls)
      assert.isFalse(
        urls.some((url) => url.includes("/personal-b/")),
        "personal-b is in transferAccounts only — its endpoint must not be fetched",
      )
      assert.isTrue(
        urls.some((url) => url.includes("/personal-a/")),
        "personal-a is in accounts — its endpoint must be fetched",
      )
    }),
)

// ---------------------------------------------------------------------------
// Test 6b — transferAccounts: personal account transferring directly to a
//            partner's personal account listed only in transferAccounts.
//
// Partner A sends money to Partner B (personal-a → personal-b). Run A syncs
// [personal-a, joint] and lists personal-b as a transfer-only account.
// The personal-a → personal-b transaction must resolve to "pb-payee".
// ---------------------------------------------------------------------------

it.effect(
  "transferAccounts (personal→personal): direct transfer to partner account resolves payee",
  () =>
    Effect.gen(function* () {
      const crossPayees = [
        {
          id: "pa-payee",
          name: "Personal A",
          transfer_acct: "actual-personal-a",
        },
        {
          id: "pb-payee",
          name: "Personal B",
          transfer_acct: "actual-personal-b",
        },
        { id: "joint-payee", name: "Joint", transfer_acct: "actual-joint" },
      ]

      const personalATxns = [
        // Direct transfer from personal-a to personal-b
        makeTransaction("pa-to-pb", {
          description: "Transfer to Partner",
          amountBaseUnits: -50000,
          settledAt: "2024-01-20T10:00:00+11:00",
          transferAccountId: "personal-b",
        }),
        makeTransaction("pa-coffee", {
          description: "Coffee",
          amountBaseUnits: -450,
          settledAt: "2024-01-21T10:00:00+11:00",
        }),
      ]

      const layer = makeUpTestLayer((req) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            makePage(
              req.url.includes("/personal-a/") ? personalATxns : [],
              null,
            ),
          ),
        ),
      )

      const results = yield* runCollect({
        accounts: [
          { bankAccountId: "personal-a", actualAccountId: "actual-personal-a" },
          { bankAccountId: "joint", actualAccountId: "actual-joint" },
        ],
        transferAccounts: [
          { bankAccountId: "personal-b", actualAccountId: "actual-personal-b" },
        ],
        syncDuration: Duration.days(30),
        categorize: false,
        categories: testCategories,
        payees: crossPayees,
      }).pipe(Effect.provide(layer))

      const personalAAcc = results.find(
        (r) => r.actualAccountId === "actual-personal-a",
      )!

      // personal-a → personal-b resolves to "pb-payee" via transferAccounts
      const transferTx = personalAAcc.transactions.find(
        (t) => "payee" in t && (t as { payee: string }).payee === "pb-payee",
      )
      assert.exists(
        transferTx,
        "personal-a→personal-b should resolve to pb-payee via transferAccounts",
      )
      assert.equal(transferTx!.amount, -50000)

      // Without transferAccounts this same transaction would have fallen back
      // to payee_name — verify the fallback behaviour for contrast
      const resultsNoTransfer = yield* runCollect({
        accounts: [
          { bankAccountId: "personal-a", actualAccountId: "actual-personal-a" },
          { bankAccountId: "joint", actualAccountId: "actual-joint" },
        ],
        syncDuration: Duration.days(30),
        categorize: false,
        categories: testCategories,
        payees: crossPayees,
      }).pipe(Effect.provide(layer))

      const personalANoTransfer = resultsNoTransfer.find(
        (r) => r.actualAccountId === "actual-personal-a",
      )!
      const fallbackTx = personalANoTransfer.transactions.find(
        (t) => payeeName(t) === "Transfer to Partner",
      )
      assert.exists(
        fallbackTx,
        "without transferAccounts, the same transaction should fall back to payee_name",
      )
    }),
)
