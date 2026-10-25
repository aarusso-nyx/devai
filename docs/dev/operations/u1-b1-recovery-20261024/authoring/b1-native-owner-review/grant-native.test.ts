import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,lstatSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it,vi,afterEach} from 'vitest';
import {canonicalJson} from '@devai-nyx/utils';
import {getValidator} from '@devai-nyx/schemas';
const hooks=vi.hoisted(()=>({afterGrantSync:undefined as undefined|(()=>void)}));
vi.mock('node:fs',async()=>{const actual=await vi.importActual<typeof import('node:fs')>('node:fs');const names=new Map<number,string>();return {...actual,openSync:(...a:unknown[])=>{const fd=Reflect.apply(actual.openSync,actual,a);names.set(fd,String(a[0]));return fd;},closeSync:(fd:number)=>{names.delete(fd);return actual.closeSync(fd);},fsyncSync:(fd:number)=>{actual.fsyncSync(fd);const name=names.get(fd)??'';if(name.includes('/.grant-')&&name.endsWith('.publish-staged'))hooks.afterGrantSync?.();}};});
import {createReconciliationGrantReview} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-host-grant.ts';
import {createReconciliationHostInvocation,disposeReconciliationHostInvocation,reconciliationHostOperation,reconciliationHostOperationSnapshot} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-host-operation.ts';
import {runWithAuthorityHostEffects} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/host-scope.ts';
import {createAuthorityBoundaryRuntime} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/boundary-runtime.ts';
import {computeMutationEnvelopeDigest} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/index.ts';
import {boundaryDependencies} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/tests/unit/authority-boundary-testkit.ts';
import {createIssuer,runtimeApi,CONSENT,actionDocumentWithId,canonicalSha256,declarationDependencies,exactSubject,expectSuccess,makePolicyPlant,policyBindingFromPlant} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/tests/unit/authority-runtime-testkit.ts';
const root=process.env.DEVAI_NATIVE_GRANT_FIXTURE!;if(!root)throw Error('explicit owned fixture required');
const original=JSON.parse(readFileSync(join(import.meta.dirname,'approval-native-split-results.json'),'utf8'));if(root!==original.fixture)throw Error('fixture provenance mismatch');
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


async function run<T>(operation:'renew'|'revoke',expected:string|undefined,fn:(scope:any,setBindings:(value:typeof bindings)=>void)=>T):Promise<T>{
 const api=await runtimeApi(),issuer=createIssuer(api),saved=process.argv;const tty=[process.stdin,process.stdout,process.stderr].map(stream=>({stream,descriptor:Object.getOwnPropertyDescriptor(stream,'isTTY')}));for(const{stream}of tty)Object.defineProperty(stream,'isTTY',{value:true,configurable:true});let currentBindings=bindings;
 const action='evidence reconcile approve',role='owner';process.argv=[process.execPath,'native-grant-fixture','evidence','reconcile','approve','--repo-root',root,'--plan',planPath,'--plan-sha256',planSha,'--approval',approvalId,operation==='renew'?'--renew':'--revoke',...(expected===undefined?[]:['--expected-grant-sha256',expected]),'--as-role','owner','--write','--format','json'];const argvHash=hash(canonicalJson(process.argv));
 const invocation=createReconciliationHostInvocation({invocation_id:'invocation-1',action_id:action,receipt_store:issuer,repository_root:root,repository_id:plan.identity.repository_id,original_argv_sha256:argvHash,initiator:'owner',operation,phases:[],write:true,require_tty:true,approval_id:approvalId,plan_path:planPath,plan_sha256:planSha,...(expected===undefined?{}:{expected_grant_sha256:expected}),readCurrentBindings:()=>currentBindings,verifyActual:()=>{if(hash(canonicalJson(process.argv))!==argvHash)throw Error('argv drift');}} as never);
 const scope={action_id:action,invocation_id:'invocation-1',effect:'local-write',receipt_store:issuer,reconciliation_invocation:invocation,apply_effect:(request:any,apply:()=>unknown)=>{const view=reconciliationHostOperation(request,invocation);if(!view)throw Error('missing operation');const target=view.target,g=issue(api,issuer,target,action,role);let result:unknown;const adapter={admit:(candidate:any)=>reconciliationHostOperation(request,invocation)===view&&canonicalSha256(candidate)===canonicalSha256(target),snapshot:()=>reconciliationHostOperationSnapshot(view,invocation,target),apply:()=>{effects++;result=apply();return result;}};const runtime=createAuthorityBoundaryRuntime(boundaryDependencies(issuer,[],{reconciliation_host:adapter}));const handle=expectSuccess(runtime.plannerRegistry.registerPlan({subject:g.subject,invocation_id:'invocation-1'}));const prepared=expectSuccess(runtime.prepare({subject:g.subject,plan_handle:handle,target,decision_receipt:g.receipt,adapter_id:'reconciliation-host-authority-boundary'}));expectSuccess(runtime.apply({prepared}));return result;}};
 try{return runWithAuthorityHostEffects(scope as never,()=>fn(scope,value=>{currentBindings=value;}));}finally{process.argv=saved;for(const{stream,descriptor}of tty){if(descriptor)Object.defineProperty(stream,'isTTY',descriptor);else Reflect.deleteProperty(stream,'isTTY');}disposeReconciliationHostInvocation(invocation);issuer.dispose();}
}
it('rejects a stale explicit expected-grant selector before publication',async()=>{const before=effects;await expect(run('renew','f'.repeat(64),()=>createReconciliationGrantReview(root))).rejects.toThrow('RECONCILIATION_APPROVAL_STALE');expect(effects).toBe(before);passed.push('stale expected-grant refuses');},30000);
it('requires sealed expected-grant even for legacy controls missing that field',async()=>{const before=effects;await expect(run('renew',undefined,()=>createReconciliationGrantReview(root))).rejects.toThrow('RECONCILIATION_APPROVAL_STALE');expect(effects).toBe(before);passed.push('missing sealed expected-grant refuses');},30000);
it('cancels and rejects borrowed receiver, changed scope and replay',async()=>{const before=effects;await run('renew',grant,(scope)=>{const h=createReconciliationGrantReview(root),p=h.preview();expect(()=>Reflect.apply(h.confirm,{...h},[p.confirmation])).toThrow('RECONCILIATION_APPROVAL_INVALID');expect(()=>runWithAuthorityHostEffects({...scope},()=>h.preview())).toThrow('RECONCILIATION_APPROVAL_INVALID');expect(h.confirm('WRONG').outcome).toBe('cancelled');expect(()=>h.confirm(p.confirmation)).toThrow('RECONCILIATION_APPROVAL_INVALID');expect(h.interrupt().outcome).toBe('cancelled');expect(()=>h.interrupt()).toThrow('RECONCILIATION_APPROVAL_INVALID');});expect(effects).toBe(before);passed.push('cancel/borrowed/scope/replay');},30000);
it('refuses controlled B5 policy drift before effects',async()=>{const before=effects;await run('renew',grant,(_scope,setBindings)=>{const h=createReconciliationGrantReview(root),p=h.preview();setBindings({...bindings,policy_sha256:'f'.repeat(64)});expect(()=>h.confirm(p.confirmation)).toThrow('RECONCILIATION_APPROVAL_STALE');expect(h.interrupt().outcome).toBe('cancelled');});expect(effects).toBe(before);passed.push('synthetic controlled B5 policy drift');},30000);
it('preserves namespace competitor before grant publication',async()=>{await run('renew',grant,()=>{const h=createReconciliationGrantReview(root),p=h.preview(),foreign=join(root,'.git/devai/reconciliation/foreign-grant-competitor');writeFileSync(foreign,'preserve',{mode:0o600});try{expect(()=>h.confirm(p.confirmation)).toThrow();expect(readFileSync(foreign,'utf8')).toBe('preserve');}finally{unlinkSync(foreign);}expect(h.interrupt().outcome).toBe('cancelled');});passed.push('namespace competitor retained');},30000);
it('detects saved-plan drift during scratch publication without clean renewal',async()=>{await run('renew',grant,()=>{const h=createReconciliationGrantReview(root),p=h.preview();let changed=false;hooks.afterGrantSync=()=>{if(changed)return;changed=true;writeFileSync(join(root,planPath),Buffer.concat([planBytes,Buffer.from(' ')]));};try{const r=h.confirm(p.confirmation);expect(changed).toBe(true);expect(r.outcome).toBe('indeterminate');}finally{hooks.afterGrantSync=undefined;writeFileSync(join(root,planPath),planBytes);}});passed.push('saved-plan drift during publication retains uncertainty');},30000);
it('renews then revokes exact immutable sequence and refuses terminal continuation',async()=>{const index=hash(readFileSync(join(root,'.git/index')));const renewed=await run('renew',grant,()=>{const h=createReconciliationGrantReview(root),p=h.preview();expect(p.sequence).toBe(2);expect(p.prior_grant_sha256).toBe(grant);const r=h.confirm(p.confirmation);expect(r.outcome).toBe('renewed');const path=join(root,'.git/devai/reconciliation/approvals',approvalId,'grant-000002.json');const raw=readFileSync(path),stat=lstatSync(path,{bigint:true}),record=JSON.parse(raw.toString('utf8'));expect(hash(raw)).toBe(p.record_sha256);expect(Number(stat.mode&0o7777n)).toBe(0o600);expect(r.owned[0]).toMatchObject({dev:String(stat.dev),ino:String(stat.ino),birthtime_ns:String(stat.birthtimeNs)});expect(record.remaining_phases).toEqual(['01','02','03','04']);expect(record.resumable_intent_sha256).toBeNull();return r;});grant=renewed.record_sha256;const revoked=await run('revoke',grant,()=>{const h=createReconciliationGrantReview(root),p=h.preview();expect(p.sequence).toBe(3);expect(p.prior_grant_sha256).toBe(grant);const r=h.confirm(p.confirmation);expect(r.outcome).toBe('revoked');return r;});grant=revoked.record_sha256;await expect(run('renew',grant,()=>createReconciliationGrantReview(root))).rejects.toThrow('RECONCILIATION_APPROVAL_INVALID');await expect(run('revoke',grant,()=>createReconciliationGrantReview(root))).rejects.toThrow('RECONCILIATION_APPROVAL_INVALID');expect(hash(readFileSync(join(root,'.git/index')))).toBe(index);passed.push('renew sequence2; revoke sequence3; revoked terminal');writeFileSync(join(import.meta.dirname,'grant-native-results.json'),JSON.stringify({kind:'independent-native-grant-review',fixture:root,approval_id:approvalId,passed,renewed,revoked,index_sha256:index,effect_callbacks:effects,qualification:'Actual native signed grants/admission/typed receipts; synthetic B5 and policy origin; no public installed Owner route.'},null,2)+'\n');},60000);
