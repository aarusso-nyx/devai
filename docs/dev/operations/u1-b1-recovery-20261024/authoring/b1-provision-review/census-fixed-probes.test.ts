import {vi,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const seen=vi.hoisted(()=>({readdirCalls:0,cursors:[] as {path:string,bufferSize:number,entries:number,readCalls:number,closeCalls:number}[]}));
vi.mock('node:fs',async(importOriginal)=>{const actual=await importOriginal<typeof import('node:fs')>();return {...actual,readdirSync:(...args:Parameters<typeof actual.readdirSync>)=>{seen.readdirCalls++;return actual.readdirSync(...args);},opendirSync:(path:string,options:{bufferSize:number})=>{const d=actual.opendirSync(path,options);const record={path,bufferSize:options.bufferSize,entries:0,readCalls:0,closeCalls:0};seen.cursors.push(record);return{readSync:()=>{record.readCalls++;const e=d.readSync();if(e!==null)record.entries++;return e;},closeSync:()=>{record.closeCalls++;return d.closeSync();}};}};});
import {readNativeReconciliationNamespace} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-host-namespace.ts';
const observations:unknown[]=[];
it('same actual10000entry closed root refuses after4cursor entries and closes',()=>{
 const prior=JSON.parse(readFileSync('/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/docs/dev/operations/u1-b1-recovery-20261024/authoring/b1-provision-review/census-native-observation.json','utf8'));const git=prior.fixture,root=join(git,'devai/reconciliation');seen.readdirCalls=0;seen.cursors=[];
 expect(()=>readNativeReconciliationNamespace({repository_root:git,git_dir:git,common_dir:git,private_root:root},{} as never)).toThrow('RECONCILIATION_PROVISION_INVALID');
 expect(seen.readdirCalls).toBe(0);expect(seen.cursors).toEqual([{path:root,bufferSize:4,entries:4,readCalls:4,closeCalls:1}]);observations.push({case:'same10000entryroot',...structuredClone(seen)});
});
it('empty private namespace uses cappedcursor for initial and final reread; both close',()=>{
 const git=realpathSync(mkdtempSync(join(tmpdir(),'devai-census-fixed-empty-')));const devai=join(git,'devai'),root=join(devai,'reconciliation');mkdirSync(devai,{mode:0o700});mkdirSync(root,{mode:0o700});seen.readdirCalls=0;seen.cursors=[];
 const namespace=readNativeReconciliationNamespace({repository_root:git,git_dir:git,common_dir:git,private_root:root},{} as never);
 expect(namespace.anchor).toBeNull();expect(namespace.issuer).toBeNull();expect(seen.readdirCalls).toBe(0);expect(seen.cursors).toEqual([{path:root,bufferSize:4,entries:0,readCalls:1,closeCalls:1},{path:root,bufferSize:4,entries:0,readCalls:1,closeCalls:1}]);observations.push({case:'emptyinitialandfinalreread',...structuredClone(seen)});
 writeFileSync('/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/docs/dev/operations/u1-b1-recovery-20261024/authoring/b1-provision-review/census-fixed-observation.json',JSON.stringify({node:process.versions.node,uv:process.versions.uv,platform:process.platform,observations},null,2)+'\n');
});
