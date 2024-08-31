/**
 * @since 1.0.0
 */
import {
  Array,
  BigDecimal,
  Config,
  DateTime,
  Effect,
  flow,
  Layer,
  Option,
  Redacted,
} from "effect"
import { Browser, BrowserContext, Page } from "../Playwright.js"
import { AccountTransaction, Bank, BankError } from "../Bank.js"
import { configProviderNested } from "../internal/utils.js"

const make = Effect.gen(function* () {
  const page = yield* Page
  const accessNumber = yield* Config.string("accessNumber")
  const password = yield* Config.redacted("password")
  const timeZone = yield* DateTime.CurrentTimeZone
  const now = yield* DateTime.nowInCurrentZone
  const isFuture = dateGreaterThan(DateTime.endOf(now, "day"))

  yield* Effect.tryPromise({
    try: async () => {
      await page.goto("https://secure.bnz.co.nz/auth/personal-login")
      await page.locator("input#field-principal").fill(accessNumber)
      await page
        .locator("input#field-credentials")
        .fill(Redacted.value(password))
      await page.locator("button[type=submit]").click()

      const el = await Promise.race([
        page.waitForSelector("span.js-main-menu-button-text"),
        page.waitForSelector("input[title=Accept]"),
      ])

      const tagName = await el.evaluate((el) => el.tagName)
      if (tagName === "span") {
        return
      } else if (el) {
        await el.click()
      }
      await page.waitForSelector("span.js-main-menu-button-text")
    },
    catch: (cause) =>
      new BankError({ bank: "Bnz", reason: "Unauthorized", cause }),
  }).pipe(Effect.retry({ times: 3 }), Effect.orDie)

  const request = <T>(path: string, opts: Partial<RequestInit> = {}) =>
    Effect.tryPromise({
      try: () =>
        page.evaluate(
          ([path, opts]) =>
            fetch(`https://www.bnz.co.nz/ib/api${path}`, {
              credentials: "same-origin",
              ...opts,
            }).then((r) => r.json() as Promise<T>),
          [path, opts] as const,
        ),
      catch: (cause) =>
        new BankError({ bank: "Bnz", reason: "Unknown", cause }),
    })

  const accounts = yield* request<IBnzAccountList>("/accounts")

  const accountByName = (name: string) =>
    Array.findFirst(accounts.accountList, (acc) => acc.nickname === name)

  const listTransactions = (options: {
    readonly accountId: string
    readonly from: DateTime.DateTime
  }) =>
    Effect.gen(function* () {
      const toDate = (yield* DateTime.nowInCurrentZone).pipe(
        DateTime.add({ days: 1 }),
        DateTime.removeTime,
        DateTime.formatIsoDate,
      )
      const fromDate = options.from.pipe(
        DateTime.removeTime,
        DateTime.formatIsoDate,
      )
      return yield* request<TransactionsResponse>(
        `/transactions?from=${fromDate}&to=${toDate}&account=${options.accountId}`,
      )
    }).pipe(
      DateTime.withCurrentZone(timeZone),
      Effect.map((_) => _.transactions),
    )

  return Bank.of({
    exportAccount: (accountId) =>
      Effect.gen(function* () {
        const account = yield* accountByName(accountId).pipe(
          Effect.mapError(
            () => new BankError({ bank: "Bnz", reason: "AccountNotFound" }),
          ),
        )
        const from = now.pipe(DateTime.subtract({ days: 30 }))
        const transactions = yield* listTransactions({
          accountId: account.id,
          from,
        })
        return transactions
          .filter((t) => !isPendingInternational(t))
          .filter((t) => !isFuture(t))
          .map(convert)
      }),
  })
}).pipe(
  Effect.withConfigProvider(configProviderNested("bnz")),
  DateTime.withCurrentZoneNamed("Pacific/Auckland"),
)

export const BnzLive = Layer.effect(Bank, make).pipe(
  Layer.provide(Page.layer),
  Layer.provide(BrowserContext.layer({ bypassCSP: true })),
  Layer.provide(Browser.Live),
)

// helpers

const isPending = (t: Transaction) => t.status.code !== "POSTED"

const isPendingInternational = (transaction: Transaction) =>
  isPending(transaction) && transaction.value.currency !== "NZD"

const memo = ({ thisAccount: { details } }: Transaction): string =>
  [details.particulars, details.reference, details.code]
    .filter((s) => !!s)
    .join(" ")

const payee = (t: Transaction): string =>
  Option.fromNullable(t.otherAccount.holder.name).pipe(
    Option.orElse(() => Option.fromNullable(t.thisAccount.details.particulars)),
    Option.getOrElse(() => t.type.description),
  )

const amount = (t: Transaction): BigDecimal.BigDecimal =>
  BigDecimal.unsafeFromString(t.value.amount)

const dateTime = (t: Transaction) =>
  DateTime.unsafeMakeZoned(t.timestamp + "Z", {
    timeZone: "Pacific/Auckland",
    adjustForTimeZone: true,
  })

const date = flow(dateTime, DateTime.removeTime)

const dateGreaterThan = (now: DateTime.DateTime) => (t: Transaction) =>
  DateTime.greaterThan(date(t), now)

const convert = (transaction: Transaction): AccountTransaction => ({
  dateTime: dateTime(transaction),
  payee: payee(transaction),
  amount: amount(transaction),
  notes: memo(transaction),
  cleared: !isPending(transaction),
})

// types

export interface IBnzAccount {
  id: string
  nickname: string

  type: string
  productCode: string

  bankCode: string
  branchCode: string
  accountNumber: string
  suffix: string
}

export interface IBnzAccountList {
  accountCount: number
  accountList: IBnzAccount[]
}

// generated from quicktype
export interface TransactionsResponse {
  transactions: Transaction[]
  _links: Links
}

export interface Links {
  self: First
  next: First
  first: First
  last: First
}

export interface First {
  href: string
}

export interface Transaction {
  id: string
  thisAccount: ThisAccount
  otherAccount: OtherAccount
  timestamp: string
  status: Status
  value: RunningBalance
  runningBalance: RunningBalance
  type: Type
  channel?: string
}

export interface OtherAccount {
  accountNumber?: string
  holder: Holder
  details: Details
}

export interface Details {
  particulars?: string
  code?: string
  reference?: string
}

export interface Holder {
  name?: string
}

export interface RunningBalance {
  currency: string
  amount: string
}

export interface Status {
  code: string
  timestamp?: string
}

export interface ThisAccount {
  accountHash: string
  details: Details
}

export interface Type {
  code: string
  description: string
}
