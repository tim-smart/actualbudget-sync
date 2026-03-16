---
"@tim-smart/actualbudget-sync": patch
---

fix: prevent duplicate counterpart transactions when syncing shared accounts

When syncing shared Up Bank accounts (2UP), Forward/Cover transactions
that were initially imported without a transfer payee (because the target
account was not in scope) are now corrected to use the proper transfer
payee before new transactions are imported. This prevents Actual Budget
from auto-creating a duplicate counterpart transaction.
