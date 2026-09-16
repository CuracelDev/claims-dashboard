# Piles Completion and Reassignment Repair

## Contract

- Fresh unassigned piles are distributed at every scheduled run to active, available configured owners. The 09:00 setting does not gate fresh assignment.
- Reassignment may begin at `active_from_time` in the configured runner timezone. `active_to_time` closes that window; overnight windows remain supported. Historical `shift_grace_minutes` is retained as data, not an additional hidden delay.
- Healthy work has no whole-run deadline. Slow operations must retain ownership and make progress; one blocked insurer must not permanently strand other queued insurers.
- Submitted work is never blindly retried. Every discovered eligible pile requires assignment evidence or an explicit safe disposition.
- Local tests use isolated fake adapters/databases. No production assignment, configuration, cron, or database mutation is authorized by this implementation validation.

## Small-commit sequence

1. [x] Separate fresh eligibility from reassignment eligibility; pin morning, timezone, overnight, and no-bypass regressions.
2. [x] Clarify timing controls and remove obsolete grace editing without destructive schema changes.
3. [x] Keep reconciliation ownership live, remove redundant reads, and bound database operations rather than entire runs.
4. [x] Preserve isolated insurer workers and supervise stallable database/browser operations so one blocked operation cannot trap unrelated queued work.
5. [x] Audit queue drainage, recovery fencing, parent finalization, and enforce complete per-pile planning.
6. [x] Run exhaustive local regressions, build/static checks, and document rollout/rollback and remaining production verification.

## Validation log

- Baseline: 219 focused Python tests passed on current `origin/main` (`715462ab`).
- Red test: pre-09:00 actual workflow produced zero applied plans; corrected assertion failed before implementation.
- First regression run: 436 Python and 115 Node tests passed after eligibility repair. Additional boundary tests are required before committing this slice.
- Final committed-tree validation: 445 Python tests, 116 Node tests, Python bytecode compilation, Git integrity/diff checks, and the Next.js production build passed.
- A final safety re-review added server-enforced read-only PostgreSQL probe sessions and a no-write tracked-observation regression after catching an optimization-path guard bypass locally. Focused read-only and dispatcher acceptance tests passed; the full suite is rerun after this final guard commit.
- Production remains unchanged. Local passing tests do not claim that live assignment has been verified.
