# Piles Assignment Completeness Repair

## Objective

Make every production insurer run truthfully account for every discovered assignment plan, remove false filter timeouts, preserve point-in-time completeness, and shorten validation work that cannot assign.

## Production evidence

- Real scheduled runs contain confirmed portal assignments, so assignment is not globally unavailable.
- A DEFMIS run finished with one persisted `planned` attempt that never reached submission.
- Two isolated DEFMIS read-only crawls failed with `filter_not_confirmed`.
- An isolated Kenya read-only crawl completed portal scanning but repeated the full late-arrival scan.
- The database queue, insurer locks, assignee eligibility, and host memory were healthy during inspection.

## Commit sequence

- [x] Correlate filter request lifecycle state to the exact requested context and expose bounded diagnostic subcodes.
- [x] Keep unresolved planned attempts in the same run, relocate them across the final complete scan, and require a terminal outcome.
- [x] Make insurer outcome classification fail closed for every non-terminal assignment state.
- [x] Avoid the assignment-only late-arrival pass in read-only readiness/preview runs.
- [x] Extend incident/readiness evidence for non-terminal plans and phase timings.
- [ ] Run focused tests after every commit, then the full Python, Node, build, and static validation suites.
- [ ] Perform isolated production read-only probes; do not submit assignments during validation.

## Acceptance criteria

1. An unrelated pending or failed Piles request cannot block a matching filter context.
2. A matching live request continues to fence DOM acceptance until it settles.
3. A persisted `planned` attempt cannot remain after its insurer is finalized as completed.
4. A row that moves between statuses before selection is retried during the same insurer run.
5. A row that still cannot be selected becomes a terminal, diagnosable failure.
6. `completed` requires zero planned, selected, submitted, pending, conflicted, failed, or manual-action attempts.
7. Read-only probes scan every requested initial context but do not perform a redundant late-arrival pass.
8. No test or production validation clicks the portal assignment action.
