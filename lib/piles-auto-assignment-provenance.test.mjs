import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../app/tools/piles-auto-assignment/page.js', import.meta.url), 'utf8');
const route = readFileSync(new URL('../app/api/tools/piles-auto-assignment/route.js', import.meta.url), 'utf8');

test('dashboard reports observed assignment provenance without claiming manual action', () => {
  assert.match(page, /Unlinked \/ Externally Observed Assignments/);
  assert.match(page, /unlinked does not prove/i);
  assert.match(page, /Portal Assignee/);
  assert.match(page, /Configured Owner/);
  assert.match(page, /Runner Evidence/);
  assert.match(page, /Clear Reason/);
  assert.match(page, /Unsynced/);
  assert.doesNotMatch(page, /skipped\/manual assignments/);
});

test('API classifies old rows as legacy unverified and never upgrades them to verified external', () => {
  assert.match(route, /legacy_unverified/);
  assert.match(route, /verified_external/);
  assert.match(route, /provenance_status/);
  assert.match(route, /portal_assignee/);
  assert.match(route, /configured_owner/);
  assert.match(route, /related_runner_evidence/);
  assert.match(route, /clear_reason/);
  assert.doesNotMatch(route, /\?\?\s*['"]verified_external['"]/);
});
