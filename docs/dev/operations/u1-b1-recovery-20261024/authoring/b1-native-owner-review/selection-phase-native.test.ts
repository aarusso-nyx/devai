import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,lstatSync,unlinkSync,readdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it,vi,afterEach} from 'vitest';
import {canonicalJson} from '@devai-nyx/utils';
import {getValidator} from '@devai-nyx/schemas';
const hooks=vi.hoisted(()=>({afterGrantSync:undefined as undefined|(()=>void)}));
vi.mock('node:fs',async()=>{const actual=await vi.importActual<typeof import('node:fs')>('node:fs');const names=new Map<number,string>();return {...actual,openSync:(...a:unknown[])=>{const fd=Reflect.apply(actual.openSync,actual,a);names.set(fd,String(a[0]));return fd;},closeSync:(fd:number)=>{names.delete(fd);return actual.closeSync(fd);},fsyncSync:(fd:number)=>{actual.fsyncSync(fd);const name=names.get(fd)??'';if(name.includes('/.grant-')&&name.endsWith('.publish-staged'))hooks.afterGrantSync?.();}};});
import {materializeReconciliationSelection} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-selection-phase.ts';
import {createReconciliationHostInvocation,disposeReconciliationHostInvocation,reconciliationHostOperation,reconciliationHostOperationSnapshot} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-host-operation.ts';
import {runWithAuthorityHostEffects} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/host-scope.ts';
import {createAuthorityBoundaryRuntime} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/boundary-runtime.ts';
import {computeMutationEnvelopeDigest} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/index.ts';
import {boundaryDependencies} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/tests/unit/authority-boundary-testkit.ts';
import {createIssuer,runtimeApi,CONSENT,actionDocumentWithId,canonicalSha256,declarationDependencies,exactSubject,expectSuccess,makePolicyPlant,policyBindingFromPlant} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/tests/unit/authority-runtime-testkit.ts';
const root=process.env.DEVAI_NATIVE_PHASE_FIXTURE!;if(!root)throw Error('explicit owned fixture required');
const original=JSON.parse(readFileSync(join(import.meta.dirname,'custody-phase-initial-results.json'),'utf8'));if(root!==original.fixture)throw Error('fixture provenance mismatch');
const approvalId=original.approved.approval_id,planPath='.devai/native-owner-plan.json',planBytes=readFileSync(join(root,planPath)),plan=JSON.parse(planBytes.toString('utf8'));
const hash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');const planSha=hash(planBytes);
const bindings={package_sha256:'a'.repeat(64),module_sha256:'b'.repeat(64),registry_sha256:'c'.repeat(64),constitution_sha256:'d'.repeat(64),policy_sha256:'e'.repeat(64)};
let effects=0;const passed:string[]=[];let grant=original.approved.approval_sha256;
afterEach(()=>{hooks.afterGrantSync=undefined;});
function issue(api: any, issuer: any, target: any, action: string, role: string) {
  const rule = {
    rule_id: 'native-provision-fixture',
    origin: 'additive-extension',
    precedence: 500,
    action_ids: [action],
    selector: {
      kind: target.kind,
      repository_id: target.repository_id,
      operations: [target.operation],
    },
    effect: 'allow',
    subjects: [{ kind: 'human', roles: [role] }],
    required_consent: CONSENT,
    constitutional_anchors: [6],
    rationale: 'Owned actual native fixture; deterministic B5 is not installed origin.',
  };
  const plant = makePolicyPlant({ additiveRules: [rule] });
  expect(getValidator('authority-policy.schema.json')(plant.document)).toBe(true);
  const context = expectSuccess<{ context_receipt: unknown }>(
    api.resolveAuthorityDeclaration(
      {
        action_id: action,
        invocation_id: 'invocation-1',
        dry_run: false,
        declaration: { as_role: role },
        consent: CONSENT,
      },
      declarationDependencies(
        issuer,
        actionDocumentWithId(action, 'local-write', { kind: 'human', allowed_roles: [role] }),
        undefined,
        policyBindingFromPlant(plant),
      ),
    ),
  );
  const policy = expectSuccess(api.loadAuthorityPolicy({ document: plant.document }, plant.deps));
  const resolution = api.resolveAuthorityPolicy(
    policy,
    {
      action_id: action,
      context_receipt: context.context_receipt,
      consent: CONSENT,
      resource: target,
      operation: target.operation,
    },
    { receiptStore: issuer, canonicalSha256 },
  );
  expect(resolution).toMatchObject({ outcome: 'allow' });
  const base = exactSubject([target], plant) as { plan: { envelope: MutationEnvelope } };
  const envelope = {
    ...base.plan.envelope,
    request: { ...base.plan.envelope.request, action_id: action },
  } as any;
  const subject = {
    plan: {
      ...base.plan,
      envelope: {
        ...envelope,
        issued_by: {
          ...envelope.issued_by,
          envelope_digest_sha256: computeMutationEnvelopeDigest(envelope),
        },
      },
    },
  };
  const decision = issuer.issueAllow({
    resolutions: [resolution],
    subject,
    context_receipt: context.context_receipt,
    invocation_id: 'invocation-1',
    boundary_adapter_id: 'reconciliation-host-authority-boundary',
  }) as { issued: boolean; receipt: unknown };
  expect(decision.issued).toBe(true);
  return { subject, receipt: decision.receipt };
}


async function run<T>(operation:'consume-phase',expected:string|undefined,fn:(scope:any,setBindings:(value:typeof bindings)=>void)=>T):Promise<T>{
 const api=await runtimeApi(),issuer=createIssuer(api),saved=process.argv;const tty=[process.stdin,process.stdout,process.stderr].map(stream=>({stream,descriptor:Object.getOwnPropertyDescriptor(stream,'isTTY')}));for(const{stream}of tty)Object.defineProperty(stream,'isTTY',{value:true,configurable:true});let currentBindings=bindings;
 const action='evidence reconcile materialize',role='inspector';process.argv=[process.execPath,'native-grant-fixture','evidence','reconcile','materialize','--repo-root',root,'--plan',planPath,'--plan-sha256',planSha,'--approval',approvalId,...(expected===undefined?[]:['--expected-grant-sha256',expected]),'--as-role','inspector','--write','--format','json'];const argvHash=hash(canonicalJson(process.argv));
 const invocation=createReconciliationHostInvocation({invocation_id:'invocation-1',action_id:action,receipt_store:issuer,repository_root:root,repository_id:plan.identity.repository_id,original_argv_sha256:argvHash,initiator:'inspector',operation,phases:['01','02'],write:true,require_tty:false,approval_id:approvalId,plan_path:planPath,plan_sha256:planSha,...(expected===undefined?{}:{expected_grant_sha256:expected}),readCurrentBindings:()=>currentBindings,verifyActual:()=>{if(hash(canonicalJson(process.argv))!==argvHash)throw Error('argv drift');}} as never);
 const scope={action_id:action,invocation_id:'invocation-1',effect:'local-write',receipt_store:issuer,reconciliation_invocation:invocation,apply_effect:(request:any,apply:()=>unknown)=>{const view=reconciliationHostOperation(request,invocation);if(!view)throw Error('missing operation');const target=view.target,g=issue(api,issuer,target,action,role);let result:unknown;const adapter={admit:(candidate:any)=>reconciliationHostOperation(request,invocation)===view&&canonicalSha256(candidate)===canonicalSha256(target),snapshot:()=>reconciliationHostOperationSnapshot(view,invocation,target),apply:()=>{effects++;result=apply();return result;}};const runtime=createAuthorityBoundaryRuntime(boundaryDependencies(issuer,[],{reconciliation_host:adapter}));const handle=expectSuccess(runtime.plannerRegistry.registerPlan({subject:g.subject,invocation_id:'invocation-1'}));const prepared=expectSuccess(runtime.prepare({subject:g.subject,plan_handle:handle,target,decision_receipt:g.receipt,adapter_id:'reconciliation-host-authority-boundary'}));expectSuccess(runtime.apply({prepared}));return result;}};
 try{return runWithAuthorityHostEffects(scope as never,()=>fn(scope,value=>{currentBindings=value;}));}finally{process.argv=saved;for(const{stream,descriptor}of tty){if(descriptor)Object.defineProperty(stream,'isTTY',descriptor);else Reflect.deleteProperty(stream,'isTTY');}disposeReconciliationHostInvocation(invocation);issuer.dispose();}
}

import {readReconciliationCustodyObjects} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-custody-input.ts';

const privateDir=join(root,'.git/devai/reconciliation/approvals',approvalId),active=join(root,plan.effect_plan.selection.active_path),indexPath=join(root,'.git/index');
const priorIndex=hash(readFileSync(indexPath)),priorChain=readFileSync(active);let complete:any;
it.each(['source','index','chain','lock','candidate','ignored-custody-scratch'])('refuses stale or foreign %s before new intent and preserves evidence',async(kind)=>{const recipe=plan.effect_plan.selection;let path='',saved:Buffer|undefined,cleanup=()=>{};if(kind==='source')path=join(root,'README.md');if(kind==='index')path=indexPath;if(kind==='chain')path=active;if(['source','index','chain'].includes(kind)){saved=readFileSync(path);const changed=Buffer.from(saved);if(kind==='index')changed[changed.length-1]^=1;writeFileSync(path,kind==='index'?changed:Buffer.concat([saved,Buffer.from(' ')]));cleanup=()=>writeFileSync(path,saved!);}else{path=join(root,kind==='lock'?recipe.append_lock_path:kind==='candidate'?recipe.candidate_path:plan.effect_plan.namespace+'/objects/.foreign-preserve.publish-staged');writeFileSync(path,'foreign',{mode:0o600,flag:'wx'});if(kind==='ignored-custody-scratch'){const exclude=join(root,'.git/info/exclude'),before=readFileSync(exclude);writeFileSync(exclude,Buffer.concat([before,Buffer.from('\n/'+path.slice(root.length+1)+'\n')]));cleanup=()=>{unlinkSync(path);writeFileSync(exclude,before);};}else cleanup=()=>unlinkSync(path);}const changed=readFileSync(path);try{await expect(run('consume-phase',undefined,()=>materializeReconciliationSelection(root))).rejects.toThrow();expect(readFileSync(path)).toEqual(changed);expect(existsSync(join(privateDir,'intent-02.json'))).toBe(false);expect(existsSync(join(privateDir,'lease.json'))).toBe(false);}finally{cleanup();}expect(hash(readFileSync(indexPath))).toBe(priorIndex);expect(readFileSync(active)).toEqual(priorChain);},60000);
it('publishes exact selected335 prefix plus one normal event and native phase02 completion',async()=>{const started=performance.now();complete=await run('consume-phase',undefined,()=>materializeReconciliationSelection(root));expect(complete.outcome).toBe('completed');const actual=readFileSync(active),candidate=JSON.parse(actual.toString('utf8')),selected=JSON.parse(readFileSync(join(root,plan.effect_plan.selection.selected_object_path),'utf8'));expect(selected.records).toHaveLength(335);expect(candidate.records).toHaveLength(336);expect(candidate.records.slice(0,335)).toEqual(selected.records);const event=candidate.records.at(-1);expect(event.action).toBe('evidence.reconcile.canonical-selection');expect(event.previous_run_hash).toBe(selected.head);expect(candidate.head).toBe(event.manifest_hash);const receiptBytes=readFileSync(join(root,plan.effect_plan.selection.receipt_path)),receipt=JSON.parse(receiptBytes.toString('utf8'));expect(event.artifacts.map((a:any)=>a.sha256)).toEqual([plan.effect_plan.custody.manifest.sha256,plan.effect_plan.selection.selected_chain_sha256,hash(receiptBytes)]);expect(receipt.approval_id).toBe(approvalId);expect(receipt.plan_sha256).toBe(planSha);expect(hash(readFileSync(indexPath))).toBe(priorIndex);for(const f of plan.source_manifest.staged_files.filter((f:any)=>f.path.startsWith('record/proofs/work/')||f.path==='record/proofs/anchor-baseline.json'))expect(hash(readFileSync(join(root,f.path)))).toBe(f.sha256);expect(existsSync(join(root,plan.effect_plan.selection.append_lock_path))).toBe(false);expect(existsSync(join(root,plan.effect_plan.selection.candidate_path))).toBe(false);expect(existsSync(join(privateDir,'lease.json'))).toBe(false);expect(hash(readFileSync(join(privateDir,'intent-02.json')))).toBe(complete.intent_sha256);expect(hash(readFileSync(join(privateDir,'phase-02.json')))).toBe(complete.completion_sha256);writeFileSync(join(import.meta.dirname,'selection-phase-native-results.json'),JSON.stringify({fixture:root,approval_id:approvalId,prior_chain_sha256:hash(priorChain),current_chain_sha256:hash(actual),receipt_sha256:hash(receiptBytes),index_sha256:priorIndex,duration_ms:performance.now()-started,result:complete,qualification:'Actual native phase01-completed335 fixture, real renewal, native intent/lease/append-lock/candidate/rename/completion; exact original335prefix+one normal event, epochs/index preserved. Synthetic B5/policy/TTY. No installed/public checkpoint or recovery completion claim.'},null,2)+'\n');},180000);
it('repeat recognizes authenticated exact selected output without new ownership',async()=>{const before=readFileSync(active);const repeat=await run('consume-phase',undefined,()=>materializeReconciliationSelection(root));expect(repeat.outcome).toBe('existing');expect(repeat.completion_sha256).toBe(complete.completion_sha256);expect(repeat.owned).toEqual([]);expect(readFileSync(active)).toEqual(before);expect(hash(readFileSync(indexPath))).toBe(priorIndex);},30000);
