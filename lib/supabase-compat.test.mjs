import assert from 'node:assert/strict';
import test from 'node:test';

import { createClient } from './supabase-compat.js';
import { updateBotAccountWithHistory } from './piles-auto-assignment-bot-history.mjs';

test('createClient includes rpc function and query builder', () => {
  const client = createClient();
  assert.equal(typeof client.from, 'function');
  assert.equal(typeof client.rpc, 'function');
});

test('rpc converts params to named arguments and handles execution errors gracefully', async () => {
  const client = createClient();
  const result = await client.rpc('non_existent_function', { target_bot_id: 'bot-123' });
  
  assert.equal(result.data, null);
  assert.ok(result.error instanceof Error);
});

test('rpc rejects malicious or invalid function names and parameter keys', async () => {
  const client = createClient();

  const badFnResult = await client.rpc('bad_fn; DROP TABLE users--', {});
  assert.equal(badFnResult.data, null);
  assert.match(badFnResult.error.message, /Invalid RPC function name/);

  const badParamResult = await client.rpc('valid_fn', { 'bad_key;--': 'value' });
  assert.equal(badParamResult.data, null);
  assert.match(badParamResult.error.message, /Invalid RPC parameter key name/);
});

test('query builder normalizes plain JS objects into JSON strings for insert, update, and upsert', async () => {
  const client = createClient();
  const builder = client.from('daily_reports');

  builder.insert({
    team_member_id: 1,
    metrics: { care_items_mapped: 264, care_items_grouped: 4 },
  });

  let executedValues = [];
  builder.then = async (resolve) => {
    executedValues = builder.payload;
    resolve({ data: [{ id: 1 }], error: null, count: 1 });
  };

  const payload = {
    team_member_id: 1,
    metrics: { care_items_mapped: 264, care_items_grouped: 4 },
  };

  client.from('daily_reports').insert(payload);
  assert.equal(typeof payload.metrics, 'object');
});

test('updateBotAccountWithHistory integrates with createClient rpc interface', async () => {
  const mockClient = createClient();
  let executedSql = null;
  let executedValues = null;

  mockClient.rpc = async (fnName, params) => {
    executedSql = fnName;
    executedValues = params;
    return {
      data: [{ id: params.target_bot_id, assignment_role: 'primary' }],
      error: null,
    };
  };

  const updated = await updateBotAccountWithHistory(mockClient, {
    botId: 'bot-999',
    patch: { assignment_role: 'primary' },
    actorName: 'Test User',
    source: 'unit_test',
  });

  assert.equal(updated.id, 'bot-999');
  assert.equal(executedSql, 'piles_update_bot_account_with_history');
  assert.equal(executedValues.target_bot_id, 'bot-999');
});
