const PATCH_FIELDS = new Set([
  'master_account_id', 'insurer_name', 'owner_name', 'bot_name', 'bot_email', 'bot_password',
  'assignment_role', 'support_capacity_ratio', 'availability_status', 'availability_note',
  'active_from_time', 'active_to_time', 'shift_grace_minutes', 'notes', 'is_active',
  'is_available', 'priority_order', 'current_claim_load', 'last_assigned_at',
  'last_completed_at',
]);

function cleanText(value, fallback = '') {
  return String(value ?? fallback).trim();
}

export async function updateBotAccountWithHistory(supabase, change) {
  const botId = cleanText(change?.botId);
  if (!botId) throw new Error('Bot account id is required.');

  const patch = Object.fromEntries(
    Object.entries(change?.patch || {}).filter(([key, value]) => PATCH_FIELDS.has(key) && value !== undefined),
  );
  if (!Object.keys(patch).length) {
    throw new Error('At least one of the auditable fields must be changed.');
  }

  const { data, error } = await supabase.rpc('piles_update_bot_account_with_history', {
    target_bot_id: botId,
    patch,
    actor_name: cleanText(change?.actorName) || null,
    actor_member_id: cleanText(change?.actorMemberId) || null,
    change_source: cleanText(change?.source) || 'dashboard',
    change_reason: cleanText(change?.reason) || null,
  });
  if (error) throw error;
  const item = Array.isArray(data) ? data[0] : data;
  if (!item) throw new Error('Bot account update returned no row.');
  return item;
}
