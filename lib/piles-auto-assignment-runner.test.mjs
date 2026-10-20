import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

import { buildRunnerArgs, startDetachedRunner, validateRunRequest } from './piles-auto-assignment-runner.mjs';

test('validation accepts one insurer and normalizes filters', () => {
  const request = validateRunRequest({ insurer_name: ' DEFMIS ', month: 'All', year: '2026' });
  assert.equal(request.insurerName, 'DEFMIS');
  assert.deepEqual(request.months, ['All']);
});

test('argv uses separate values and adopts the pre-created run id', () => {
  const request = validateRunRequest({ run_all: true, months: ['Jan', 'Feb'], finalize_assignments: false });
  const args = buildRunnerArgs(request, { runId: 'run-123', backend: 'local' });
  assert.deepEqual(args.slice(0, 6), ['--run-id', 'run-123', '--run-source', 'manual', '--invocation-backend', 'local']);
  assert.ok(args.includes('--all-active'));
  assert.ok(!args.includes('--execute'));
  assert.ok(args.includes('--adopt-preview-run'));
});

test('only API preview argv adopts a durable preview parent', () => {
  const preview = validateRunRequest({ insurer_name: 'DEFMIS', finalize_assignments: false });
  const execute = validateRunRequest({ insurer_name: 'DEFMIS', finalize_assignments: true });
  assert.ok(buildRunnerArgs(preview, { runId: 'preview-parent', source: 'manual' }).includes('--adopt-preview-run'));
  assert.ok(!buildRunnerArgs(execute, { runId: 'execute-parent', source: 'manual' }).includes('--adopt-preview-run'));
});

test('detached start returns without waiting for close', () => {
  const calls = [];
  const child = { unref: () => calls.push('unref'), once: () => child };
  const spawn = (...args) => { calls.push(args); return child; };
  const result = startDetachedRunner({ pythonBin: 'python3', scriptPath: 'runner.py', args: [], cwd: '/app', env: {} }, spawn);
  assert.equal(result.status, 'queued');
  assert.deepEqual(calls.at(-1), 'unref');
  assert.equal(calls[0][2].stdio, 'ignore');
  assert.equal(calls[0][2].detached, true);
});

test('synchronous spawn failure is reported', () => {
  assert.throws(
    () => startDetachedRunner({ pythonBin: 'missing', scriptPath: 'runner.py', args: [] }, () => { throw new Error('ENOENT'); }),
    /ENOENT/,
  );
});

test('trusted source options are preserved and unsupported sources fail closed', () => {
  const request = validateRunRequest({ run_all: true });
  for (const source of ['manual', 'schedule', 'readiness', 'recovery']) {
    assert.equal(buildRunnerArgs(request, { runId: 'run', source })[3], source);
  }
  for (const source of ['', 'unknown', 'SCHEDULE', null, '--execute']) {
    assert.throws(() => buildRunnerArgs(request, { runId: 'run', source }), /source/i);
  }
});

test('request JSON and environment cannot relabel a manual invocation', (t) => {
  const original = process.env.PILES_AUTO_ASSIGNMENT_RUN_SOURCE;
  t.after(() => {
    if (original === undefined) delete process.env.PILES_AUTO_ASSIGNMENT_RUN_SOURCE;
    else process.env.PILES_AUTO_ASSIGNMENT_RUN_SOURCE = original;
  });
  for (const source of ['schedule', 'recovery', 'readiness']) {
    process.env.PILES_AUTO_ASSIGNMENT_RUN_SOURCE = source;
    const request = validateRunRequest({ run_all: true, source, run_source: source, runSource: source });
    assert.equal(buildRunnerArgs(request, { runId: 'run', source: 'manual' })[3], 'manual');
  }
});

function shellFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "piles source's "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'bin'));
  for (const name of ['run-piles-auto-assignment.sh', 'install-piles-auto-assignment-cron.sh', 'rotate-piles-auto-assignment-log.sh']) {
    copyFileSync(new URL(`../scripts/${name}`, import.meta.url), path.join(root, 'scripts', name));
    chmodSync(path.join(root, 'scripts', name), 0o755);
  }
  const python = path.join(root, 'bin', 'python');
  writeFileSync(python, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2))); if (process.env.PYTHON_FAILURE_STATUS) process.exit(Number(process.env.PYTHON_FAILURE_STATUS));\n`);
  chmodSync(python, 0o755);
  const crontab = path.join(root, 'bin', 'crontab');
  writeFileSync(crontab, `#!${process.execPath}\nconst fs = require('node:fs'); if (process.argv[2] === '-l') process.stdout.write(fs.readFileSync(process.env.CRON_FILE)); else fs.copyFileSync(process.argv[2], process.env.CRON_FILE);\n`);
  chmodSync(crontab, 0o755);
  const health = path.join(root, 'bin', 'runtime-health');
  writeFileSync(health, `#!/bin/sh
if [ -f "$RUNTIME_REPAIRED_FILE" ]; then exit 0; fi
exit "\${RUNTIME_HEALTH_STATUS:-0}"
`);
  chmodSync(health, 0o755);
  const prepare = path.join(root, 'bin', 'runtime-prepare');
  writeFileSync(prepare, `#!/bin/sh
printf '%s\n' "$*" >> "$RUNTIME_PREPARE_LOG"
if [ "\${RUNTIME_PREPARE_STATUS:-0}" -ne 0 ]; then exit "$RUNTIME_PREPARE_STATUS"; fi
: > "$RUNTIME_REPAIRED_FILE"
`);
  chmodSync(prepare, 0o755);
  const env = {
    PATH: `${path.join(root, 'bin')}:/usr/bin:/bin`,
    PILES_ASSIGNMENT_PYTHON_BIN: python,
    ARGV_FILE: path.join(root, 'argv.json'), CRON_FILE: path.join(root, 'crontab'),
    PILES_AUTO_ASSIGNMENT_ENV_FILE: path.join(root, "config's 50%.env"),
    PILES_AUTO_ASSIGNMENT_CRON_LOG_DIR: path.join(root, "log's 50%"),
    PILES_AUTO_ASSIGNMENT_RUN_SOURCE: 'recovery',
    PILES_RUNTIME_CONTROL_PYTHON: '/bin/sh',
    PILES_RUNTIME_HEALTH_SCRIPT: health,
    PILES_RUNTIME_PREPARE_SCRIPT: prepare,
    PILES_RUNTIME_RECOVERY_MODE: 'audit',
    RUNTIME_HEALTH_STATUS: '0',
    RUNTIME_REPAIRED_FILE: path.join(root, 'runtime-repaired'),
    RUNTIME_PREPARE_LOG: path.join(root, 'runtime-prepare.log'),
  };
  writeFileSync(env.PILES_AUTO_ASSIGNMENT_ENV_FILE, 'PILES_AUTO_ASSIGNMENT_RUN_SOURCE=readiness\n');
  writeFileSync(env.CRON_FILE, '17 * * * * /bin/true # unrelated\n');
  return { root, env, run: (script, args = []) => spawnSync('/bin/sh', [path.join(root, 'scripts', script), ...args], { env, encoding: 'utf8' }) };
}

test('schedule wrapper emits one schedule source despite env or argv override and safely quotes insurer', (t) => {
  const fixture = shellFixture(t);
  Object.assign(fixture.env, {
    PILES_AUTO_ASSIGNMENT_SCHEDULE_MODE: 'one-insurer',
    PILES_AUTO_ASSIGNMENT_SCHEDULE_INSURER: "Insurer's name; $(false)",
    PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY: '',
  });
  const result = fixture.run('run-piles-auto-assignment.sh', ['--run-source', 'manual']);
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(readFileSync(fixture.env.ARGV_FILE));
  assert.equal(args.filter((arg) => arg === '--run-source').length, 1);
  assert.equal(args[args.indexOf('--run-source') + 1], 'schedule');
  assert.equal(args[args.indexOf('--insurer') + 1], "Insurer's name; $(false)");
});

test('schedule wrapper fails closed in audit mode before invoking an unhealthy runtime', (t) => {
  const fixture = shellFixture(t);
  Object.assign(fixture.env, { RUNTIME_HEALTH_STATUS: '20', PILES_RUNTIME_RECOVERY_MODE: 'audit' });
  const result = fixture.run('run-piles-auto-assignment.sh');
  assert.equal(result.status, 20, result.stderr);
  assert.equal(existsSync(fixture.env.ARGV_FILE), false);
  assert.match(result.stderr, /unhealthy.*audit mode/i);
});

test('schedule wrapper repairs then rechecks before invoking the runner', (t) => {
  const fixture = shellFixture(t);
  Object.assign(fixture.env, { RUNTIME_HEALTH_STATUS: '20', PILES_RUNTIME_RECOVERY_MODE: 'repair' });
  const result = fixture.run('run-piles-auto-assignment.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(fixture.env.RUNTIME_REPAIRED_FILE), true);
  assert.equal(existsSync(fixture.env.ARGV_FILE), true);
  assert.equal(readFileSync(fixture.env.RUNTIME_PREPARE_LOG, 'utf8').trim(), '');
});

test('schedule wrapper never launches after repair failure', (t) => {
  const fixture = shellFixture(t);
  Object.assign(fixture.env, {
    RUNTIME_HEALTH_STATUS: '20',
    RUNTIME_PREPARE_STATUS: '42',
    PILES_RUNTIME_RECOVERY_MODE: 'repair',
  });
  const result = fixture.run('run-piles-auto-assignment.sh');
  assert.equal(result.status, 42, result.stderr);
  assert.equal(existsSync(fixture.env.ARGV_FILE), false);
});

test('schedule wrapper rejects unknown recovery modes before health or runner execution', (t) => {
  const fixture = shellFixture(t);
  fixture.env.PILES_RUNTIME_RECOVERY_MODE = 'automatic';
  const result = fixture.run('run-piles-auto-assignment.sh');
  assert.equal(result.status, 2, result.stderr);
  assert.equal(existsSync(fixture.env.ARGV_FILE), false);
  assert.equal(existsSync(fixture.env.RUNTIME_PREPARE_LOG), false);
});

test('cron reinstall preserves unrelated jobs and executes one safely quoted schedule command', (t) => {
  const fixture = shellFixture(t);
  for (let i = 0; i < 2; i++) {
    const result = fixture.run('install-piles-auto-assignment-cron.sh');
    assert.equal(result.status, 0, result.stderr);
  }
  const entries = readFileSync(fixture.env.CRON_FILE, 'utf8').trim().split('\n');
  assert.equal(entries.length, 2);
  assert.equal(entries[0], '17 * * * * /bin/true # unrelated');
  const entry = entries[1];
  assert.ok(entry.endsWith('# piles-auto-assignment'));
  assert.ok(entry.includes('--run-source schedule'));
  // Cron treats unescaped percent as stdin/newlines, even inside shell quotes.
  assert.doesNotMatch(entry, /(?<!\\)%/);
  const command = entry.split(' ').slice(5).join(' ').replaceAll('\\%', '%');
  const result = spawnSync('/bin/sh', ['-c', command], { env: fixture.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(readFileSync(fixture.env.ARGV_FILE));
  assert.equal(args[args.indexOf('--run-source') + 1], 'schedule');
});

test('cron command rotates an oversized log and retains a bounded history', (t) => {
  const fixture = shellFixture(t);
  Object.assign(fixture.env, {
    PILES_AUTO_ASSIGNMENT_CRON_LOG_MAX_BYTES: '10',
    PILES_AUTO_ASSIGNMENT_CRON_LOG_RETAIN: '3',
  });
  mkdirSync(fixture.env.PILES_AUTO_ASSIGNMENT_CRON_LOG_DIR, { recursive: true });
  const log = path.join(fixture.env.PILES_AUTO_ASSIGNMENT_CRON_LOG_DIR, 'piles-auto-assignment-cron.log');
  writeFileSync(log, 'this log is larger than ten bytes\n');
  const install = fixture.run('install-piles-auto-assignment-cron.sh');
  assert.equal(install.status, 0, install.stderr);
  const entry = readFileSync(fixture.env.CRON_FILE, 'utf8').trim().split('\n').at(-1);
  const command = entry.split(' ').slice(5).join(' ').replaceAll('\\%', '%');
  const run = spawnSync('/bin/sh', ['-c', command], { env: fixture.env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(`${log}.1`, 'utf8'), 'this log is larger than ten bytes\n');
  assert.match(readFileSync(log, 'utf8'), /Starting Piles Auto-Assignment schedule/);
  assert.equal(existsSync(`${log}.4`), false);
});

test('runtime incident probe reports scheduler health without exposing cron commands or logs', () => {
  const config = workflow('piles-runtime-incident-probe');
  const step = config.jobs.probe.steps.find((item) => item.name === 'Inspect bounded production runtime evidence');
  assert.ok(step);
  assert.equal(config.permissions.contents, 'read');
  assert.equal(config.concurrency.group, 'piles-production-host');
  assert.equal(config.concurrency['cancel-in-progress'], false);

  const script = step.with.script;
  for (const field of [
    'cron_service_active', 'cron_service_enabled', 'cron_daemon_processes',
    'managed_cron_entries', 'hourly_managed_cron_entries',
    'schedule_configured', 'runner_wrapper_executable', 'python_runtime_executable',
    'python_module_psycopg2', 'python_module_requests', 'python_module_dotenv',
    'python_module_playwright', 'python_module_piles_auto_assignment',
    'python_is_virtualenv', 'python_pip_available', 'runtime_expected_path_configured',
    'runtime_manifest_exists', 'runtime_manifest_age_seconds', 'runtime_health_check_passed',
    'runtime_pyvenv_config_exists', 'runtime_site_packages_dirs',
    'runtime_installed_distributions', 'runtime_site_packages_mtime_epoch',
    'runtime_bin_mtime_epoch',
    'cron_log_exists', 'cron_log_age_seconds', 'cron_log_size_bytes',
    'cron_start_markers_72h', 'cron_tracebacks_total', 'cron_command_not_found_total',
    'cron_permission_errors_total', 'cron_journal_invocations_72h',
    'cron_tracebacks_72h', 'cron_runner_failures_72h', 'cron_runtime_errors_72h',
    'cron_operational_errors_72h', 'cron_import_errors_72h',
    'cron_file_not_found_errors_72h', 'cron_playwright_errors_72h',
    'cron_configuration_errors_72h',
    'host_boot_epoch', 'root_filesystem_use_percent',
  ]) {
    assert.match(script, new RegExp(`['\"]?${field}\\|`), `missing sanitized field ${field}`);
  }

  assert.match(script, /crontab -l/);
  assert.match(script, /journalctl/);
  assert.match(script, /stat/);
  assert.match(script, /substr\(\$0,2,19\) >= cutoff/);
  assert.doesNotMatch(script, /(?:cat|tail|head|less|more)\s+[^\n]*piles-auto-assignment-cron[.]log/);
  assert.doesNotMatch(script, /pm2 logs/);
  assert.match(script, /piles_runtime_health[.]py/);
  assert.match(script, /PILES_RUNTIME_ROOT/);
  assert.match(script, /current\/bin\/python/);
  assert.doesNotMatch(script, /[.]venv-piles-auto-assignment/);
  assert.doesNotMatch(script, /^printf\s+['\"]%s[^\n]*\$cron_lines/m);
  assert.doesNotMatch(script, /^printf\s+['\"]%s[^\n]*\$cron_log/m);
  assert.doesNotMatch(script, /echo\s+['\"]?\$(?:cron_lines|cron_log)/);
  assert.doesNotMatch(script, /--execute|--require-execution/);
});

function workflow(name) {
  const result = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(STDIN.read, aliases: true))'], {
    input: readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  for (const job of Object.values(config.jobs)) {
    for (const step of job.steps) {
      if (!step.with?.script) continue;
      const syntax = spawnSync('/bin/sh', ['-n'], {
        input: step.with.script.replace(/\$\{\{[^}]+\}\}/g, 'fixture'), encoding: 'utf8',
      });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
  }
  return config;
}

test('readiness workflow runs both scopes read-only with a trusted readiness source', (t) => {
  const fixture = shellFixture(t);
  const config = workflow('piles-production-readiness');
  const step = config.jobs.readiness.steps[0];
  const inputs = config.on?.workflow_dispatch?.inputs || config.true.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), ['insurer', 'scope']);
  assert.equal(step.with.envs, 'PROBE_SCOPE,PROBE_INSURER');
  // Execute the actual probe branch; omit only host setup and database audit commands.
  const probeScript = step.with.script.slice(step.with.script.indexOf('probe_status=0'));
  const script = `readiness_status=0\n${probeScript}`;
  for (const scope of ['all-active', 'one-insurer']) {
    const result = spawnSync('/bin/sh', ['-c', script], {
      env: { ...fixture.env, PROBE_SCOPE: scope, PROBE_INSURER: "Insurer's name" }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(readFileSync(fixture.env.ARGV_FILE));
    assert.equal(args[args.indexOf('--run-source') + 1], 'readiness');
    assert.ok(args.includes('--read-only'));
    assert.ok(!args.includes('--execute'));
  }
});

test('readiness workflow completes the portal probe before reporting an incident-gate failure', (t) => {
  const fixture = shellFixture(t);
  const config = workflow('piles-production-readiness');
  const step = config.jobs.readiness.steps[0];
  const fakeNode = path.join(fixture.root, 'bin', 'node');
  writeFileSync(fakeNode, `#!/bin/sh
case "$*" in
  *audit-piles-auto-assignment-readiness*) exit 7 ;;
  *) exit 0 ;;
esac
`);
  chmodSync(fakeNode, 0o755);
  writeFileSync(path.join(fixture.root, '.env'), 'PILES_ASSIGNMENT_PROVENANCE_V2=shadow\nPILES_EXECUTION_LEDGER_ENABLED=true\n');
  const quotedRoot = `'${fixture.root.replaceAll("'", "'\\''")}'`;
  const script = step.with.script.replace('cd ~/claims-dashboard', `cd ${quotedRoot}`);
  const result = spawnSync('/bin/sh', ['-c', script], {
    env: { ...fixture.env, PROBE_SCOPE: 'one-insurer', PROBE_INSURER: 'DEFMIS' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stdout, /Portal readiness probe completed successfully\./);
  assert.match(result.stderr, /Runtime readiness audit failed with status 7\./);
  assert.equal(existsSync(fixture.env.ARGV_FILE), true, 'portal probe did not run');
  const args = JSON.parse(readFileSync(fixture.env.ARGV_FILE));
  assert.equal(args[args.indexOf('--run-source') + 1], 'readiness');
  assert.ok(args.includes('--read-only'));
  assert.ok(!args.includes('--execute'));
});

test('readiness workflow keeps schema failure fail-fast and gives portal failure precedence over incident findings', (t) => {
  for (const scenario of [
    { dbStatus: '9', readinessStatus: '0', probeStatus: '', expected: 9, probeRuns: false },
    { dbStatus: '0', readinessStatus: '7', probeStatus: '5', expected: 5, probeRuns: true },
  ]) {
    const fixture = shellFixture(t);
    const config = workflow('piles-production-readiness');
    const step = config.jobs.readiness.steps[0];
    const fakeNode = path.join(fixture.root, 'bin', 'node');
    writeFileSync(fakeNode, `#!/bin/sh
case "$*" in
  *db-schema-audit*) exit "\${DB_SCHEMA_STATUS:-0}" ;;
  *audit-piles-auto-assignment-readiness*) exit "\${READINESS_STATUS:-0}" ;;
  *) exit 0 ;;
esac
`);
    chmodSync(fakeNode, 0o755);
    writeFileSync(path.join(fixture.root, '.env'), 'PILES_ASSIGNMENT_PROVENANCE_V2=shadow\nPILES_EXECUTION_LEDGER_ENABLED=true\n');
    const quotedRoot = `'${fixture.root.replaceAll("'", "'\\''")}'`;
    const script = step.with.script.replace('cd ~/claims-dashboard', `cd ${quotedRoot}`);
    const result = spawnSync('/bin/sh', ['-c', script], {
      env: {
        ...fixture.env,
        PROBE_SCOPE: 'one-insurer',
        PROBE_INSURER: 'DEFMIS',
        DB_SCHEMA_STATUS: scenario.dbStatus,
        READINESS_STATUS: scenario.readinessStatus,
        PYTHON_FAILURE_STATUS: scenario.probeStatus,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, scenario.expected, result.stderr);
    assert.equal(existsSync(fixture.env.ARGV_FILE), scenario.probeRuns);
    if (scenario.probeRuns) {
      assert.match(result.stderr, /Portal readiness probe failed with status 5\./);
    }
  }
});

test('production canary is one-insurer-only, explicitly confirmed, and process-locally authorized', (t) => {
  const config = workflow('piles-production-canary');
  const inputs = config.on?.workflow_dispatch?.inputs || config.true.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), ['confirmation', 'insurer']);
  assert.equal(config.concurrency.group, 'piles-production-host');
  assert.equal(config.concurrency['cancel-in-progress'], false);
  assert.equal(config.permissions.contents, 'read');

  const steps = config.jobs.canary.steps;
  const validator = steps.find((step) => step.name === 'Validate exact canary approval');
  const runner = steps.find((step) => step.name === 'Run one production insurer canary');
  assert.ok(validator);
  assert.ok(runner);
  assert.match(validator.run, /RUN_ONE_INSURER_PRODUCTION_CANARY/);
  assert.match(validator.run, /Invalid production canary input/);
  assert.equal(runner.with.envs, 'CANARY_INSURER');
  assert.match(runner.with.script, /crontab -l/);
  assert.match(runner.with.script, /ps -eo pid=,comm=,args=/);
  assert.match(runner.with.script, /active execute process/);
  assert.doesNotMatch(runner.with.script, /pgrep -f/);
  assert.match(runner.with.script, /ALLOW_PRODUCTION_ASSIGNMENTS=true/);
  assert.match(runner.with.script, /--insurer "\$CANARY_INSURER"/);
  assert.match(runner.with.script, /--portal-environment production/);
  assert.match(runner.with.script, /--run-source manual/);
  assert.match(runner.with.script, /--execute/);
  assert.match(runner.with.script, /--require-execution/);
  assert.match(runner.with.script, /--read-only/);
  assert.doesNotMatch(runner.with.script, /--all-active/);
  assert.doesNotMatch(runner.with.script, /ALLOW_PRODUCTION_ASSIGNMENTS=(true|false).*\.env/);

  const root = mkdtempSync(path.join(tmpdir(), 'piles-canary-validation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [index, scenario] of [
    [{ insurer: 'Jubilee Uganda', confirmation: 'RUN_ONE_INSURER_PRODUCTION_CANARY' }, 0],
    [{ insurer: 'Jubilee Uganda', confirmation: 'wrong' }, 1],
    [{ insurer: 'Jubilee Uganda\nINJECTED=true', confirmation: 'RUN_ONE_INSURER_PRODUCTION_CANARY' }, 1],
  ].entries()) {
    const [inputs, expectedStatus] = scenario;
    const eventPath = path.join(root, `event-${index}.json`);
    const envPath = path.join(root, `env-${index}`);
    writeFileSync(eventPath, JSON.stringify({ inputs }));
    const result = spawnSync('/bin/bash', ['-c', validator.run], {
      env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_ENV: envPath },
      encoding: 'utf8',
    });
    assert.equal(result.status, expectedStatus, result.stderr);
    if (expectedStatus === 0) {
      assert.equal(readFileSync(envPath, 'utf8'), 'CANARY_INSURER=Jubilee Uganda\n');
    } else {
      assert.match(result.stderr, /Invalid production canary input or confirmation\./);
      assert.equal(existsSync(envPath), false);
    }
  }
});

test('deployment validates and writes default-disabled flags after schema staging and audit', (t) => {
  const fixture = shellFixture(t);
  const steps = workflow('deploy').jobs.deploy.steps;
  const index = (name) => steps.findIndex((step) => step.name === name);
  for (const name of ['Stage database migration files', 'Apply and audit database schema', 'Rsync files to server', 'Restart App via SSH']) {
    assert.ok(index(name) >= 0, `Missing deployment stage: ${name}`);
  }
  assert.ok(index('Stage database migration files') < index('Apply and audit database schema'));
  assert.ok(index('Apply and audit database schema') < index('Rsync files to server'));
  assert.ok(index('Rsync files to server') < index('Restart App via SSH'));
  const step = steps[index('Restart App via SSH')];
  assert.equal(step.env?.PILES_AUTO_ASSIGNMENT_DISPATCHER_V2, '${{ vars.PILES_AUTO_ASSIGNMENT_DISPATCHER_V2 }}');
  assert.equal(step.env?.PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY, '${{ vars.PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY }}');
  assert.equal(step.env?.PILES_ASSIGNMENT_PROVENANCE_V2, '${{ vars.PILES_ASSIGNMENT_PROVENANCE_V2 }}');
  assert.ok(step.with.envs.split(',').includes('PILES_AUTO_ASSIGNMENT_DISPATCHER_V2'));
  assert.ok(step.with.envs.split(',').includes('PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY'));
  assert.ok(step.with.envs.split(',').includes('PILES_ASSIGNMENT_PROVENANCE_V2'));
  const envWrite = step.with.script.indexOf('cat <<EOF > .env');
  const envLoad = step.with.script.indexOf('. ./.env', envWrite);
  const cronInstall = step.with.script.indexOf('./scripts/install-piles-auto-assignment-cron.sh');
  assert.ok(envWrite >= 0 && envLoad > envWrite && cronInstall > envLoad,
    'deployment must load the just-written environment before installing cron');
  const script = step.with.script.split('cd ~/claims-dashboard\n')[1].split('export PATH=')[0]
    .replace(/\$\{\{[^}]+\}\}/g, '');
  for (const [flag, concurrency, provenance, expected] of [
    ['', '', '', null],
    ['false', '1', 'shadow', ['false', '1', 'shadow']],
    ['true', '2', 'enabled', ['true', '2', 'enabled']],
    ['yes', '1', 'enabled', null],
    ['false', '3', 'enabled', null],
    ['false', '01', 'enabled', null],
    ['false', '1', 'unknown', null],
  ]) {
    const target = path.join(fixture.root, '.env');
    writeFileSync(target, 'untouched\n');
    const result = spawnSync('/bin/sh', ['-c', script], {
      cwd: fixture.root, env: {
        ...fixture.env,
        PILES_AUTO_ASSIGNMENT_DISPATCHER_V2: flag,
        PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY: concurrency,
        PILES_ASSIGNMENT_PROVENANCE_V2: provenance,
      }, encoding: 'utf8',
    });
    const output = readFileSync(target, 'utf8');
    if (!expected) {
      assert.notEqual(result.status, 0);
      assert.equal(output, 'untouched\n');
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.ok(output.includes(`PILES_AUTO_ASSIGNMENT_DISPATCHER_V2="${expected[0]}"`));
      assert.ok(output.includes(`PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY="${expected[1]}"`));
      assert.ok(output.includes(`PILES_ASSIGNMENT_PROVENANCE_V2="${expected[2]}"`));
    }
  }
});

test('deployment prepares and fully verifies the atomic runtime before installing cron', () => {
  const config = workflow('deploy');
  const copy = config.jobs.deploy.steps.find((candidate) => candidate.name === 'Rsync files to server');
  assert.ok(copy.with.source.split(',').includes('lib'), 'shared runtime modules must be deployed');
  const step = config.jobs.deploy.steps.find((candidate) => candidate.name === 'Restart App via SSH');
  const script = step.with.script;
  assert.match(script, /PILES_RUNTIME_RECOVERY_MODE="repair"/);
  assert.match(script, /PILES_ASSIGNMENT_PYTHON_BIN="\$HOME\/claims-dashboard\/[.]piles-runtime\/current\/bin\/python"/);
  const prepare = script.indexOf('prepare-piles-production-runtime.sh');
  const verify = script.indexOf('piles_runtime_health.py', prepare);
  const cron = script.indexOf('install-piles-auto-assignment-cron.sh');
  assert.ok(prepare >= 0 && verify > prepare && cron > verify);
  assert.match(script.slice(verify, cron), /--mode full/);
  assert.match(script, /chmod \+x[^\n]*rotate-piles-auto-assignment-log[.]sh/);
});

test('independent liveness workflow audits at 17 minutes past each hour without mutation', () => {
  const config = workflow('piles-schedule-liveness');
  const schedules = config.on?.schedule || config.true.schedule;
  assert.equal(schedules[0].cron, '17 * * * *');
  const script = config.jobs.audit.steps[0].with.script;
  assert.match(script, /audit-piles-schedule-liveness[.]mjs/);
  assert.match(script, /--threshold-minutes 75/);
  assert.match(script, /--state-file/);
  assert.doesNotMatch(script, /--execute|update\s|delete\s|insert\s/i);
});

test('readiness verifies the full runtime before its read-only portal crawl', () => {
  const config = workflow('piles-production-readiness');
  const script = config.jobs.readiness.steps[0].with.script;
  const verify = script.indexOf('piles_runtime_health.py');
  const crawl = script.indexOf('piles_auto_assignment_runner.py');
  assert.ok(verify >= 0 && crawl > verify);
  assert.match(script.slice(verify, crawl), /--mode full/);
  assert.match(script, /--read-only/);
  assert.doesNotMatch(script, /--execute/);
});

test('runtime repair workflow is approval-gated, exact-confirmed, and cannot assign', () => {
  const config = workflow('piles-runtime-repair');
  const inputs = config.on?.workflow_dispatch?.inputs || config.true.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ['confirmation']);
  assert.equal(config.jobs.repair.environment, 'production');
  const step = config.jobs.repair.steps[0];
  assert.equal(step.with.envs, 'REPAIR_CONFIRMATION');
  assert.match(step.with.script, /REPAIR PILES RUNTIME/);
  assert.match(step.with.script, /prepare-piles-production-runtime.sh/);
  assert.match(step.with.script, /piles_runtime_health.py/);
  assert.match(step.with.script, /--mode full/);
  assert.doesNotMatch(step.with.script, /piles_auto_assignment_runner[.]py|--execute/);
});

function productionRuntimeFixture(t, { existingVenv = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'piles production runtime '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const venv = path.join(root, '.venv-piles-auto-assignment');
  mkdirSync(bin);
  const commandLog = path.join(root, 'commands.log');
  const aptAttempts = path.join(root, 'apt-attempts');
  const systemDepsReady = path.join(root, 'system-deps-ready');
  const runtimeReady = path.join(root, 'runtime-ready');
  const fakePython = path.join(bin, 'python3');
  writeFileSync(fakePython, `#!/bin/sh
set -eu
printf 'python %s\\n' "$*" >> "$COMMAND_LOG"
if [ "\${1:-}" = "-m" ] && [ "\${2:-}" = "venv" ]; then
  mkdir -p "$3/bin"
  cp "$0" "$3/bin/python"
  chmod +x "$3/bin/python"
fi
if [ "\${1:-}" = "-m" ] && [ "\${2:-}" = "playwright" ] && [ "\${4:-}" = "--with-deps" ]; then
  if [ "\${FAIL_PLAYWRIGHT_DEPS:-false}" = "true" ]; then
    exit "\${PLAYWRIGHT_DEPS_FAILURE_STATUS:-41}"
  fi
  : > "$SYSTEM_DEPS_READY"
fi
if [ "\${1:-}" = "-c" ]; then
  [ -f "$SYSTEM_DEPS_READY" ]
fi
`);
  chmodSync(fakePython, 0o755);
  for (const [name, body] of [
    ['sudo', 'exec "$@"'],
    ['npm', 'printf \'npm %s\\n\' "$*" >> "$COMMAND_LOG"'],
    ['apt-get', `count=0
[ ! -f "$APT_ATTEMPTS" ] || count=$(cat "$APT_ATTEMPTS")
count=$((count + 1))
printf '%s' "$count" > "$APT_ATTEMPTS"
printf 'apt-get %s\\n' "$*" >> "$COMMAND_LOG"
if [ "$count" -eq 1 ]; then
  echo 'E: Could not get lock /var/lib/apt/lists/lock.' >&2
  exit 100
fi`],
  ]) {
    const target = path.join(bin, name);
    writeFileSync(target, `#!/bin/sh\nset -eu\n${body}\n`);
    chmodSync(target, 0o755);
  }
  if (existingVenv) {
    mkdirSync(path.join(venv, 'bin'), { recursive: true });
    copyFileSync(fakePython, path.join(venv, 'bin', 'python'));
    chmodSync(path.join(venv, 'bin', 'python'), 0o755);
    writeFileSync(systemDepsReady, 'ready\n');
  }
  writeFileSync(path.join(root, 'requirements.txt'), 'playwright==1.54.0\n');
  return {
    root,
    commandLog,
    aptAttempts,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      COMMAND_LOG: commandLog,
      APT_ATTEMPTS: aptAttempts,
      SYSTEM_DEPS_READY: systemDepsReady,
      PILES_RUNTIME_VENV_DIR: venv,
      PILES_RUNTIME_REQUIREMENTS_FILE: path.join(root, 'requirements.txt'),
      PILES_RUNTIME_READY_MARKER: runtimeReady,
      PILES_RUNTIME_RETRY_DELAY_SECONDS: '0',
      PILES_RUNTIME_MAX_ATTEMPTS: '3',
    },
  };
}

test('privileged OS package repair is explicit and deployment-only', () => {
  const source = readFileSync(new URL('../scripts/prepare-piles-production-runtime.sh', import.meta.url), 'utf8');
  const scheduleWrapper = readFileSync(new URL('../scripts/run-piles-auto-assignment.sh', import.meta.url), 'utf8');
  assert.match(source, /INSTALL_OS_DEPS=\$\{PILES_RUNTIME_INSTALL_OS_DEPS:-false\}/);
  assert.match(source, /SUDO_BIN=\$\{PILES_RUNTIME_SUDO_BIN:-\/usr\/bin\/sudo\}/);
  assert.match(source, /if \[ "\$INSTALL_OS_DEPS" = true \]; then[\s\S]+"\$SUDO_BIN" -n \/usr\/bin\/apt-get update[\s\S]+"\$SUDO_BIN" -n \/usr\/bin\/apt-get install -y python3-venv/);
  assert.doesNotMatch(scheduleWrapper, /PILES_RUNTIME_INSTALL_OS_DEPS=true/);
  assert.match(source, /-m ensurepip --upgrade/);
});

test('runtime builder uses manifest verification instead of a stale readiness marker', () => {
  const source = readFileSync(new URL('../scripts/prepare-piles-production-runtime.sh', import.meta.url), 'utf8');
  assert.match(source, /piles_runtime_health[.]py/);
  assert.match(source, /write_runtime_manifest/);
  assert.doesNotMatch(source, /PILES_RUNTIME_READY_MARKER|[.]piles-runtime-ready/);
});

test('runtime builder prepares an isolated generation before atomic pointer promotion', () => {
  const source = readFileSync(new URL('../scripts/prepare-piles-production-runtime.sh', import.meta.url), 'utf8');
  const build = source.indexOf('TEMP_GENERATION=');
  const verify = source.lastIndexOf('verify_generation "$FINAL_GENERATION"');
  const promote = source.lastIndexOf('atomic_symlink "generations/$generation_id" "$CURRENT_LINK"');
  assert.ok(build >= 0 && verify > build && promote > verify);
});

test('runtime builder suppresses dependency output while preserving failure status', () => {
  const source = readFileSync(new URL('../scripts/prepare-piles-production-runtime.sh', import.meta.url), 'utf8');
  assert.match(source, /status=0\n\s+"\$@" >"\$COMMAND_OUTPUT" 2>&1 \|\| status=\$\?/);
  assert.match(source, /subprocess output suppressed/);
});

test('manual API passes an internal manual source to argv, remote payload, and persistence', () => {
  const source = readFileSync(new URL('../app/api/tools/piles-auto-assignment/run/route.js', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('route.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(ast.parseDiagnostics.length, 0);
  const calls = [];
  const sources = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'buildRunnerArgs') calls.push(node);
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'run_source') sources.push(node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(calls.length, 1);
  const options = calls[0].arguments[1];
  assert.ok(ts.isObjectLiteralExpression(options));
  const sourceOption = options.properties.find((property) => property.name?.getText(ast) === 'source');
  assert.ok(sourceOption && ts.isStringLiteral(sourceOption.initializer));
  assert.equal(sourceOption.initializer.text, 'manual');
  assert.equal(sources.length, 2);
  for (const value of sources) {
    assert.ok(ts.isStringLiteral(value));
    assert.equal(value.text, 'manual');
  }
});
