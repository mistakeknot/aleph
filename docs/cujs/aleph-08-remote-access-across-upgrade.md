---
artifact_type: cuj
journey: remote-access-across-upgrade
actor: solo operator
criticality: p1
bead: none
---

# Reach the server remotely across an upgrade

*Supporting journey.* Coordinators block on the operator's decisions, and
the operator makes them remotely. If remote access is lost, every project
waits.

## Why This Journey Matters

The operator works on the server mostly from somewhere else, through bb's
hosted connect service in a browser. If an upgrade breaks pairing, the
operator can lose access to their own server, possibly while agent work is
running and they're nowhere near a console.

This is a real risk. Upstream once moved connect's pairing into a new
account plugin and later reverted the change after a production incident.
Aleph's first release includes that revert, so remote access uses Connect's
own pairing again. The next upstream change of this kind has to be caught
before the switch, not discovered after it.

### Current State vs. Planned

| Capability | Status |
|---|---|
| Remote access through Connect's own pairing (upstream revert included) | **Shipped** |
| Remote access checked by hand after the switch | **Shipped** (manual) |
| Range report flags upstream commits touching connect or pairing | **Planned** (part of the range script) |
| Switch canary checks remote access before the switch counts as done | **Planned** (part of the switch runbook) |
| Rollback restores remote access | **Planned** (part of the switch runbook) |

## The Journey

*Planned:* before an update, the coordinator's range report lists upstream commits
that touch the connect plugin, pairing or authentication. Those commits get
the same scrutiny as overlaps with carried patches. The review looks at
them specifically, and the operator's summary mentions them.

The switch runs as described in
[update Aleph to a new upstream release](aleph-07-upstream-update.md).
Remote access is part of the canary. With the new build running, the
remote URL loads, the session is still paired, and the operator can open a
thread and send a message without pairing again.

*The rest of this section is planned; today the check is by hand.* If the
remote check fails, the switch rolls back to the previous build and
snapshot before the operator's access is lost. The operator's next remote
visit sees the old build working, plus a BLOCKED report explaining what
failed.

## Success Signals

| Signal | Type | Status | Assertion |
|---|---|---|---|
| Remote access works after the switch | observable | active | The remote URL loads and an existing session stays paired on the new build |
| No re-pairing needed | observable | active | The operator sends a message remotely after the switch without a pairing step |
| Risky upstream changes flagged | measurable | planned | The range report lists every upstream commit touching connect, pairing or authentication |
| Canary gates the switch | measurable | planned | The switch isn't done until the remote canary passes |
| Failure rolls back remotely | observable | planned | A failed remote canary restores the previous build without anyone at the console |
| Operator never needs a console | qualitative | planned | Across upgrades, the operator never needs physical or local access to recover |

## Known Friction Points

- **Checked by hand today.** Remote access is verified after the switch,
  by the operator.
- **The fork's CI runs without credentials.** Fresh-guest qualification
  can't exercise real pairing with the hosted service, so the live check
  has to run at switch time.
- **Hosted service changes aren't in the repo.** Changes on the connect
  service side can break access without any change in Aleph.
