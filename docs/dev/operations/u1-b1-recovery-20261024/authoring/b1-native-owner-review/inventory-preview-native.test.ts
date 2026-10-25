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
 const action='sense bootstrap-inventory',role='architect';process.argv=[process.execPath,'native-grant-fixture','sense','bootstrap-inventory','--repo-root',root,'--plan',planPath,'--plan-sha256',planSha,'--approval',approvalId,...(expected===undefined?[]:['--expected-grant-sha256',expected]),'--as-role','architect','--write','--format','json'];const argvHash=hash(canonicalJson(process.argv));
 const invocation=createReconciliationHostInvocation({invocation_id:'invocation-1',action_id:action,receipt_store:issuer,repository_root:root,repository_id:plan.identity.repository_id,original_argv_sha256:argvHash,initiator:'architect',operation,phases:['04'],write:true,require_tty:false,approval_id:approvalId,plan_path:planPath,plan_sha256:planSha,...(expected===undefined?{}:{expected_grant_sha256:expected}),readCurrentBindings:()=>currentBindings,verifyActual:()=>{if(hash(canonicalJson(process.argv))!==argvHash)throw Error('argv drift');}} as never);
 const scope={action_id:action,invocation_id:'invocation-1',effect:'local-write',receipt_store:issuer,reconciliation_invocation:invocation,apply_effect:(request:any,apply:()=>unknown)=>{const view=reconciliationHostOperation(request,invocation);if(!view)throw Error('missing operation');const target=view.target,g=issue(api,issuer,target,action,role);let result:unknown;const adapter={admit:(candidate:any)=>reconciliationHostOperation(request,invocation)===view&&canonicalSha256(candidate)===canonicalSha256(target),snapshot:()=>reconciliationHostOperationSnapshot(view,invocation,target),apply:()=>{effects++;result=apply();return result;}};const runtime=createAuthorityBoundaryRuntime(boundaryDependencies(issuer,[],{proof_index:adapter}));const handle=expectSuccess(runtime.plannerRegistry.registerPlan({subject:g.subject,invocation_id:'invocation-1'}));const prepared=expectSuccess(runtime.prepare({subject:g.subject,plan_handle:handle,target,decision_receipt:g.receipt,adapter_id:'proof-index-authority-boundary'}));expectSuccess(runtime.apply({prepared}));return result;}};
 try{return runWithAuthorityHostEffects(scope as never,()=>fn(scope,value=>{currentBindings=value;}));}finally{process.argv=saved;for(const{stream,descriptor}of tty){if(descriptor)Object.defineProperty(stream,'isTTY',descriptor);else Reflect.deleteProperty(stream,'isTTY');}disposeReconciliationHostInvocation(invocation);issuer.dispose();}
}

import {readReconciliationCustodyObjects} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-custody-input.ts';


import {readReconciliationInventoryInput} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-inventory-input.ts';
import {buildReconciliationInventoryBodies,createReconciliationInventoryReader} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/cli/src/commands/evidence/reconciliation-inventory-bodies.ts';
const indexPath=join(root,'.git/index'),beforeIndex=readFileSync(indexPath),privateDir=join(root,'.git/devai/reconciliation/approvals',approvalId),beforeNames=readdirSync(privateDir).sort(),epochs=plan.source_manifest.staged_files.filter((f:any)=>f.stage===0&&(f.path.startsWith('record/proofs/work/')||f.path==='record/proofs/anchor-baseline.json'));let input:any,bodies:any;
it('reads actual completed03 staged source and produces exactly seven closed-schema body previews without effects',async()=>{const start=performance.now();input=await run('consume-phase',undefined,()=>readReconciliationInventoryInput(root));expect(input.index_sha256).toBe(hash(beforeIndex));expect(input.predecessor_completion_sha256).toBe(JSON.parse(readFileSync(join(import.meta.dirname,'index-phase-settlement-results.json'),'utf8')).result.completion_sha256);const now=new Date(input.clock.wall_ms).toISOString();bodies=buildReconciliationInventoryBodies(root,input.plan,input.blobs,now);expect(bodies.outputs).toHaveLength(7);expect(bodies.grants_authority).toBe(false);expect(bodies.publishes_readings).toBe(false);expect(bodies.grants_readiness).toBe(false);for(const [i,o]of bodies.outputs.entries()){expect(o.path).toBe(plan.effect_plan.inventory.outputs[i].path);expect(getValidator(o.schema)(JSON.parse(o.text))).toBe(true);expect(hash(o.text)).toBe(o.sha256);expect(Buffer.byteLength(o.text)).toBe(o.bytes);expect(existsSync(join(root,o.path))).toBe(false);writeFileSync(join(import.meta.dirname,'inventory-preview-'+String(i+1)+'.json'),o.text);}expect(buildReconciliationInventoryBodies(root,input.plan,input.blobs,now)).toEqual(bodies);expect(effects).toBe(0);expect(readFileSync(indexPath)).toEqual(beforeIndex);expect(readdirSync(privateDir).sort()).toEqual(beforeNames);for(const f of epochs)expect(hash(readFileSync(join(root,f.path)))).toBe(f.sha256);writeFileSync(join(import.meta.dirname,'inventory-preview-native-results.json'),JSON.stringify({fixture:root,plan_sha256:planSha,index_sha256:input.index_sha256,predecessor_completion_sha256:input.predecessor_completion_sha256,blobs:input.blobs.size,duration_ms:performance.now()-start,...bodies,qualification:'Actual sealed04 native readonlyinput, authenticated03 stagedindex+Gitblobs; seven existing nativeproducers, schema-valid deterministicpreview bodies savedreviewdironly. No04intent/lease/completion, bodypublication/readiness/installedpublicclaim. SyntheticB5/policy/TTY.'},null,2)+'\n');},90000);
it('refuses stage0 blob-byte corruption and denies foreign/native-absent scope',async()=>{const map=new Map(input.blobs),id=map.keys().next().value!,bytes=Buffer.from(map.get(id)!);if(bytes.length)bytes[0]^=1;else map.set(id,Buffer.from('foreign'));if(bytes.length)map.set(id,bytes);expect(()=>createReconciliationInventoryReader(root,input.plan,map)).toThrow();expect(()=>readReconciliationInventoryInput(root)).toThrow();await run('consume-phase',undefined,scope=>{expect(()=>runWithAuthorityHostEffects({...scope,action_id:'check'},()=>readReconciliationInventoryInput(root))).toThrow();});expect(effects).toBe(0);expect(readFileSync(indexPath)).toEqual(beforeIndex);expect(readdirSync(privateDir).sort()).toEqual(beforeNames);},60000);
