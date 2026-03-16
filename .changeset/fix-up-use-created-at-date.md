---
"@tim-smart/actualbudget-sync": patch
---

fix(up): use transaction creation date instead of settlement date

Up Bank transactions are now imported using `createdAt` (when the purchase
was made) rather than `settledAt` (when it cleared), matching the date
shown in the Up app.
