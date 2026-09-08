import assert from 'node:assert/strict';
import test from 'node:test';

import { updateBotAccountWithHistory } from './piles-auto-assignment-bot-history.mjs';

test('bot mutation is delegated to the transactional history RPC', async () => {
  const calls = [];
  const supabase = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: [{ id: 'bot-1', availability_status: 'paused' }], error: null };
    },
  };

  const item = await updateBotAccountWithHistory(supabase, {
    botId: 'bot-1',
    patch: { availability_status: 'paused', bot_password: 'must-not-pass' },
    actorName: 'Daniel',
    actorMemberId: 'U123',
    source: 'weekend_roster',
    reason: 'Shift ended',
  });

  assert.equal(item.id, 'bot-1');
  assert.equal(calls[0].name, 'piles_update_bot_account_with_history');
  assert.deepEqual(calls[0].args.patch, {
    availability_status: 'paused',
    bot_password: 'must-not-pass',
  });
  assert.equal(calls[0].args.change_source, 'weekend_roster');
});

test('history failure rejects the bot update', async () => {
  const supabase = { rpc: async () => ({ data: null, error: new Error('history failed') }) };
  await assert.rejects(
    updateBotAccountWithHistory(supabase, {
      botId: 'bot-1', patch: { is_available: false }, source: 'test', reason: 'test',
    }),
    /history failed/,
  );
});

test('unknown or empty updates are rejected before RPC', async () => {
  let called = false;
  const supabase = { rpc: async () => { called = true; } };
  await assert.rejects(
    updateBotAccountWithHistory(supabase, { botId: 'bot-1', patch: { unknown: 'value' }, source: 'test' }),
    /auditable fields/,
  );
  assert.equal(called, false);
});
