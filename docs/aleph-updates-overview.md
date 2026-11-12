# Updates overview export

The server reads `aleph-update/overview.json` inside its data directory. An
operator-owned exporter supplies this read-only file. The UI shows unavailable
until the exporter is connected. It is independent of signed updater manifests
and cannot authorize or supply an executable update target.

The format is validated by `alephOverviewExportSchema` in the server contract.
All five sections are required, and each can be null:

- `installation`: source, checkedAt, version, commit, installedAt (nullable).
- `qualification`: source, checkedAt, version, commit, result (passed or failed).
- `upstream`: source, checkedAt, release, base, head, firstParentGap (nonnegative).
- `sync`: source, checkedAt, heartbeatAt, phase (integrating, qualifying,
  awaiting-review, idle or blocked).
- `summary`: version, commit, text (reviewed Aleph summary, at most 8000 characters).

Times use ISO 8601 UTC; commits use full lowercase 40-character SHA values.
Sources are public display labels, never paths or operator identities. Export
only sanitized public metadata. Installation time comes from a structured
receipt, never file modification time. The running server version is reported
independently and a differing installation receipt is labelled as such.

Missing or invalid exports retain last known evidence in memory, marked stale.
Evidence older than 24 hours is also stale. Sync heartbeats expire after 15
minutes and future heartbeats are unavailable. No active sync is inferred from
the commit gap. Summary attribution requires the running version and installation
commit to match. Qualification always names its exact version and commit.

Read the snapshot through `sdk.system.alephUpdateStatus()` or
`bb updates aleph --json`. These reads neither refresh the operator's sources
nor start an installation. Request delivery reports successful command completion,
failure or unavailable, separately from the persisted request time. Delivery
outcomes are process-local and become unavailable on restart; timestamps alone
are not proof of delivery.

The server enforces install-request eligibility through the same
`alephInstallEligibility` contract function used by the UI. New requests require
an available signed target, fresh overview evidence, a configured notification
recipient, passed qualification matching the target version, and a target newer
than the known installed version. Numeric version components are compared as
numbers; unknown or mixed Aleph suffix schemes are not guessed.

A rejected request returns HTTP 409 with code `aleph_request_ineligible`, a
human-readable message and `details.reason` from
`alephInstallIneligibleReasonSchema`. Target/digest races retain
`aleph_request_stale`. The server rereads evidence at submission, so a prior
eligible status does not grant permission to submit later. Replays of an existing
matching nonce and cancellation remain available after eligibility changes.
Requests only record intent and never start installation.

`comparisonVersion` on the update status is the exact installed-version input
used by the signed selector: the installed record's version, or the full running
app version when no installed record is available. Request eligibility uses this
same value independently of receipt availability. An explicit null means the
comparison input is unavailable. For older responses without this field, the
shared policy falls back to the installed record and then overview.runningVersion.
This does not change version parsing or turn a non-comparable signed selection
into an available update.
