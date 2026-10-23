import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const operations = ['incident', 'provenance', 'historical-review', 'readiness', 'runtime-probe', 'runtime-repair', 'stale-inspect', 'stale-recover', 'legacy-audit', 'legacy-apply'];
const keys = ['operation', 'insurer', 'hours', 'scope', 'target_kind', 'target_id', 'claim_token', 'confirmation'];

export function validateMaintenanceInputs(input) {
  const fail = () => { throw new Error('Invalid maintenance inputs'); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) fail();
  const values = { insurer: '', hours: '24', scope: 'one-insurer', target_kind: 'none', target_id: '', claim_token: '', confirmation: '', ...input };
  const { operation, insurer, scope, target_kind: kind, target_id: id, claim_token: token, confirmation } = values;
  if (!operations.includes(operation) || keys.filter(k => k !== 'hours').some(k => typeof values[k] !== 'string')) fail();
  if (!['string', 'number'].includes(typeof values.hours) || !/^\d+$/.test(String(values.hours))) fail();
  const hours = Number(values.hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720 || insurer.length > 120 || /[\x00-\x1f\x7f]/.test(insurer)) fail();
  if (!['one-insurer', 'all-active'].includes(scope) || !['none', 'parent', 'insurer-run', 'work', 'legacy-request'].includes(kind)) fail();
  if (!/^[A-Za-z0-9._-]{0,200}$/.test(id) || !/^[A-Za-z0-9._-]{0,200}$/.test(token) || (kind === 'none') !== (id === '')) fail();
  const inspection = ['incident', 'provenance', 'historical-review'].includes(operation);
  if (operation !== 'readiness' && scope !== 'one-insurer') fail();
  if (!inspection && hours !== 24) fail();
  if (!['provenance', 'historical-review', 'readiness'].includes(operation) && insurer) fail();
  if (operation === 'historical-review' && !insurer.trim()) fail();
  if (operation === 'readiness' && (scope === 'one-insurer' ? !insurer.trim() : insurer !== '')) fail();
  const allowedKinds = operation === 'incident' ? ['none', 'parent']
    : operation.startsWith('stale-') ? ['none', 'parent', 'insurer-run', 'work']
      : operation.startsWith('legacy-') ? ['none', 'legacy-request'] : ['none'];
  if (!allowedKinds.includes(kind)) fail();
  const requiredConfirmation = { 'runtime-repair': 'REPAIR PILES RUNTIME', 'stale-recover': 'RECOVER_STALE_RUNS', 'legacy-apply': 'CANCEL_OBSOLETE_LEGACY_REQUESTS' }[operation] ?? '';
  if (confirmation !== requiredConfirmation) fail();
  if (['stale-recover', 'legacy-apply'].includes(operation) && kind === 'none') fail();
  if (operation === 'stale-recover' && kind === 'work' ? !token : token !== '') fail();
  return {
    INSPECTION_OPERATION: operation, INCIDENT_HOURS: String(hours), INCIDENT_RUN_ID: operation === 'incident' ? id : '', PROVENANCE_INSURER: insurer,
    PROBE_SCOPE: scope, PROBE_INSURER: insurer, REPAIR_CONFIRMATION: operation === 'runtime-repair' ? confirmation : '',
    RECOVERY_ACTION: operation.replace(/^stale-/, ''), RECOVERY_CONFIRMATION: confirmation,
    RECOVERY_WORK_ID: kind === 'work' ? id : '', RECOVERY_CLAIM_TOKEN: token,
    RECOVERY_INSURER_RUN_ID: kind === 'insurer-run' ? id : '', RECOVERY_PARENT_RUN_ID: kind === 'parent' ? id : '',
    RECOVERY_REQUEST_ID: kind === 'legacy-request' ? id : '',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).inputs;
    const token = input?.claim_token;
    if (typeof token === 'string' && token) process.stdout.write(`::add-mask::${token.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}\n`);
    const env = validateMaintenanceInputs(input);
    appendFileSync(process.env.GITHUB_ENV, Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join(''));
  } catch {
    console.error('Invalid maintenance inputs');
    process.exitCode = 1;
  }
}
