# claims-dashboard Corrections

This file records durable repo-specific corrections, PR feedback lessons, and user rules that factory agents must read before implementation or review.

## Active Corrections

No repo-specific corrections recorded yet.

## Conflict Protocol

- Read this file after `AGENTS.md` and `.factory/REPO_CONTRACT.md` and before creating an implementation-ready work package, routing implementation, or reviewing code.
- If a new Slack/Jira/PR/user direction conflicts with an active correction or repo rule, stop and report the exact conflict before editing code.
- Use this wording when reporting a conflict: `Jake added a rule/PR feedback or context that conflicts with this: <exact conflict>`.
- Do not store secrets, credentials, customer payloads, or one-off ticket status here.

## Entry Format

```markdown
## YYYY-MM-DD - <short title>

- Source: <Slack/Jira/PR/link or local artifact>
- Requested by: <name or handle>
- Applies to: <files, modules, workflows, or repo-wide>
- Correction: <durable instruction>
- Conflict check: <none found, or exact conflicting rule/context>
- Status: active
```
