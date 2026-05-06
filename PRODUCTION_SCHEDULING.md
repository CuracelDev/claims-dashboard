# Piles Auto-Assignment Production Scheduling

This repository now uses the deployed dashboard server itself for scheduled `Piles Auto-Assignment` runs.

## Active production model

- Deploy application code to the production VM via `.github/workflows/deploy.yml`
- Install the runner dependencies on that VM
- Install an idempotent user cron entry that runs every 30 minutes
- Let the website manual trigger call the same server-local Python runner in production

That means:

- scheduled runs and production manual runs use the same compute
- local development manual runs still use your laptop
- GitHub Actions is **not** the 30-minute scheduler

## Scheduler entrypoint

The deployed VM runs:

```bash
./scripts/run-piles-auto-assignment.sh
```

The deploy workflow installs the cron entry through:

```bash
./scripts/install-piles-auto-assignment-cron.sh
```

## Environment variables

These values should exist in the production `.env` written by deploy:

- `DATABASE_URL`
- `BOT_CREDENTIALS_ENCRYPTION_KEY`
- `SLACK_PRISM_BOT_TOKEN`
- `SLACK_ALERTS_CHANNEL_ID`
- `CURACEL_PORTAL_BASE_URL_PRODUCTION`
- `CURACEL_PORTAL_BASE_URL_TEST`
- `CURACEL_PORTAL_ENVIRONMENT=production`
- `PILES_AUTO_ASSIGNMENT_RUNNER_BACKEND=local`
- `ALLOW_PRODUCTION_ASSIGNMENTS=true`
- `HEADLESS=true`
- `PYTHONUNBUFFERED=1`
- `SCREENSHOT_ON_ERROR=false`

Optional:

- `PILES_AUTO_ASSIGNMENT_CRON_SCHEDULE=*/30 * * * *`
- `PILES_AUTO_ASSIGNMENT_SCHEDULE_MODE=all-active`
- `PILES_AUTO_ASSIGNMENT_SCHEDULE_EXECUTE=true`
- `PILES_AUTO_ASSIGNMENT_SCHEDULE_VISIBLE=false`
- `PILES_AUTO_ASSIGNMENT_SCHEDULE_PORTAL_ENVIRONMENT=production`

## Local development

Local manual trigger stays local as long as:

- your local `.env.local` points to your local database
- there is no production remote-runner override configured

So:

- local website manual trigger => your laptop
- production website manual trigger => deployed server

## Logs and history

- Assignment outcomes, tracked pile snapshots, and activity logs are written to the database by the runner
- Full runner run history is written to `piles_auto_assignment_runner_runs`
- The frontend reads from the DB for:
  - `Recent Assignment Activity`
  - `Runner History`
