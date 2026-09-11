import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as history from './piles-auto-assignment-history.mjs';
import { toRunnerProgressView } from './piles-auto-assignment-view-model.mjs';
import { formatDuration, formatCount, statusPresentation, heartbeatPresentation, summarizeInsurerOutcomes } from './piles-auto-assignment-history.mjs';

test('duration preserves hours, minutes and seconds without rounding up elapsed time', () => {
  for (const [input, expected] of [[5546000, '1h 32m 26s'], [3600000, '1h 0m 0s'], [61000, '1m 1s'], [59999, '59s'], [0, '0s'], [999, '0s'], [90061000, '25h 1m 1s']]) {
    assert.equal(formatDuration(input), expected);
  }
  for (const input of [null, undefined, '', '123', -1, NaN, Infinity]) assert.equal(formatDuration(input), '—');
});

test('unknown counts are not turned into zero while recorded zero is visible', () => {
  for (const input of [null, undefined, NaN, Infinity, -1, '0']) assert.equal(formatCount(input), 'Unknown');
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(1234), '1,234');
});

test('status presentation is fixed and never treats issues, coverage, waiting or unknown as success', () => {
  assert.equal(statusPresentation('partial').label, 'Completed with issues (legacy)');
  assert.equal(statusPresentation('completed_with_issues').label, 'Completed with issues');
  assert.equal(statusPresentation('completed').tone, 'success');
  assert.match(statusPresentation('covered_by_active_cycle').explanation, /no duplicate execution/i);
  assert.match(statusPresentation('follow_up_queued').explanation, /waiting/i);
  for (const status of ['partial', 'completed_with_issues', 'failed', 'manual_action_required', 'skipped_overlap', 'skipped_inactive', 'covered_by_active_cycle', 'cancelled', 'queued', 'follow_up_queued', 'running', 'waiting']) {
    assert.notEqual(statusPresentation(status).tone, 'success', status);
  }
  for (const status of ['future_status', '__proto__', 'constructor', undefined]) {
    assert.equal(statusPresentation(status).label, 'Unknown status');
    assert.equal(statusPresentation(status).tone, 'neutral');
    assert.match(statusPresentation(status).explanation, /not confirmed/i);
  }
});

test('fresh long-running work differs from stale heartbeat and never claims recovery eligibility', () => {
  const fresh = heartbeatPresentation('fresh', 5546000);
  const stale = heartbeatPresentation('stale', 5546000);
  assert.match(fresh.label, /long.running.*fresh/i);
  assert.match(fresh.explanation, /not.*stuck/i);
  assert.match(stale.label, /stale heartbeat/i);
  assert.match(stale.explanation, /lock.*not.*checked/i);
  assert.notEqual(fresh.tone, stale.tone);
  assert.notEqual(fresh.tone, 'success');
  assert.doesNotMatch(heartbeatPresentation('fresh', 3599999).label, /long.running/i);
  assert.match(heartbeatPresentation('fresh', 3600000).label, /long.running/i);
  for (const state of ['missing', 'unknown', 'future', '__proto__']) assert.notEqual(heartbeatPresentation(state, 0).tone, 'success');
});

test('mixed insurer outcomes distinguish completion, failures, reconciliation and queued work', () => {
  assert.equal(summarizeInsurerOutcomes([
    { status: 'completed' }, { status: 'completed' }, { status: 'failed' },
    { status: 'completed_with_issues', counts: { reconciliation_pending: 2 } },
    { status: 'follow_up_queued' }, { status: 'covered_by_active_cycle' },
  ]), '2 completed, 1 failed, 1 awaiting reconciliation, 1 waiting, 1 covered (no duplicate execution)');
});

test('manual action, partial, inactive and unknown insurers cannot inflate completed totals', () => {
  assert.equal(summarizeInsurerOutcomes([
    { status: 'manual_action_required', counts: { manual_action_required: null } },
    { status: 'partial' }, { status: 'skipped_inactive' }, { status: 'future' },
    { status: 'cancelled' }, { status: 'running' },
  ]), '1 completed with issues, 1 manual action required, 1 running, 1 inactive, 1 cancelled, 1 unknown');
  assert.equal(summarizeInsurerOutcomes([]), 'No insurer details recorded.');
});

// Exercise actual page components with the existing TypeScript + React runtime.
// Only unused app context/auth boundaries are replaced; no component is mocked.
const require = createRequire(import.meta.url);
const pageSource = readFileSync(new URL('../app/tools/piles-auto-assignment/page.js', import.meta.url), 'utf8');
const compiled = ts.transpileModule(pageSource, { fileName: 'page.jsx', compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const page = {};
new Function('require', 'exports', `${compiled}\nexports.HistoryBadge = HistoryBadge; exports.HistoryRun = typeof RunnerHistoryRun === 'undefined' ? undefined : RunnerHistoryRun; exports.HistorySection = RunnerHistorySection; exports.Control = RunnerControlSection;`)((name) => {
  if (name.endsWith('/piles-auto-assignment-history.mjs')) return history;
  if (name.endsWith('/ThemeContext') || name.endsWith('/auth')) return {};
  return require(name);
}, page);
const themeSource = readFileSync(new URL('../app/context/ThemeContext.js', import.meta.url), 'utf8');
const themeCompiled = ts.transpileModule(themeSource, { fileName: 'ThemeContext.jsx', compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const themes = {};
new Function('require', 'exports', themeCompiled)(require, themes);
const C = themes.DARK;

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/.{2}/g).map((channel) => {
      const value = Number.parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function renderedBadgeColor(theme, tone) {
  const output = renderToStaticMarkup(React.createElement(page.HistoryBadge, {
    C: theme,
    presentation: { tone, label: tone },
  }));
  const color = output.match(/style="[^"]*color:([^;\"]+)/)?.[1];
  assert.match(color || '', /^#[0-9a-f]{6}$/i, `${tone} badge must render an opaque hex text color`);
  return color;
}

test('history badge tones meet WCAG AA contrast on every light and dark parent surface', () => {
  for (const [themeName, theme] of [['light', themes.LIGHT], ['dark', themes.DARK]]) {
    for (const tone of ['success', 'warning', 'danger', 'info', 'neutral']) {
      const foreground = renderedBadgeColor(theme, tone);
      for (const [surfaceName, background] of [['card', theme.card], ['elevated', theme.elevated]]) {
        const ratio = contrastRatio(foreground, background);
        assert.ok(ratio >= 4.5, `${themeName} ${tone} badge contrast on ${surfaceName} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});
function renderRun(run) {
  assert.equal(typeof page.HistoryRun, 'function', 'page must render a safe expandable parent/insurer history component');
  return renderToStaticMarkup(React.createElement(page.HistoryRun, { C, run }));
}
const now = Date.parse('2026-09-11T12:00:00Z');
const parent = { id: 'run-1', status: 'completed_with_issues', run_source: 'schedule', run_scope: 'all_active', mode: 'execute', duration_ms: 5546000 };

test('history output renders expandable parent and insurer diagnostics with nullable manual counts', () => {
  const run = toRunnerProgressView(parent, [
    { id: 'i1', insurer_name: 'DEFMIS', status: 'completed', confirmed_pile_count: 3 },
    { id: 'i2', insurer_name: 'Jubilee Kenya', status: 'manual_action_required', phase: 'plan', error_code: 'manual_action_required', error_message: 'private-error', details: { performance: [{ phase: 'plan', operation: 'planning', count: 1, total_ms: 61000, min_ms: 61000, max_ms: 61000, outcomes: { success: 1 } }] } },
  ], [{ insurer_run_id: 'i2', status: 'failed' }], [], [], { now });
  const output = renderRun(run);
  assert.equal((output.match(/<details[ >]/g) || []).length, 3);
  assert.equal((output.match(/<summary[ >]/g) || []).length, 3);
  for (const text of ['All active insurers', 'Scheduled', 'Completed with issues', '1h 32m 26s', 'DEFMIS', 'Jubilee Kenya', 'Manual action required', 'manual_action_required', 'Contexts failed', 'Confirmed piles', 'Work disposition', '1m 1s', 'nested']) assert.ok(output.includes(text), text);
  assert.match(output, /Manual action piles<\/dt><dd[^>]*>Unknown<\/dd>/);
  assert.doesNotMatch(output, /private-error|exact output|stdout|stderr/);
});

test('history output never accesses raw run fields and escapes safe string fields as text', () => {
  const run = toRunnerProgressView({ ...parent, status: 'future_status' });
  for (const key of ['stdout', 'stderr', 'details', 'run_source']) Object.defineProperty(run, key, { get() { throw new Error(`Unsafe read: ${key}`); } });
  run.insurer_name = '<img src=x onerror=alert(1)>';
  run.run_scope = 'single';
  const output = renderRun(run);
  assert.match(output, /Unknown status/);
  assert.match(output, /&lt;img/);
  assert.doesNotMatch(output, /<img|data-tone="success"/);
});

test('fresh versus stale heartbeat output has distinct labels and tones without fabricated live counts', () => {
  const activeParent = { ...parent, status: 'running', started_at: '2026-09-11T10:27:34Z' };
  const child = { id: 'i1', insurer_name: 'DEFMIS', status: 'running', phase: 'scan', started_at: activeParent.started_at };
  const fresh = renderRun(toRunnerProgressView(activeParent, [{ ...child, heartbeat_at: '2026-09-11T11:59:00Z' }], [], [], [], { now }));
  const stale = renderRun(toRunnerProgressView(activeParent, [{ ...child, heartbeat_at: '2026-09-11T11:00:00Z' }], [], [], [], { now }));
  assert.match(fresh, /data-tone="info"[^>]*>Long-running · fresh heartbeat/);
  assert.match(stale, /data-tone="warning"[^>]*>Stale heartbeat/);
  assert.match(fresh.split('</summary>')[0], /Long-running · fresh heartbeat/);
  assert.match(stale.split('</summary>')[0], /Stale heartbeat/);
  assert.match(fresh, /Submitted piles<\/dt><dd[^>]*>Unknown<\/dd>/);
  assert.doesNotMatch(fresh, /data-tone="success"/);
  assert.doesNotMatch(stale, /data-tone="success"/);
});

test('request-only waiting and acknowledgement never render successful assignment outcomes', () => {
  const details = { dispatch_requests: [{ request_id: 'request-2', work_item_id: 'foreign-work', disposition: 'follow_up_queued' }] };
  const waiting = renderRun(toRunnerProgressView({ ...parent, status: 'running', details }));
  const acknowledged = renderRun(toRunnerProgressView({ ...parent, status: 'completed', details }));
  assert.match(waiting, /Waiting/);
  assert.match(waiting, /Follow-up requests<\/dt><dd[^>]*>1<\/dd>/);
  assert.match(acknowledged, /acknowledged/i);
  assert.match(acknowledged, /no duplicate execution/i);
  assert.doesNotMatch(waiting, /data-tone="success"/);
  assert.doesNotMatch(acknowledged, /data-tone="success"/);
  assert.doesNotMatch(acknowledged, /Owned insurer workflows completed/);
});

test('history section offers labeled filters and refresh without promising raw or unbounded history', () => {
  const output = renderToStaticMarkup(React.createElement(page.HistorySection, { C, refreshToken: 0 }));
  assert.match(output, /aria-label="Runner history date range"/);
  assert.match(output, /Refresh history/);
  assert.match(output, /150/);
  assert.doesNotMatch(output, /exact output|full output|Full runner history/i);
});

test('runner control preserves its trigger controls but uses truthful status and hour formatting', () => {
  const output = renderToStaticMarkup(React.createElement(page.Control, {
    C, masterAccounts: [{ id: 'm1', insurer_name: 'DEFMIS', is_active: true }],
    runnerState: { runMeta: { status: 'follow_up_queued', duration_ms: 5546000 } },
  }));
  assert.match(output, /Start Runner/);
  assert.match(output, /Finalize assignments/);
  assert.match(output, /1h 32m 26s/);
  assert.match(output, /data-tone="warning"[^>]*>Follow-up queued/);
});

test('runner control treats request-only completion as acknowledgement, not assignment success', () => {
  const run = toRunnerProgressView({ ...parent, status: 'completed', details: {
    dispatch_requests: [{ request_id: 'request-2', work_item_id: 'foreign-work', disposition: 'follow_up_queued' }],
  } });
  const output = renderToStaticMarkup(React.createElement(page.Control, { C, masterAccounts: [], runnerState: { runMeta: run } }));
  assert.match(output, /Covered by active cycle/);
  assert.doesNotMatch(output, /data-tone="success"/);
});

test('progress refresh recognizes safe-view active work and stops for new terminal outcomes', () => {
  assert.equal(typeof history.isRunnerActive, 'function');
  for (const status of ['queued', 'running', 'follow_up_queued', 'unknown']) assert.equal(history.isRunnerActive({ status }), true, status);
  for (const status of ['completed', 'completed_with_issues', 'partial', 'failed', 'covered_by_active_cycle', 'cancelled', 'skipped_inactive', 'skipped_overlap', 'manual_action_required']) assert.equal(history.isRunnerActive({ status }), false, status);
  assert.equal(history.isRunnerActive({ status: 'completed', request_state: { state: 'waiting' } }), true);
  assert.equal(history.isRunnerActive({ status: 'completed_with_issues', insurers: [{ status: 'running' }] }), true);
  assert.equal(history.isRunnerActive({ status: 'unknown', finished_at: '2026-09-11T12:00:00Z' }), false);
});
