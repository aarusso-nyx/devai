import {execFileSync} from 'node:child_process';
import {inflateSync,deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,lstatSync,unlinkSync,readdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it,vi,afterEach} from 'vitest';
import {canonicalJson} from '@devai-nyx/utils';
import {getValidator} from '@devai-nyx/schemas';
const hooks=vi.hoisted(()=>({afterGrantSync:undefined as undefined|(()=>void)}));
vi.mock('node:fs',async()=>{const actual=await vi.importActual<typeof import('node:fs')>('node:fs');const names=new Map<number,string>();return {...actual,openSync:(...a:unknown[])=>{const fd=Reflect.apply(actual.openSync,actual,a);names.set(fd,String(a[0]));return fd;},closeSync:(fd:number)=>{names.delete(fd);return actual.closeSync(fd);},fsyncSync:(fd:number)=>{actual.fsyncSync(fd);const name=names.get(fd)??'';if(name.includes('/.grant-')&&name.endsWith('.publish-staged'))hooks.afterGrantSync?.();}};});
import {stageReconciliationProof} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-index-phase.ts';
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
    boundary_adapter_id: 'proof-index-authority-boundary',
  }) as { issued: boolean; receipt: unknown };
  expect(decision.issued).toBe(true);
  return { subject, receipt: decision.receipt };
}


async function run<T>(operation:'consume-phase',expected:string|undefined,fn:(scope:any,setBindings:(value:typeof bindings)=>void)=>T):Promise<T>{
 const api=await runtimeApi(),issuer=createIssuer(api),saved=process.argv;const tty=[process.stdin,process.stdout,process.stderr].map(stream=>({stream,descriptor:Object.getOwnPropertyDescriptor(stream,'isTTY')}));for(const{stream}of tty)Object.defineProperty(stream,'isTTY',{value:true,configurable:true});let currentBindings=bindings;
 const action='evidence reconcile stage-proof',role='inspector';process.argv=[process.execPath,'native-grant-fixture','evidence','reconcile','stage-proof','--repo-root',root,'--plan',planPath,'--plan-sha256',planSha,'--approval',approvalId,...(expected===undefined?[]:['--expected-grant-sha256',expected]),'--as-role','inspector','--write','--format','json'];const argvHash=hash(canonicalJson(process.argv));
 const invocation=createReconciliationHostInvocation({invocation_id:'invocation-1',action_id:action,receipt_store:issuer,repository_root:root,repository_id:plan.identity.repository_id,original_argv_sha256:argvHash,initiator:'inspector',operation,phases:['03'],write:true,require_tty:false,approval_id:approvalId,plan_path:planPath,plan_sha256:planSha,...(expected===undefined?{}:{expected_grant_sha256:expected}),readCurrentBindings:()=>currentBindings,verifyActual:()=>{if(hash(canonicalJson(process.argv))!==argvHash)throw Error('argv drift');}} as never);
 const scope={action_id:action,invocation_id:'invocation-1',effect:'local-write',receipt_store:issuer,reconciliation_invocation:invocation,apply_effect:(request:any,apply:()=>unknown)=>{const view=reconciliationHostOperation(request,invocation);if(!view)throw Error('missing operation');const target=view.target,g=issue(api,issuer,target,action,role);let result:unknown;const adapter={admit:(candidate:any)=>reconciliationHostOperation(request,invocation)===view&&canonicalSha256(candidate)===canonicalSha256(target),snapshot:()=>reconciliationHostOperationSnapshot(view,invocation,target),apply:()=>{effects++;result=apply();return result;}};const runtime=createAuthorityBoundaryRuntime(boundaryDependencies(issuer,[],{proof_index:adapter}));const handle=expectSuccess(runtime.plannerRegistry.registerPlan({subject:g.subject,invocation_id:'invocation-1'}));const prepared=expectSuccess(runtime.prepare({subject:g.subject,plan_handle:handle,target,decision_receipt:g.receipt,adapter_id:'proof-index-authority-boundary'}));expectSuccess(runtime.apply({prepared}));return result;}};
 try{return runWithAuthorityHostEffects(scope as never,()=>fn(scope,value=>{currentBindings=value;}));}finally{process.argv=saved;for(const{stream,descriptor}of tty){if(descriptor)Object.defineProperty(stream,'isTTY',descriptor);else Reflect.deleteProperty(stream,'isTTY');}disposeReconciliationHostInvocation(invocation);issuer.dispose();}
}

import {readReconciliationCustodyObjects} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-custody-input.ts';


import {readReconciliationDomainFile} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-phase-files.ts';
import {hasAuthenticatedReconciliationCheckpoint} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-checkpoint.ts';
import {realpathSync,readlinkSync} from 'node:fs';
import {dirname} from 'node:path';
import {hasReconciliationCheckpointUnderAdmission} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-checkpoint.ts';
import {captureReconciliationHostContext,readReconciliationHostPaths,disposeReconciliationHostContext} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-host-context.ts';
import {readReconciliationHostBinding} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-host-operation.ts';
import {readNativeReconciliationNamespace} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-host-namespace.ts';
import {withReconciliationAdmissionSteps} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/host-reconciliation-admission.ts';
import {readReconciliationHostApprovalUnderAdmission} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-host-owner.ts';
import {assessReconciliationOwnerPhase} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/runtime/reconciliation-owner-state.ts';
it('read-only postCAS diagnostic retains actual evidence',async()=>{const faults:any[]=[];readReconciliationDomainFile(join(root,'.git/index'),undefined,true,false);const pure=JSON.parse(readFileSync(join(import.meta.dirname,'proof-index-pure-provenance-results.json'),'utf8')),oid=pure.blob_oid;readReconciliationDomainFile(join(root,'.git/objects',oid.slice(0,2),oid.slice(2)),undefined,true,false);const check=(name:string,fn:()=>unknown)=>{try{fn();}catch(e){faults.push({name,error:String(e),stack:(e as Error).stack});}};for(const entry of plan.source_manifest.staged_files){if(entry.stage!==0||entry.path==='record/proofs/chain.json'||entry.path==='law/security/authorization.json')continue;check(entry.path,()=>{const p=join(root,entry.path);if(realpathSync(dirname(p))!==dirname(p))throw Error('parent');if(entry.mode==='120000'){const before=lstatSync(p,{bigint:true}),bytes=readlinkSync(p,{encoding:'buffer'}),after=lstatSync(p,{bigint:true});if(!before.isSymbolicLink()||before.dev!==after.dev||before.ino!==after.ino||before.birthtimeNs!==after.birthtimeNs||before.ctimeNs!==after.ctimeNs||bytes.length!==entry.bytes||hash(bytes)!==entry.sha256)throw Error('symlink');}else{const f=readReconciliationDomainFile(p,entry,false,false);if(((BigInt(f.witness.mode)&0o100n)!==0n)!==(entry.mode==='100755'))throw Error('mode');}});}await run('consume-phase',undefined,()=>{check('admitted-checkpoint',()=>{const binding=readReconciliationHostBinding(),ctx=captureReconciliationHostContext(root,binding.identity.repository_id);try{const paths=readReconciliationHostPaths(ctx),ns=readNativeReconciliationNamespace(paths,binding.identity);withReconciliationAdmissionSteps(paths.private_root,ns.anchor!,()=>{const state=readReconciliationHostApprovalUnderAdmission(root,approvalId,ns.anchor!);if(assessReconciliationOwnerPhase(state.state,'03',state.clock,'complete').disposition!=='settle')throw Error('not settle');if(!hasReconciliationCheckpointUnderAdmission(root,join(root,'record/proofs/chain.json'),ns.anchor!))throw Error('admitted checkpoint false');});if(ns.issuer)ns.issuer.bytes.fill(0);}finally{disposeReconciliationHostContext(ctx);}});check('checkpoint',()=>{if(!hasAuthenticatedReconciliationCheckpoint(root,join(root,'record/proofs/chain.json')))throw Error('checkpoint false');});});writeFileSync(join(import.meta.dirname,'index-phase-postCAS-diagnostic.json'),JSON.stringify({faults,index_sha256:hash(readFileSync(join(root,'.git/index')))},null,2)+'\n');expect(faults).toEqual([]);},60000);
