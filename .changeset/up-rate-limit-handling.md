---
"@tim-smart/actualbudget-sync": patch
---

Handle Up Bank rate limiting gracefully

- On a 429 response, read the `Retry-After` header and sleep for that duration before retrying (defaulting to 60s if the header is absent)
- After each successful page, check `X-RateLimit-Remaining`; if fewer than 3 requests remain, pause for 60s before fetching the next page
- 5xx and transport errors retry with exponential backoff (up to 5 attempts)
