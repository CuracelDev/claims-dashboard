import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getSupabase } from '../../../../../lib/supabase';
import { buildRunnerArgs, startDetachedRunner, validateRunRequest } from '../../../../../lib/piles-auto-assignment-runner.mjs';

export const dynamic = 'force-dynamic';

const normalize = (value) => String(value ?? '').trim();
const canonicalInsurerKey = (value) => {
  const label = normalize(value).toLowerCase().replace(/\s+/g, ' ');
  return label === 'uapom' || label === 'old mutual' ? 'old mutual' : label;
};

function resolvePythonBin() {
  const candidates = [
    process.env.PILES_ASSIGNMENT_PYTHON_BIN,
    process.env.PYTHON_BIN,
    path.join(process.cwd(), '.venv-piles-auto-assignment', 'bin', 'python'),
    process.env.HOME ? path.join(process.env.HOME, 'anaconda3', 'bin', 'python3') : '',
    'python3',
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === 'python3' || fs.existsSync(candidate)) || 'python3';
}

function resolveRunnerBackend() {
  const value = normalize(process.env.PILES_AUTO_ASSIGNMENT_RUNNER_BACKEND).toLowerCase();
  if (value === 'local' || value === 'remote') return value;
  const hasRemoteUrl = Boolean(normalize(process.env.PILES_AUTO_ASSIGNMENT_RUNNER_REMOTE_URL || process.env.INTELIVER_RUN_NOW_URL));
  return process.env.NODE_ENV === 'production' && hasRemoteUrl ? 'remote' : 'local';
}

async function requireActiveMasterAccount(supabase, insurerName) {
  const { data, error } = await supabase.from('piles_auto_assignment_master_accounts').select('id, insurer_name, is_active');
  if (error) throw error;
  const account = (data || []).find((item) => canonicalInsurerKey(item.insurer_name) === canonicalInsurerKey(insurerName));
  if (!account) return `No master insurer account was found for '${insurerName}'.`;
  if (account.is_active === false) return `${account.insurer_name} is inactive. Enable it in Master Insurer Credentials before running it.`;
  return null;
}

async function markLaunchFailed(supabase, runId) {
  await supabase.from('piles_auto_assignment_runner_runs').update({
    status: 'failed',
    finished_at: new Date().toISOString(),
    stderr: 'runner_launch_failed',
    updated_at: new Date().toISOString(),
  }).eq('id', runId);
}

async function findDuplicate(supabase, idempotencyKey) {
  if (!idempotencyKey) return null;
  const { data, error } = await supabase
    .from('piles_auto_assignment_runner_runs')
    .select('id,status')
    .contains('details', { idempotency_key: idempotencyKey })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function queueRemote(request, runId) {
  const url = normalize(process.env.PILES_AUTO_ASSIGNMENT_RUNNER_REMOTE_URL || process.env.INTELIVER_RUN_NOW_URL);
  const token = normalize(process.env.PILES_AUTO_ASSIGNMENT_RUNNER_REMOTE_TOKEN || process.env.INTELIVER_RUN_NOW_TOKEN);
  if (!url) throw new Error('Runner backend is remote but no remote run URL is configured.');
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method: 'POST', headers, cache: 'no-store',
    body: JSON.stringify({
      run_id: runId, insurer_name: request.insurerName, run_all: request.runAll,
      portal_environment: request.portalEnvironment, months: request.months, year: request.year,
      effective_date: request.effectiveDate, visible_browser: request.visible,
      finalize_assignments: request.finalizeAssignments, run_source: 'manual', invocation_backend: 'remote',
      adopt_preview_run: !request.finalizeAssignments,
    }),
  });
  if (!response.ok) throw new Error(`Remote runner queue failed with HTTP ${response.status}.`);
}

export async function POST(httpRequest) {
  let supabase;
  let runId = '';
  try {
    const request = validateRunRequest(await httpRequest.json());
    const backend = resolveRunnerBackend();
    const idempotencyKey = normalize(httpRequest.headers.get('idempotency-key'));
    if (idempotencyKey.length > 200) {
      return NextResponse.json({ success: false, error: 'Idempotency key is too long.' }, { status: 400 });
    }

    supabase = getSupabase();
    if (!request.runAll) {
      const accountError = await requireActiveMasterAccount(supabase, request.insurerName);
      if (accountError) return NextResponse.json({ success: false, error: accountError }, { status: 400 });
    }
    const duplicate = await findDuplicate(supabase, idempotencyKey);
    if (duplicate) {
      return NextResponse.json({ success: true, run_id: duplicate.id, status: duplicate.status, duplicate: true }, { status: 202 });
    }

    runId = randomUUID();
    const now = new Date().toISOString();
    const details = {
      idempotency_key: idempotencyKey || null,
      queued_at: now,
      finalize_assignments: request.finalizeAssignments,
      insurers: request.runAll ? [] : [request.insurerName],
      ...(request.finalizeAssignments ? {} : {
        preview_protocol: 'durable_preview_v1', preview_phase: 'configuration', preview_outcomes: [],
      }),
    };
    const { error: insertError } = await supabase.from('piles_auto_assignment_runner_runs').insert({
      id: runId, insurer_name: request.runAll ? '' : request.insurerName,
      run_scope: request.runAll ? 'all-active' : 'single', portal_environment: request.portalEnvironment,
      backend, run_source: 'manual', months: request.months, year: request.year,
      mode: request.finalizeAssignments ? 'execute' : 'dry-run', status: 'queued', started_at: now,
      details, created_at: now, updated_at: now,
    });
    if (insertError) throw insertError;

    if (backend === 'remote') {
      await queueRemote(request, runId);
    } else {
      const args = buildRunnerArgs(request, { runId, backend, source: 'manual' });
      startDetachedRunner({
        pythonBin: resolvePythonBin(), scriptPath: 'scripts/piles_auto_assignment_runner.py', args,
        cwd: process.cwd(), env: process.env,
        onError: (error) => { void markLaunchFailed(supabase, runId, error).catch(() => {}); },
      }, spawn);
    }
    return NextResponse.json({ success: true, run_id: runId, status: 'queued', backend }, { status: 202 });
  } catch (error) {
    if (supabase && runId) await markLaunchFailed(supabase, runId, error);
    const message = error?.message || 'Failed to queue the Piles auto-assignment flow.';
    const status = /choose|must|required|too long/i.test(message) ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
