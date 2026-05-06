import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function normalize(value) {
  return String(value ?? '').trim();
}

function normalizeMonths(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item)).filter(Boolean);
  }
  const single = normalize(value);
  return single ? [single] : [];
}

function resolvePythonBin() {
  const candidates = [
    process.env.PILES_ASSIGNMENT_PYTHON_BIN,
    process.env.PYTHON_BIN,
    path.join(process.cwd(), '.venv-piles-auto-assignment', 'bin', 'python'),
    process.env.HOME ? path.join(process.env.HOME, 'anaconda3', 'bin', 'python3') : '',
    'python3',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'python3') return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'python3';
}

function resolveRunnerBackend() {
  const value = normalize(process.env.PILES_AUTO_ASSIGNMENT_RUNNER_BACKEND).toLowerCase();
  if (value === 'local' || value === 'remote') return value;
  const hasRemoteUrl = Boolean(normalize(process.env.PILES_AUTO_ASSIGNMENT_RUNNER_REMOTE_URL || process.env.INTELIVER_RUN_NOW_URL));
  if (process.env.NODE_ENV === 'production' && hasRemoteUrl) {
    return 'remote';
  }
  return 'local';
}

function runProcess(args, backend = 'local') {
  return new Promise((resolve) => {
    const pythonBin = resolvePythonBin();
    const child = spawn(pythonBin, ['-u', 'scripts/piles_auto_assignment_runner.py', '--run-source', 'manual', '--invocation-backend', backend, ...args], {
      cwd: process.cwd(),
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function runRemote(payload) {
  const url = normalize(process.env.PILES_AUTO_ASSIGNMENT_RUNNER_REMOTE_URL || process.env.INTELIVER_RUN_NOW_URL);
  const token = normalize(process.env.PILES_AUTO_ASSIGNMENT_RUNNER_REMOTE_TOKEN || process.env.INTELIVER_RUN_NOW_TOKEN);

  if (!url) {
    throw new Error('Runner backend is set to remote, but no remote run URL is configured.');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...payload,
      run_source: 'manual',
      invocation_backend: 'remote',
    }),
    cache: 'no-store',
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (!res.ok) {
    throw new Error(json?.error || `Remote runner failed with HTTP ${res.status}.`);
  }

  return {
    success: json?.success !== false,
    code: typeof json?.code === 'number' ? json.code : 0,
    stdout: json?.stdout || '',
    stderr: json?.stderr || '',
    started_at: json?.started_at || new Date().toISOString(),
    finished_at: json?.finished_at || new Date().toISOString(),
    duration_ms: Number(json?.duration_ms || 0),
    backend: 'remote',
  };
}

export async function POST(request) {
  try {
    const body = await request.json();
    const insurerName = normalize(body.insurer_name);
    const portalEnvironment = ['production', 'test'].includes(normalize(body.portal_environment).toLowerCase())
      ? normalize(body.portal_environment).toLowerCase()
      : 'production';
    const months = normalizeMonths(body.months?.length ? body.months : body.month);
    const year = normalize(body.year);
    const finalizeAssignments = Boolean(body.finalize_assignments);
    const runAll = Boolean(body.run_all);
    const visible = Boolean(body.visible_browser);
    const backend = resolveRunnerBackend();

    if (!runAll && !insurerName) {
      return NextResponse.json({ success: false, error: 'Choose an insurer or run all active insurers.' }, { status: 400 });
    }

    const args = [];
    if (runAll) {
      args.push('--all-active');
    } else {
      args.push('--insurer', insurerName);
    }
    args.push('--portal-environment', portalEnvironment);
    if (months.length) args.push('--month', months.join(','));
    if (year) args.push('--year', year);
    if (visible) args.push('--visible');
    if (finalizeAssignments) args.push('--execute');

    let result;
    if (backend === 'remote') {
      result = await runRemote({
        insurer_name: insurerName,
        portal_environment: portalEnvironment,
        months,
        year,
        finalize_assignments: finalizeAssignments,
        run_all: runAll,
        visible_browser: visible,
      });
    } else {
      const startedAt = Date.now();
      const processResult = await runProcess(args, backend);
      const finishedAt = Date.now();
      result = {
        success: processResult.code === 0,
        code: processResult.code,
        stdout: processResult.stdout,
        stderr: processResult.stderr,
        started_at: new Date(startedAt).toISOString(),
        finished_at: new Date(finishedAt).toISOString(),
        duration_ms: finishedAt - startedAt,
        backend,
      };
    }

    return NextResponse.json({
      success: result.success,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      started_at: result.started_at,
      finished_at: result.finished_at,
      duration_ms: result.duration_ms,
      backend: result.backend,
    }, { status: result.success ? 200 : 500 });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message || 'Failed to run piles auto-assignment flow.' }, { status: 500 });
  }
}
