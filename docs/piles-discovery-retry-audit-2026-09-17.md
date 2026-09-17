# Discovery and retry audit — 2026-09-17

## Evidence and scope

Read-only production incident snapshots (Actions runs `35190584722` and
`35190737225`) showed capacity admission churn, `scan_incomplete`, and
`assignment_plan_incomplete`. Capacity claim counters are not assignment
submission counts. These generic errors do not prove the cause of each missing
pile; raw portal evidence is still needed for an end-to-end sign-off.

## Changes

1. Back off repeated capacity/lock contention exponentially, capped at 30 seconds.
   Waiting work remains recoverable, without a retry-count cutoff. Stop signals
   still interrupt waiting. No database schema change is required.
2. Recognize transient next-page and failed filter-response errors for the
   existing one-time full-context reload/retry. A second failure remains an error,
   never a successful empty or truncated scan. Identity collisions do not retry.
3. Match planned rows by stable tracking identity in the first assignment pass,
   persist relocated keys/pages before selection, and preserve the chosen owner.
   Reject ambiguous identities. Fresh assignment plans exclude already-owned
   rows; the existing stale-reassignment path explicitly permits assigned rows.
   Recovery passes use the same matcher and persist relocation too. Reloaded
   groups are matched again before selection, rather than using stale row keys.

## Existing retry boundaries

Selection already includes relocation attempts, two recovery passes, and a
same-run final context rescan. Unsubmitted plans that exhaust those paths become
failed evidence. Submitted-but-unconfirmed attempts must reconcile rather than
blindly submit again. These changes do not introduce automatic replay of failed
or uncertain submissions.

## Validation and remaining sign-off

Run `npm run test:piles` before committing. Regression coverage includes admission
backoff, identity relocation, intended-owner preservation, ambiguous/owned rows,
read-safe pagination retry classification, and propagating a failed retry.
Assignment-path tests exercise first-pass and recovery selection. The Piles
Regression Tests workflow runs the isolated suite on pull requests and main.

No production assignments, scheduler changes, or recovery writes are authorized
as part of this local validation. After deployment, observe a normal scheduled
cycle and compare discovered eligible identities with planned, confirmed,
externally assigned, and explicit unresolved outcomes. A passing local suite is
not proof that every production pile has been assigned.
