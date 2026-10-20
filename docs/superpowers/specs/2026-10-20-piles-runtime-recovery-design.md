# Piles Runtime Recovery Design

## Problem

The production Piles Auto Assignment scheduler can retain an executable virtual-environment Python while losing `pip`, `site-packages`, and every installed runtime dependency. The current deployment script treats the Python executable as proof that the environment is usable, the readiness marker is not tied to runtime contents, and the hourly wrapper launches the broken interpreter without a preflight. The failure therefore occurs before runner-history evidence exists and can continue silently across every insurer.

## Outcome

Every scheduled launch must either use a verified, immutable runtime generation or fail closed with sanitized evidence. A damaged runtime must be recoverable without mutating the active generation, and a failed repair must leave the last verified generation available for rollback. Runtime repair and verification must never execute an assignment.

## Architecture

Production runtimes live under `.piles-runtime/generations/<fingerprint>-<generation-id>`. The fingerprint binds the requirements file, Python major/minor version, runtime-builder version, and browser configuration; the unique generation ID permits a damaged generation to be replaced without mutating or temporarily removing it. `.piles-runtime/current` and `.piles-runtime/previous` are atomic symlink pointers. A generation is built in a same-filesystem temporary directory, bootstraps `pip`, installs pinned dependencies and Playwright, passes import and browser probes, receives a JSON manifest, and only then becomes `current`.

A standard-library-only checker validates the configured generation and emits sanitized JSON. The schedule wrapper runs this checker before every execution. In `audit` mode it fails closed when unhealthy. In `repair` mode it invokes the atomic builder under a dedicated filesystem lock, rechecks the new generation, and only then starts the existing assignment runner. The runtime-repair lock remains independent from the assignment-cycle overlap lock.

Deployment prepares and verifies the generation before cron installation. Readiness checks the identical runtime contract before any read-only portal crawl. A manual repair workflow can rebuild and verify the runtime but is structurally unable to pass `--execute`. An independent liveness audit detects a missing recent scheduled parent even when Python never started.

## Runtime Contract

A healthy generation has all of the following:

- an executable `bin/python` whose `sys.prefix` identifies the generation as a virtual environment;
- working `python -m pip`;
- at least one existing `site-packages` directory;
- importable `psycopg2`, `requests`, `dotenv`, `playwright`, and local `piles_auto_assignment` modules;
- a JSON manifest with schema version `1`, the expected fingerprint, Python version, requirements SHA-256, creation timestamp, and browser configuration;
- a matching requirements fingerprint computed at verification time;
- an installed Playwright Chromium executable and, in full mode, a successful headless browser launch.

The checker returns `0` only when every requested check passes. Output contains paths, state names, hashes, and versions but never environment values, credentials, database URLs, insurer passwords, or tokens.

## Repair Safety

- Never install packages into `current` or `previous`.
- Build temporary generations beneath the runtime root so pointer replacement is same-filesystem and atomic.
- Hold one repair lock across build, verification, and pointer promotion.
- Recheck health after acquiring the lock so concurrent launchers reuse the first successful repair.
- On failure or termination, remove only the owned temporary directory and leave pointers unchanged.
- Keep the former current target as `previous`; do not prune generations during the initial rollout.
- Scheduled execution is forbidden until the post-repair checker passes.
- OS package installation is deployment-only; hourly self-repair may reinstall Python packages and browsers but must not run `sudo` or `apt-get`.

## Configuration

- `PILES_RUNTIME_ROOT` defaults to `<repository>/.piles-runtime`.
- `PILES_RUNTIME_REQUIREMENTS_FILE` defaults to `scripts/piles-auto-assignment-requirements.txt`.
- `PILES_RUNTIME_RECOVERY_MODE` accepts only `audit` or `repair`; production deployment writes `repair` explicitly.
- `PILES_RUNTIME_REPAIR_WAIT_SECONDS` is a bounded positive integer and defaults to `900`.
- `PILES_ASSIGNMENT_PYTHON_BIN` is derived from `.piles-runtime/current/bin/python` by deployment and cron.
- `PLAYWRIGHT_BROWSERS_PATH` remains a host-level shared browser cache.

## Observability

The checker uses stable state identifiers including `missing_python`, `not_virtualenv`, `missing_pip`, `missing_site_packages`, `missing_imports`, `manifest_missing`, `manifest_invalid`, `manifest_mismatch`, `browser_missing`, and `browser_launch_failed`. Cron logs include the active generation fingerprint and repair outcome. A read-only liveness audit treats a recent completed-empty scheduled run as healthy, detects a missing scheduled parent after 75 minutes, and distinguishes runtime/scheduler failure from a legitimate no-work result.

## Deployment and Rollback

Deployment copies code, builds a new generation, validates it in full mode, writes the environment to point at `current`, and only then installs cron. The gated repair workflow performs the same preparation and a read-only runner import check; it cannot execute assignments. Production activation requires an all-active read-only crawl before observing a normal scheduled cycle.

Rollback sets recovery mode to `audit`, atomically returns `current` to `previous`, reruns full verification, and restores the previous application revision if required. Assignment and reconciliation data are never rolled back as part of runtime recovery.

## Acceptance Criteria

- The exact production corruption—Python present while `pip` and `site-packages` are absent—is detected and recovered.
- Healthy generations perform no reinstall.
- A failed or interrupted build cannot change `current` or `previous`.
- Concurrent launchers produce one repair and never duplicate assignment execution.
- A stale marker cannot make a damaged environment healthy.
- Deploy, readiness, repair, and cron use the same checker and fingerprint contract.
- Repair and automated tests never invoke execute mode or perform an assignment.
- Missed pre-Python launches become visible within 75 minutes.
- A verified previous generation can be restored without reinstalling packages.
