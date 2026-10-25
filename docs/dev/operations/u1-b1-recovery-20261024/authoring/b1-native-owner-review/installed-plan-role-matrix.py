"""Actual installed subprocess routes; disposable full historical clone; no broker/TTY mocks."""
import hashlib,json,os,subprocess,tempfile
from pathlib import Path
package=Path(os.environ['DEVAI_PLAN_TEST_PACKAGE']).resolve(strict=True)
fixture=json.loads(Path('/private/tmp/devai-detran-rehearsal-20261024/public-plan-03.json').read_text())
base=Path(tempfile.mkdtemp(prefix='devai-installed-plan-role-')).resolve()
root=base/'repository';subprocess.run(['/bin/cp','-cR',fixture['root'],str(root)],check=True)
bin=package/'dist/runtime/index/bin.js'
env={**os.environ,'NO_COLOR':'1','GIT_OPTIONAL_LOCKS':'0'}
def sha(b):return hashlib.sha256(b).hexdigest()
def git(*a):return subprocess.check_output(['/usr/bin/git','--no-optional-locks',*a],cwd=root,env=env)
def snapshot():
 index=git('rev-parse','--git-path','index').decode().strip()
 return {'index':sha((root/index).read_bytes()),'head':git('rev-parse','HEAD').decode().strip(),'merge_head':(root/'.git/MERGE_HEAD').read_text(),'policy':sha((root/'.devai/config/authority-policy.json').read_bytes())}
common=['evidence','reconcile','plan','--repo-root',str(root),'--selected-parent',fixture['selected_parent'],'--published-ref',fixture['published_ref'],'--format','json']
cases=[('missing-role',[]),('owner',['--as-role','owner']),('inspector',['--as-role','inspector']),('wrong-case',['--as-role','Architect']),('session',['--authority-session','fake']),('architect-session',['--as-role','architect','--authority-session','fake']),('write',['--as-role','architect','--write']),('publish',['--as-role','architect','--publish']),('experimental',['--as-role','architect','--experimental']),('duplicate-role',['--as-role','architect','--as-role','architect']),('conflicting-role',['--as-role','architect','--as-role','owner'])]
before=snapshot();results=[]
for name,flags in cases:
 p=subprocess.run(['node',str(bin),*common,*flags],cwd=root,env=env,capture_output=True,timeout=30)
 (base/(name+'.stdout')).write_bytes(p.stdout);(base/(name+'.stderr')).write_bytes(p.stderr)
 assert p.returncode!=0,(name,p.stdout[-2000:],p.stderr[-2000:])
 error=json.loads(p.stderr)['error']
 expected='AUTHORITY_HUMAN_ROLE_DENIED' if name in ['missing-role','owner','inspector','wrong-case'] else 'AUTHORITY_RECONCILIATION_INVOCATION_INVALID' if name in ['duplicate-role','conflicting-role'] else 'AUTHORITY_DECLARATION_NOT_APPLICABLE'
 assert error['code']==expected,(name,error)
 results.append({'case':name,'exit':p.returncode,'stdout_sha256':sha(p.stdout),'stderr_sha256':sha(p.stderr),'error_code':error['code'],'error_class':error['class']})
p=subprocess.run(['node',str(bin),'evidence','verify','--scope','chain','--as-role','architect','--format','json'],cwd=root,env=env,capture_output=True,timeout=30)
assert p.returncode!=0 and b'AUTHORITY_DECLARATION_NOT_APPLICABLE' in p.stdout+p.stderr
results.append({'case':'other-read-role-still-refused','exit':p.returncode})
if os.environ.get('DEVAI_PLAN_TEST_POSITIVE')=='1':
 p=subprocess.run(['node',str(bin),*common,'--as-role','architect'],cwd=root,env=env,capture_output=True,timeout=120)
 (base/'architect.stdout').write_bytes(p.stdout);(base/'architect.stderr').write_bytes(p.stderr)
 assert p.returncode==0,(p.stdout[-3000:],p.stderr[-3000:])
 output=json.loads(p.stdout);assert output['ok'] is True
 plan=output['result']['value'];assert plan['grants_authority'] is False
 assert len(plan['source_manifest']['index']['entries'])==15804
 assert [x['proof_sequence'] for x in plan['source_manifest']['recovery_obligations']]==[7,8]
 results.append({'case':'architect-read-plan','exit':p.returncode,'plan_sha256':sha(json.dumps(plan,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()+b'\n')})
after=snapshot();assert after==before,(before,after)
report={'kind':'installed-plan-role-matrix','package':str(package),'fixture':str(root),'results':results,'before':before,'after':after,'live_detran_effects':False}
(base/'results.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'report':str(base/'results.json'),'cases':len(results)},indent=2))
