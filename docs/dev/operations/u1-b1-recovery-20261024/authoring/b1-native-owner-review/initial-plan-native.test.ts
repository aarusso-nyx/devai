import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,realpathSync,renameSync,unlinkSync,symlinkSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {expect,it,vi} from 'vitest';
import {canonicalJson} from '@devai-nyx/utils';
const hook=vi.hoisted(()=>({afterGit:undefined as undefined|((args:readonly string[])=>void)}));
vi.mock('node:child_process',async()=>{const actual=await vi.importActual<typeof import('node:child_process')>('node:child_process');return {...actual,spawnSync:(command:string,args:readonly string[],options:unknown)=>{const result=Reflect.apply(actual.spawnSync,undefined,[command,args,options]);hook.afterGit?.(args);return result;}};});
import {execFileSync} from 'node:child_process';
import {readReconciliationPlan,readInitialReconciliationPlan} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-plan.ts';
import {createReconciliationHostInvocation,disposeReconciliationHostInvocation} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-host-operation.ts';
import {runWithAuthorityHostEffects} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/host-scope.ts';
import {createIssuer,runtimeApi} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/tests/unit/authority-runtime-testkit.ts';
const here=import.meta.dirname;
const original=JSON.parse(readFileSync(join(here,'native-plan-fixture.json'),'utf8'));
const base=realpathSync(mkdtempSync(join(tmpdir(),'devai-initial-owner-plan-'))),root=join(base,'repository');
execFileSync('/bin/cp',['-cR',original.fixture_root,root]);
const clientPath='.devai/native-owner-plan.json',absolute=join(root,clientPath);
mkdirSync(join(root,'.git/info'),{recursive:true});
writeFileSync(join(root,'.git/info/exclude'),readFileSync(join(root,'.git/info/exclude'),'utf8')+'\n/.devai/native-owner-plan*\n');
const bindings={package_sha256:'a'.repeat(64),module_sha256:'b'.repeat(64),registry_sha256:'c'.repeat(64),constitution_sha256:'d'.repeat(64),policy_sha256:'e'.repeat(64)};
const hash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
let effects=0;
async function run<T>(owner:boolean,planSha:string,fn:()=>T):Promise<T>{
 const issuer=createIssuer(await runtimeApi());const saved=process.argv;
 process.argv=[process.execPath,'synthetic-native-initial', 'evidence','reconcile',owner?'approve':'plan','--repo-root',root,...(owner?['--plan',clientPath,'--plan-sha256',planSha,'--write']:['--selected-parent',original.selected_parent,'--published-ref',original.published_ref]),'--as-role',owner?'owner':'architect','--format','json'];
 const argvHash=hash(canonicalJson(process.argv));
 const invocation=createReconciliationHostInvocation({invocation_id:'invocation-1',action_id:owner?'evidence reconcile approve':'evidence reconcile plan',receipt_store:issuer,repository_root:root,repository_id:'detran-native-initial-inspector',original_argv_sha256:argvHash,initiator:owner?'owner':'architect',operation:owner?'approve':'plan',phases:[],write:owner,require_tty:owner,...(owner?{plan_path:clientPath,plan_sha256:planSha}:{selected_parent:original.selected_parent,published_ref:original.published_ref}),readCurrentBindings:()=>bindings,verifyActual:()=>{if(hash(canonicalJson(process.argv))!==argvHash)throw new Error('synthetic argv drift');if(owner&&[process.stdin,process.stdout,process.stderr].some(s=>s.isTTY!==true))throw new Error('synthetic missing terminal');}});
 try{return runWithAuthorityHostEffects({action_id:owner?'evidence reconcile approve':'evidence reconcile plan',invocation_id:'invocation-1',effect:owner?'local-write':'read',receipt_store:issuer,reconciliation_invocation:invocation,apply_effect:()=>{effects++;throw new Error('no effects admitted');}},fn);}finally{process.argv=saved;disposeReconciliationHostInvocation(invocation);issuer.dispose();}
}
it('recaptures actual335 saved plan and refuses canonical/file/source drift without effects',async()=>{
 const tty=[process.stdin,process.stdout,process.stderr].map(stream=>({stream,descriptor:Object.getOwnPropertyDescriptor(stream,'isTTY')}));for(const {stream}of tty)Object.defineProperty(stream,'isTTY',{configurable:true,value:true});
 const passed:string[]=[];
 try{
  const plan=await run(false,'',()=>readReconciliationPlan(root));const bytes=Buffer.from(canonicalJson(plan)+'\n');writeFileSync(absolute,bytes);const digest=hash(bytes);
  const indexBefore=hash(readFileSync(join(root,'.git/index')));
  const captured=await run(true,digest,()=>readInitialReconciliationPlan(root));expect(canonicalJson(captured)).toBe(canonicalJson(plan));passed.push('actual335 exact saved-plan positive recapture');
  writeFileSync(absolute,Buffer.from(JSON.stringify(plan,null,2)+'\n'));await expect(run(true,hash(readFileSync(absolute)),()=>readInitialReconciliationPlan(root))).rejects.toThrow('RECONCILIATION_PLAN_INVALID');passed.push('noncanonical bytes refuse even with matching sealed digest');writeFileSync(absolute,bytes);
  await expect(run(true,'f'.repeat(64),()=>readInitialReconciliationPlan(root))).rejects.toThrow('RECONCILIATION_PLAN_INVALID');passed.push('sealed digest mismatch refuses');
  renameSync(absolute,absolute+'.backing');symlinkSync(absolute+'.backing',absolute);await expect(run(true,digest,()=>readInitialReconciliationPlan(root))).rejects.toThrow('RECONCILIATION_PLAN_INVALID');passed.push('leaf symlink refuses');unlinkSync(absolute);renameSync(absolute+'.backing',absolute);
  let swapped=false;hook.afterGit=args=>{if(!swapped&&args.includes('ls-remote')&&args.includes('--get-url')){swapped=true;renameSync(absolute,absolute+'.replaced');writeFileSync(absolute,bytes);}};
  await expect(run(true,digest,()=>readInitialReconciliationPlan(root))).rejects.toThrow('RECONCILIATION_PLAN_STALE');hook.afterGit=undefined;expect(swapped).toBe(true);passed.push('same bytes in replaced pathname inode refuse after actual capture');unlinkSync(absolute+'.replaced');
  const readme=join(root,'README.md'),readmeBytes=readFileSync(readme);let changed=false;hook.afterGit=args=>{if(!changed&&args.includes('ls-remote')&&args.includes('--get-url')){changed=true;writeFileSync(readme,Buffer.concat([readmeBytes,Buffer.from('\nINDEPENDENT SOURCE DRIFT\n')]));}};
  await expect(run(true,digest,()=>readInitialReconciliationPlan(root))).rejects.toThrow('RECONCILIATION_PLAN_SOURCE_INVALID');hook.afterGit=undefined;writeFileSync(readme,readmeBytes);expect(changed).toBe(true);passed.push('actual working source drift after initial snapshot refuses');
  expect(effects).toBe(0);expect(hash(readFileSync(join(root,'.git/index')))).toBe(indexBefore);
  writeFileSync(join(here,'initial-plan-native-results.json'),JSON.stringify({kind:'independent-native-initial-plan-fixture',fixture:root,qualification:'Actual historical Git and local bare remote; synthetic B5 and invocation origin; no installed/public Owner approval claim',passed,plan_sha256:digest,source_manifest_sha256:plan.source_manifest_sha256,index_sha256:indexBefore,effect_calls:effects,drift_hooks:'Harness-only actual spawnSync post-observation mutation; no runtime provider.'},null,2)+'\n');
 }finally{hook.afterGit=undefined;for(const {stream,descriptor}of tty){if(descriptor)Object.defineProperty(stream,'isTTY',descriptor);else Reflect.deleteProperty(stream,'isTTY');}}
},120000);
