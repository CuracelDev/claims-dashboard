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
