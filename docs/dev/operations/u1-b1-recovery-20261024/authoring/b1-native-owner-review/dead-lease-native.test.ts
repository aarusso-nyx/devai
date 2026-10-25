import {spawn} from 'node:child_process';
import {hostname} from 'node:os';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,lstatSync,unlinkSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it,vi,afterEach,beforeAll,afterAll} from 'vitest';
import {canonicalJson} from '@devai-nyx/utils';
import {getValidator} from '@devai-nyx/schemas';
const hooks=vi.hoisted(()=>({afterGrantSync:undefined as undefined|(()=>void)}));
vi.mock('node:fs',async()=>{const actual=await vi.importActual<typeof import('node:fs')>('node:fs');const names=new Map<number,string>();return {...actual,openSync:(...a:unknown[])=>{const fd=Reflect.apply(actual.openSync,actual,a);names.set(fd,String(a[0]));return fd;},closeSync:(fd:number)=>{names.delete(fd);return actual.closeSync(fd);},fsyncSync:(fd:number)=>{actual.fsyncSync(fd);const name=names.get(fd)??'';if(name.includes('/.grant-')&&name.endsWith('.publish-staged'))hooks.afterGrantSync?.();}};});
import {createReconciliationDeadLeaseReview} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-host-dead-lease.ts';
import {createReconciliationHostInvocation,disposeReconciliationHostInvocation,reconciliationHostOperation,reconciliationHostOperationSnapshot} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-host-operation.ts';
import {runWithAuthorityHostEffects} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/host-scope.ts';
import {createAuthorityBoundaryRuntime} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/boundary-runtime.ts';
import {computeMutationEnvelopeDigest} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/index.ts';
import {boundaryDependencies} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/tests/unit/authority-boundary-testkit.ts';
import {createIssuer,runtimeApi,CONSENT,actionDocumentWithId,canonicalSha256,declarationDependencies,exactSubject,expectSuccess,makePolicyPlant,policyBindingFromPlant} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/tests/unit/authority-runtime-testkit.ts';
const root=process.env.DEVAI_NATIVE_DEAD_LEASE_FIXTURE!;if(!root)throw Error('explicit owned fixture required');
const original=JSON.parse(readFileSync(join(import.meta.dirname,'dead-lease-initial-results.json'),'utf8'));if(root!==original.fixture)throw Error('fixture provenance mismatch');
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


async function run<T>(operation:'recover-owned-lease',expected:string|undefined,fn:(scope:any,setBindings:(value:typeof bindings)=>void)=>T):Promise<T>{
 const api=await runtimeApi(),issuer=createIssuer(api),saved=process.argv;const tty=[process.stdin,process.stdout,process.stderr].map(stream=>({stream,descriptor:Object.getOwnPropertyDescriptor(stream,'isTTY')}));for(const{stream}of tty)Object.defineProperty(stream,'isTTY',{value:true,configurable:true});let currentBindings=bindings;
 const action='evidence reconcile approve',role='owner';process.argv=[process.execPath,'native-grant-fixture','evidence','reconcile','approve','--repo-root',root,'--plan',planPath,'--plan-sha256',planSha,'--approval',approvalId,'--recover-owned-lease',...(expected===undefined?[]:['--expected-lease-sha256',expected]),'--as-role','owner','--write','--format','json'];const argvHash=hash(canonicalJson(process.argv));
 const invocation=createReconciliationHostInvocation({invocation_id:'invocation-1',action_id:action,receipt_store:issuer,repository_root:root,repository_id:plan.identity.repository_id,original_argv_sha256:argvHash,initiator:'owner',operation,phases:[],write:true,require_tty:true,approval_id:approvalId,plan_path:planPath,plan_sha256:planSha,...(expected===undefined?{}:{expected_lease_sha256:expected}),readCurrentBindings:()=>currentBindings,verifyActual:()=>{if(hash(canonicalJson(process.argv))!==argvHash)throw Error('argv drift');}} as never);
 const scope={action_id:action,invocation_id:'invocation-1',effect:'local-write',receipt_store:issuer,reconciliation_invocation:invocation,apply_effect:(request:any,apply:()=>unknown)=>{const view=reconciliationHostOperation(request,invocation);if(!view)throw Error('missing operation');const target=view.target,g=issue(api,issuer,target,action,role);let result:unknown;const adapter={admit:(candidate:any)=>reconciliationHostOperation(request,invocation)===view&&canonicalSha256(candidate)===canonicalSha256(target),snapshot:()=>reconciliationHostOperationSnapshot(view,invocation,target),apply:()=>{effects++;result=apply();return result;}};const runtime=createAuthorityBoundaryRuntime(boundaryDependencies(issuer,[],{reconciliation_host:adapter}));const handle=expectSuccess(runtime.plannerRegistry.registerPlan({subject:g.subject,invocation_id:'invocation-1'}));const prepared=expectSuccess(runtime.prepare({subject:g.subject,plan_handle:handle,target,decision_receipt:g.receipt,adapter_id:'reconciliation-host-authority-boundary'}));expectSuccess(runtime.apply({prepared}));return result;}};
 try{return runWithAuthorityHostEffects(scope as never,()=>fn(scope,value=>{currentBindings=value;}));}finally{process.argv=saved;for(const{stream,descriptor}of tty){if(descriptor)Object.defineProperty(stream,'isTTY',descriptor);else Reflect.deleteProperty(stream,'isTTY');}disposeReconciliationHostInvocation(invocation);issuer.dispose();}
}

import {signReconciliationOwnerRecord,encodeReconciliationOwnerRecord} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/runtime/reconciliation-owner-record.ts';
const privateRoot=join(root,'.git/devai/reconciliation'),approvalRoot=join(privateRoot,'approvals',approvalId),leasePath=join(approvalRoot,'lease.json');
let child:ReturnType<typeof spawn>,leaseSha='',witness:any;const indexBefore=hash(readFileSync(join(root,'.git/index')));
beforeAll(async()=>{child=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore'});await once(child,'spawn');const issuer=JSON.parse(readFileSync(join(privateRoot,'issuer.json'),'utf8')),approval=JSON.parse(readFileSync(join(approvalRoot,'approval.json'),'utf8'));const base=(kind:string,n:number)=>({schemaVersion:'1.0.0',kind,domain:'devai.reconciliation.owner.v1/'+kind,repository_id:approval.repository_id,worktree_id:approval.worktree_id,clock:{...approval.clock,wall_ms:approval.clock.wall_ms+n,monotonic_ns:(BigInt(approval.clock.monotonic_ns)+BigInt(n)*1000000n).toString()},approval_id:approvalId,issuer_sha256:approval.issuer_sha256,approval_sha256:original.approved.approval_sha256,scope_sha256:approval.scope_sha256});const intent=encodeReconciliationOwnerRecord(signReconciliationOwnerRecord({...base('phase-intent',1),grant_sha256:grant,before_witness_sha256:'1'.repeat(64),output_plan_sha256:'2'.repeat(64),lease_nonce:'3'.repeat(64),invocation_id:'4'.repeat(64),phase:'01',action_id:'evidence reconcile materialize',initiator:'inspector',predecessor_completion_sha256:null},issuer.private_key_base64));writeFileSync(join(approvalRoot,'intent-01.json'),intent,{mode:0o600,flag:'wx'});const lease=encodeReconciliationOwnerRecord(signReconciliationOwnerRecord({...base('lease',2),grant_sha256:grant,original_intent_sha256:hash(intent),invocation_id:'4'.repeat(64),nonce:'3'.repeat(64),host_identity_sha256:approval.scope.host_identity_sha256,phase:'01',action_id:'evidence reconcile materialize',initiator:'inspector',pid:child.pid,hostname:hostname()},issuer.private_key_base64));writeFileSync(leasePath,lease,{mode:0o600,flag:'wx'});leaseSha=hash(lease);const stat=lstatSync(leasePath,{bigint:true});witness={dev:String(stat.dev),ino:String(stat.ino),birthtime_ns:String(stat.birthtimeNs)};},30000);
afterAll(()=>{child?.kill('SIGKILL');expect(hash(readFileSync(join(root,'.git/index')))).toBe(indexBefore);writeFileSync(join(import.meta.dirname,'dead-lease-native-results.json'),JSON.stringify({fixture:root,approval_id:approvalId,lease_sha256:leaseSha,witness,passed,index_sha256:indexBefore,effect_callbacks:effects,qualification:'Real native namespace, authenticated Owner records, typed policy receipts and actual child alive/SIGKILL/ESRCH. Intent/lease manually signed in disposable fixture; synthetic B5 and policy origin. No materialize or installed/public Owner claim.'},null,2)+'\n');});
it('refuses actual alive child without effects',async()=>{const before=effects;await expect(run('recover-owned-lease',leaseSha,()=>createReconciliationDeadLeaseReview(root))).rejects.toThrow('RECONCILIATION_APPROVAL_INVALID');expect(effects).toBe(before);expect(hash(readFileSync(leasePath))).toBe(leaseSha);child.kill('SIGKILL');await once(child,'exit');expect(()=>process.kill(child.pid!,0)).toThrow();passed.push('actual alive refuses; killed child reaches ESRCH');},30000);
it('refuses wrong and missing expected lease before effects',async()=>{const before=effects;for(const expected of ['f'.repeat(64),undefined])await expect(run('recover-owned-lease',expected,()=>createReconciliationDeadLeaseReview(root))).rejects.toThrow();expect(effects).toBe(before);passed.push('wrong/missing expected lease');},30000);
it('cancel, borrowed receiver, scope, replay and interrupt are closed',async()=>{const before=effects;await run('recover-owned-lease',leaseSha,(scope)=>{const h=createReconciliationDeadLeaseReview(root),p=h.preview();expect(p.lease_witness).toEqual(witness);expect(()=>Reflect.apply(h.confirm,{...h},[p.confirmation])).toThrow();expect(()=>runWithAuthorityHostEffects({...scope},()=>h.preview())).toThrow();expect(h.confirm('WRONG').outcome).toBe('cancelled');expect(()=>h.confirm(p.confirmation)).toThrow();expect(h.interrupt().outcome).toBe('cancelled');expect(()=>h.interrupt()).toThrow();});expect(effects).toBe(before);passed.push('cancel/borrowed/scope/replay/interrupt');},30000);
it('preserves unknown quarantine and refuses namespace drift',async()=>{await run('recover-owned-lease',leaseSha,()=>{const h=createReconciliationDeadLeaseReview(root),p=h.preview(),foreign=join(approvalRoot,'.lease.json.123-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.remove-quarantine');writeFileSync(foreign,'foreign',{mode:0o600});try{expect(()=>h.confirm(p.confirmation)).toThrow();expect(readFileSync(foreign,'utf8')).toBe('foreign');expect(hash(readFileSync(leasePath))).toBe(leaseSha);}finally{unlinkSync(foreign);}});passed.push('unknown quarantine preserved, no ownership inference');},30000);
it('refuses saved-plan drift before lease removal',async()=>{await run('recover-owned-lease',leaseSha,()=>{const h=createReconciliationDeadLeaseReview(root),p=h.preview();writeFileSync(join(root,planPath),Buffer.concat([planBytes,Buffer.from(' ')]));try{expect(()=>h.confirm(p.confirmation)).toThrow();expect(hash(readFileSync(leasePath))).toBe(leaseSha);}finally{writeFileSync(join(root,planPath),planBytes);}});passed.push('saved plan drift refuses before removal');},30000);
it('removes only exact authenticated dead lease and leaves grant and intent',async()=>{await run('recover-owned-lease',leaseSha,()=>{const h=createReconciliationDeadLeaseReview(root),p=h.preview();expect(p.effects).toHaveLength(1);const r=h.confirm(p.confirmation);expect(r.outcome).toBe('recovered');expect(r.lease_witness).toEqual(witness);expect(()=>h.confirm(p.confirmation)).toThrow();expect(h.interrupt().outcome).toBe('indeterminate');expect(()=>h.interrupt()).toThrow();});expect(existsSync(leasePath)).toBe(false);expect(hash(readFileSync(join(approvalRoot,'approval.json')))).toBe(grant);expect(readdirSync(approvalRoot).sort()).toEqual(['approval.json','intent-01.json']);passed.push('exact SHA/device/inode/birth removal; grants and intent unchanged');},30000);
it('ABSENT is explicit no-effect and stale old lease refuses',async()=>{await expect(run('recover-owned-lease',leaseSha,()=>createReconciliationDeadLeaseReview(root))).rejects.toThrow();await run('recover-owned-lease','ABSENT',()=>{const h=createReconciliationDeadLeaseReview(root),p=h.preview();expect(p.effects).toEqual([]);expect(p.lease_witness).toBeNull();expect(h.confirm(p.confirmation).outcome).toBe('absent');});passed.push('ABSENT explicit no filesystem effect; stale old lease refuses');},30000);
