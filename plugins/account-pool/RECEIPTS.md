# Attempt receipts, version 1

The supported machine integration is authenticated HTTP under
`/api/v1/plugins/account-pool/http/receipts`. It uses the same hub bearer as model
requests. It does not accept host IDs or account IDs from callers. The plugin's
generic operator RPC identity is not a substitute for this host authentication.

POST `begin` with `{"version":1,"provider":"codex","attempt_id":"fresh-nonce"}`
(`claude` is also supported). A 200 response contains `version`, a random `id`,
authenticated `host_id`, echoed `attempt_id` and `provider`, `expires_at` in epoch
milliseconds, and a secret `token`. Do not log or persist this response. Use the
scoped token instead of the host bearer for that CLI process only:

- Codex: `CODEX_POOL_AUTH_TOKEN`, with the existing
  `model_providers.bb-account-pool.env_http_headers.x-bb-account-pool-token`
  configuration. The existing `provider-codex/src/bridge/bridge.ts` launch contract
  supplies this setting. Keep the hub base URL and Responses wire API.
- Claude: `ANTHROPIC_AUTH_TOKEN`, with the existing `ANTHROPIC_BASE_URL` pointing
  at the hub. Pool provider environment contribution already supplies this pair.

No receipt header needs to be forwarded upstream. Account credentials are selected
by the hub and remain independent of the scoped bearer. Scoped bearers cannot
begin another attempt or retrieve evidence. Keep the original host bearer in the
supervisor's memory for retrieval, outside the child environment.

POST `finalize` with the original host bearer and
`{"version":1,"id":"server-id","attempt_id":"fresh-nonce"}`. This seals the
attempt immediately: further requests using its scoped token receive 409. Poll
the same operation if requests remain active. Other hosts, wrong nonces, expired
IDs and IDs lost on restart return 404. Unsupported or nested-parent hubs return
503 from begin; clients must preflight before spending model quota. Ordinary host
traffic is unchanged.

The receipt contains exactly `version`, `id`, `host_id`, `attempt_id`, `provider`,
`sealed`, `valid`, `complete`, and `requests`. Requests have sequential `id`,
`kind` (`inference` or `metadata`), `state` (`active`, `finished`, `cancelled`,
`error`) and `hops`. Every actual upstream fetch, including authentication retry,
quota failover and transport failure, adds a hop before connecting. Hops contain:

- Sequential `index`, selected account UUID `account_id`, and `provider`.
- HTTP `status`, or null when unknown.
- `state`: `active`, `complete`, `unknown`, `rejected`, `cancelled`, `truncated`,
  or `transport_error`.
- Observed `model`, or null. Never the request's model selector.
- `usage`, or null. Known usage has integer `input_tokens`, `output_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`. Codex cache reads are
  subtracted from input before assigning the cache category; reasoning tokens are
  already included in output. Counts are disjoint and can be summed.

Terminal provider usage is retained if a transport failure or cancellation occurs
after it arrived. The hop's failure state still prevents acceptance; known usage
does not turn a failed or incomplete transport into success.

`complete` means sealed, valid, nonempty and all correlated activity has ended.
It does **not** mean all usage is known or the task succeeded. Accounting acceptance
also requires at least one inference request, finished requests, complete successful
inference hops with known usage/model, and successful metadata hops with null
usage/model. A successful retry does not erase unknown spending on an earlier hop.
The caller must retain its provider/task exit status independently.

Only allowlisted metadata is retained. Request/completion text, headers, credentials
and raw upstream errors are never receipt fields. The hub retains at most 64 attempts
for at most 24 hours, 128 requests per attempt, 32 hops per request and a 1 MiB parsing frame.
Once a sealed attempt has no active request or hop, retention is shortened to
ten minutes from the first finalize or admission sweep that observes this state
(or the original expiry, if sooner). This includes invalidated and unused sealed
attempts; it does not make their receipts valid or complete. Admission sweeps
also catch a sealed attempt that settles after its caller stops polling. Further
polls or sweeps cannot extend retention. Active and unsealed attempts keep their
original expiry and are not evicted to make room. Clients must preserve terminal
receipts promptly.
Exhaustion rejects admission; malformed, oversized or truncated evidence cannot
produce known usage. Unsupported inference routes invalidate admission. Metadata
(`models`, `count_tokens`) never creates billable model usage.
The native Codex image generation/edit and alpha search routes are admitted as
inference. Their unrecognized usage remains unknown and prevents accounting
acceptance without preventing later requests in the same attempt.

Storage is intentionally process-local in this first version. Restart, expiration
or evidence loss makes retrieval fail closed. Clients must preserve validated
receipts and their hashes; cached receipts cannot replace a fresh begin/finalize
exchange. Receipt support does not confer deployment or acceptance authority.
