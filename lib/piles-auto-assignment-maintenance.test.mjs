import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../scripts/validate-piles-maintenance-inputs.mjs', import.meta.url);
const operations = ['incident','provenance','historical-review','readiness','runtime-probe','runtime-repair','stale-inspect','stale-recover','legacy-audit','legacy-apply'];
async function validator() {
  assert.ok(existsSync(script), 'maintenance validator must exist');
  return (await import(script.href)).validateMaintenanceInputs;
}

test('maintenance accepts every operation and maps exact targets to existing commands', async () => {
  const validate = await validator();
  const cases = [
    [{operation:'incident'}, {INSPECTION_OPERATION:'incident',INCIDENT_HOURS:'24',INCIDENT_RUN_ID:''}],
    [{operation:'incident',target_kind:'parent',target_id:'p-1'}, {INCIDENT_RUN_ID:'p-1'}],
    [{operation:'provenance',insurer:'DEFMIS'}, {PROVENANCE_INSURER:'DEFMIS'}],
    [{operation:'historical-review',insurer:'Jubilee Uganda'}, {INSPECTION_OPERATION:'historical-review'}],
    [{operation:'readiness',scope:'all-active'}, {PROBE_SCOPE:'all-active'}],
    [{operation:'runtime-probe'}, {}],
    [{operation:'runtime-repair',confirmation:'REPAIR PILES RUNTIME'}, {REPAIR_CONFIRMATION:'REPAIR PILES RUNTIME'}],
    [{operation:'stale-inspect'}, {RECOVERY_ACTION:'inspect'}],
    [{operation:'stale-recover',target_kind:'work',target_id:'w-1',claim_token:'t-1',confirmation:'RECOVER_STALE_RUNS'}, {RECOVERY_ACTION:'recover',RECOVERY_WORK_ID:'w-1',RECOVERY_CLAIM_TOKEN:'t-1'}],
    [{operation:'legacy-audit'}, {RECOVERY_ACTION:'legacy-audit'}],
    [{operation:'legacy-apply',target_kind:'legacy-request',target_id:'r-1',confirmation:'CANCEL_OBSOLETE_LEGACY_REQUESTS'}, {RECOVERY_REQUEST_ID:'r-1'}],
  ];
  for (const [input, expected] of cases) {
    const actual = validate(input);
    for (const [key,value] of Object.entries(expected)) assert.equal(actual[key],value,JSON.stringify(input));
  }
});

test('maintenance rejects ambiguous, unsafe, irrelevant and unconfirmed inputs', async () => {
  const validate = await validator();
  for (const input of [null, [], {}, {operation:'unknown'}, {operation:'runtime-repair'},
    {operation:'stale-recover'}, {operation:'historical-review'}, {operation:'readiness'},
    {operation:'incident',target_id:'p'}, {operation:'incident',target_kind:'work',target_id:'w'},
    {operation:'runtime-probe',confirmation:'REPAIR PILES RUNTIME'},
    {operation:'runtime-probe',claim_token:'secret'}, {operation:'runtime-probe',insurer:'DEFMIS'},
    {operation:'provenance',hours:0}, {operation:'incident',hours:721},
    {operation:'provenance',insurer:'Name\nENV=bad'},
    {operation:'readiness',scope:'all-active',insurer:'DEFMIS'},
    {operation:'incident',scope:'all-active'}, {operation:'incident',extra:'unknown'},
    {operation:'stale-recover',target_kind:'work',target_id:'w',confirmation:'RECOVER_STALE_RUNS'},
    {operation:'stale-recover',target_kind:'parent',target_id:'p',claim_token:'t',confirmation:'RECOVER_STALE_RUNS'},
    {operation:'legacy-apply',target_kind:'parent',target_id:'p',confirmation:'CANCEL_OBSOLETE_LEGACY_REQUESTS'},
    {operation:'legacy-audit',target_kind:'legacy-request',target_id:'x\nINJECTED=true'},
  ]) assert.throws(() => validate(input), /Invalid maintenance inputs/);
});

test('private validator masks ownership tokens and exports nothing on rejection', async () => {
  await validator();
  const dir = mkdtempSync(join(tmpdir(),'piles-maintenance-'));
  try {
    const event = join(dir,'event.json'), env = join(dir,'env');
    for (const valid of [true,false]) {
      writeFileSync(event,JSON.stringify({inputs:{operation:'stale-recover',target_kind:'work',target_id:'w',claim_token:'private-token',confirmation:valid?'RECOVER_STALE_RUNS':'wrong'}}));
      writeFileSync(env,'');
      const result = spawnSync(process.execPath,[script.pathname],{env:{PATH:process.env.PATH,GITHUB_EVENT_PATH:event,GITHUB_ENV:env},encoding:'utf8'});
      assert.equal(result.status,valid?0:1);
      assert.equal(result.stdout,'::add-mask::private-token\n');
      if (valid) assert.match(readFileSync(env,'utf8'),/RECOVERY_WORK_ID=w\n/);
      else { assert.equal(readFileSync(env,'utf8'),''); assert.doesNotMatch(result.stderr,/private-token|wrong/); }
    }
  } finally { rmSync(dir,{recursive:true}); }
});

test('only three workflows remain and maintenance routes one guarded job per operation', () => {
  const dir = new URL('../.github/workflows/',import.meta.url);
  assert.deepEqual(readdirSync(dir).filter(n=>n.endsWith('.yml')).sort(),['deploy.yml','piles-maintenance.yml','piles-tests.yml']);
  const parsed = spawnSync('ruby',['-ryaml','-rjson','-e','puts JSON.generate(YAML.safe_load(STDIN.read, aliases: true))'],{input:readFileSync(new URL('piles-maintenance.yml',dir),'utf8'),encoding:'utf8'});
  assert.equal(parsed.status,0,parsed.stderr);
  const workflow = JSON.parse(parsed.stdout), trigger = workflow.on || workflow.true;
  assert.deepEqual(Object.keys(trigger),['workflow_dispatch']);
  assert.deepEqual(trigger.workflow_dispatch.inputs.operation.options,operations);
  assert.equal(trigger.workflow_dispatch.inputs.operation.default,'incident');
  assert.equal(workflow.concurrency.group,'piles-production-host');
  assert.equal(workflow.concurrency['cancel-in-progress'],false);
  assert.equal(workflow.permissions.contents,'read');
  assert.equal(workflow.jobs.repair.environment,'production');
  for (const operation of operations) {
    const selected = Object.entries(workflow.jobs).filter(([id,job])=>id!=='validate' && JSON.parse(job.if.match(/fromJSON\('([^']+)'\)/)[1]).includes(operation));
    assert.equal(selected.length,1,operation);
    const job = selected[0][1];
    assert.equal(job.needs,'validate');
    const validatorIndex = job.steps.findIndex(s=>s.run==='node scripts/validate-piles-maintenance-inputs.mjs');
    const sshIndex = job.steps.findIndex(s=>s.uses?.startsWith('appleboy/ssh-action@'));
    assert.ok(validatorIndex>=0 && validatorIndex<sshIndex);
    assert.doesNotMatch(JSON.stringify(job.steps.slice(0,validatorIndex+1)),/\$\{\{\s*inputs\./);
  }
});
