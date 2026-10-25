import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {canonicalJson} from '@devai-nyx/utils';
import {readReconciliationCustodyObjects} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-custody-input.ts';
import {createReconciliationHostInvocation,disposeReconciliationHostInvocation} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-host-operation.ts';
import {runWithAuthorityHostEffects} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/host-scope.ts';
import {createIssuer,runtimeApi} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/tests/unit/authority-runtime-testkit.ts';
const root=process.env.DEVAI_NATIVE_CUSTODY_FIXTURE!;
if(!root)throw Error('explicit owned fixture required');
const planPath='.devai/native-owner-plan.json',bytes=readFileSync(join(root,planPath)),plan=JSON.parse(bytes.toString('utf8'));
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const approvalId=JSON.parse(readFileSync(join(import.meta.dirname,'custody-phase-initial-results.json'),'utf8')).approved.approval_id;
const bindings={package_sha256:'a'.repeat(64),module_sha256:'b'.repeat(64),registry_sha256:'c'.repeat(64),constitution_sha256:'d'.repeat(64),policy_sha256:'e'.repeat(64)};
let effects=0;
async function run<T>(fn:()=>T,stage=false){const issuer=createIssuer(await runtimeApi()),saved=process.argv,action=stage?'evidence reconcile stage-proof':'evidence reconcile materialize';process.argv=[process.execPath,'native-custody-fixture','evidence','reconcile',stage?'stage-proof':'materialize','--repo-root',root,'--plan',planPath,'--plan-sha256',sha(bytes),'--approval',approvalId,'--as-role','inspector','--write','--format','json'];const argv=sha(canonicalJson(process.argv));const invocation=createReconciliationHostInvocation({invocation_id:'invocation-1',action_id:action,receipt_store:issuer,repository_root:root,repository_id:plan.identity.repository_id,original_argv_sha256:argv,initiator:'inspector',operation:'consume-phase',phases:stage?['03']:['01','02'],write:true,require_tty:false,approval_id:approvalId,plan_path:planPath,plan_sha256:sha(bytes),readCurrentBindings:()=>bindings,verifyActual:()=>{if(sha(canonicalJson(process.argv))!==argv)throw Error('argv drift');}});try{return runWithAuthorityHostEffects({action_id:action,invocation_id:'invocation-1',effect:'local-write',receipt_store:issuer,reconciliation_invocation:invocation,apply_effect:()=>{effects++;throw Error('unexpected effect');}},fn);}finally{process.argv=saved;disposeReconciliationHostInvocation(invocation);issuer.dispose();}}

import {hasAuthenticatedReconciliationCheckpoint as checkpoint} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-checkpoint.ts';
it('authenticates actual native phase02-complete checkpoint in existing materialize scope',async()=>{const index=sha(readFileSync(join(root,'.git/index')));expect(await run(()=>checkpoint(root,join(root,'record/proofs/chain.json')))).toBe(true);expect(effects).toBe(0);expect(sha(readFileSync(join(root,'.git/index')))).toBe(index);},30000);
