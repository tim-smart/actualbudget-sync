---
"@tim-smart/actualbudget-sync": patch
---

Fix duplicate and missing transactions when the same account is included in multiple sync runs (e.g. a joint account synced alongside each partner's individual account).

Two bugs were present:

1. `findImported` queried for existing imported transactions across all accounts, so a transaction in one account could match a same-date/same-amount transaction in a different account, causing it to be silently skipped. The query now scopes to the specific account being synced.

2. The import ID counter in `makeImportId` was shared across all accounts in a single run, so the counter for an account's transactions would vary depending on which other accounts were included in the same invocation. This caused the same transaction to get a different import ID across runs, bypassing the duplicate check. The counter is now tracked per account.
