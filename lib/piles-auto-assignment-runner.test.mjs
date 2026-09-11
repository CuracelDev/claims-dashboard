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
  for (const name of ['run-piles-auto-assignment.sh', 'install-piles-auto-assignment-cron.sh']) {
    copyFileSync(new URL(`../scripts/${name}`, import.meta.url), path.join(root, 'scripts', name));
    chmodSync(path.join(root, 'scripts', name), 0o755);
  }
  const python = path.join(root, 'bin', 'python');
  writeFileSync(python, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(python, 0o755);
  const crontab = path.join(root, 'bin', 'crontab');
  writeFileSync(crontab, `#!${process.execPath}\nconst fs = require('node:fs'); if (process.argv[2] === '-l') process.stdout.write(fs.readFileSync(process.env.CRON_FILE)); else fs.copyFileSync(process.argv[2], process.env.CRON_FILE);\n`);
  chmodSync(crontab, 0o755);
  const env = {
    PATH: `${path.join(root, 'bin')}:/usr/bin:/bin`,
    PILES_ASSIGNMENT_PYTHON_BIN: python,
    ARGV_FILE: path.join(root, 'argv.json'), CRON_FILE: path.join(root, 'crontab'),
    PILES_AUTO_ASSIGNMENT_ENV_FILE: path.join(root, "config's 50%.env"),
    PILES_AUTO_ASSIGNMENT_CRON_LOG_DIR: path.join(root, "log's 50%"),
    PILES_AUTO_ASSIGNMENT_RUN_SOURCE: 'recovery',
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
  const script = step.with.script.slice(step.with.script.indexOf('if [ "$PROBE_SCOPE"'));
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
  assert.ok(step.with.envs.split(',').includes('PILES_AUTO_ASSIGNMENT_DISPATCHER_V2'));
  assert.ok(step.with.envs.split(',').includes('PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY'));
  const script = step.with.script.split('cd ~/claims-dashboard\n')[1].split('export PATH=')[0]
    .replace(/\$\{\{[^}]+\}\}/g, '');
  for (const [flag, concurrency, expected] of [['', '', ['false', '1']], ['false', '1', ['false', '1']], ['true', '2', ['true', '2']], ['yes', '1', null], ['false', '3', null], ['false', '01', null]]) {
    const target = path.join(fixture.root, '.env');
    writeFileSync(target, 'untouched\n');
    const result = spawnSync('/bin/sh', ['-c', script], {
      cwd: fixture.root, env: { ...fixture.env, PILES_AUTO_ASSIGNMENT_DISPATCHER_V2: flag, PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY: concurrency }, encoding: 'utf8',
    });
    const output = readFileSync(target, 'utf8');
    if (!expected) {
      assert.notEqual(result.status, 0);
      assert.equal(output, 'untouched\n');
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.ok(output.includes(`PILES_AUTO_ASSIGNMENT_DISPATCHER_V2="${expected[0]}"`));
      assert.ok(output.includes(`PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY="${expected[1]}"`));
    }
  }
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

test('production runtime retries a transient APT lock and completes fresh host setup', (t) => {
  const fixture = productionRuntimeFixture(t);
  const script = new URL('../scripts/prepare-piles-production-runtime.sh', import.meta.url);
  const result = spawnSync('/bin/sh', [script.pathname], {
    cwd: fixture.root, env: fixture.env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(fixture.aptAttempts, 'utf8'), '3');
  assert.match(result.stderr, /attempt 1\/3 failed; retrying/);
  const commands = readFileSync(fixture.commandLog, 'utf8');
  assert.match(commands, /python -m playwright install --with-deps chromium chromium-headless-shell/);
});

test('production runtime skips OS package work for an existing provisioned host', (t) => {
  const fixture = productionRuntimeFixture(t, { existingVenv: true });
  const script = new URL('../scripts/prepare-piles-production-runtime.sh', import.meta.url);
  const result = spawnSync('/bin/sh', [script.pathname], {
    cwd: fixture.root, env: fixture.env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(fixture.commandLog, 'utf8').includes('apt-get '), false);
  assert.match(readFileSync(fixture.commandLog, 'utf8'), /python -m playwright install chromium chromium-headless-shell/);
  assert.equal(readFileSync(path.join(fixture.root, 'runtime-ready'), 'utf8'), 'ready\n');
});

test('production runtime resumes incomplete bootstrap after virtualenv creation', (t) => {
  const fixture = productionRuntimeFixture(t);
  const script = new URL('../scripts/prepare-piles-production-runtime.sh', import.meta.url);
  const first = spawnSync('/bin/sh', [script.pathname], {
    cwd: fixture.root,
    env: { ...fixture.env, FAIL_PLAYWRIGHT_DEPS: 'true', PILES_RUNTIME_MAX_ATTEMPTS: '2' },
    encoding: 'utf8',
  });
  assert.equal(first.status, 41, first.stderr);
  assert.equal(existsSync(path.join(fixture.root, 'runtime-ready')), false);

  const second = spawnSync('/bin/sh', [script.pathname], {
    cwd: fixture.root, env: fixture.env, encoding: 'utf8',
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(path.join(fixture.root, 'runtime-ready'), 'utf8'), 'ready\n');
  assert.match(readFileSync(fixture.commandLog, 'utf8'), /python -m playwright install --with-deps chromium chromium-headless-shell/);
});

test('production runtime propagates the final failure after bounded retries', (t) => {
  const fixture = productionRuntimeFixture(t);
  const script = new URL('../scripts/prepare-piles-production-runtime.sh', import.meta.url);
  const result = spawnSync('/bin/sh', [script.pathname], {
    cwd: fixture.root,
    env: { ...fixture.env, FAIL_PLAYWRIGHT_DEPS: 'true', PILES_RUNTIME_MAX_ATTEMPTS: '2' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 41, result.stderr);
  assert.match(result.stderr, /failed after 2 attempts \(exit 41\)/);
  assert.equal(existsSync(path.join(fixture.root, 'runtime-ready')), false);
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
