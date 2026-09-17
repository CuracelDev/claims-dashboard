# Portal audit implementation — 2026-09-17

## Evidence

- Production inspection `35220803118`: recurring Uganda `unexpected_error`,
  failed DEFMIS plans, and active Kenya/DEFMIS assignment confirmations.
- Readiness probe `35220799318`: two aged reconciliation attempts; browser probe
  blocked by occupied capacity. This did not reproduce Uganda's exception.
- Local isolated reproductions: reordered columns discovered a pile but selected
  none; an enabled Next button's click timeout returned end-of-pages.

## Implementation batches

1. Shared header-aware parsing for discovery and checkbox selection. Exact amount
   and unchanged ownership are required when matching the live DOM to scanned
   rows. Legacy layouts retain their existing fallback positions.
2. Pagination lookup/navigation failures raise `IncompleteScan`. An uncertain
   click is never retried through another selector alias. The existing full
   read-only context retry can recover; failed navigation cannot mean completion.
3. Allowlisted failure phase/type/module/line persisted in existing insurer JSON
   details and exposed by incident inspection. No exception text, locals, source
   code or portal identities are included. Initial reconciliation retains all
   matching aliases instead of letting one blank alias erase ownership evidence.

## Validation

Each committed batch has pre-commit and post-commit regression checks. Run
`npm run test:piles`, `npm run build`, and `git diff --check` for final validation.
Tests cover reordered columns, owner/amount changes, navigation and lookup
failures, non-reclicking uncertain navigation, diagnostic privacy and persistence,
and positive/conflicting ownership across aliases in either order.

## Production boundary and remaining work

No production assignments, scheduler changes, recovery writes or deployment were
performed for this implementation. No database schema change is required.
After reviewed deployment, observe a normal scheduled run. If Uganda fails,
inspect the new safe failure metadata at the deployed revision to identify its
actual exception. Local tests cannot establish that this unknown failure is fixed.

Aged submissions require positive ownership reconciliation, never blind replay.
Missing observations retain the existing complete-scan and age safeguards. These
changes do not weaken those guards or extend automatic retries without evidence.
