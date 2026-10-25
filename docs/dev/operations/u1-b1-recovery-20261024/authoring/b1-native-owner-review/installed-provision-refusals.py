import hashlib,json,os,subprocess,tempfile
from pathlib import Path
package=Path(os.environ.get('DEVAI_PROVISION_TEST_PACKAGE','/private/tmp/devai-release-280-01a16e18/installed-provision-08/node_modules/@aarusso-nyx/devai'))
source=Path('/private/var/folders/5c/m4tbc9kj091cw8v71dnxtrt00000gn/T/devai-installed-plan-role-6_gnye0z/repository')
base=Path(tempfile.mkdtemp(prefix='devai-provision-refusals-')).resolve();root=base/'repository';subprocess.run(['/bin/cp','-cR',str(source),str(root)],check=True)
bin=package/'dist/runtime/index/bin.js';env={**os.environ,'NO_COLOR':'1','GIT_OPTIONAL_LOCKS':'0'}
def sha(b):return hashlib.sha256(b).hexdigest()
def snap():
 ns=root/'.git/devai/reconciliation'
 return {'index':sha((root/'.git/index').read_bytes()),'head':(root/'.git/HEAD').read_text(),'merge_head':(root/'.git/MERGE_HEAD').read_text(),'pin':sha((root/'.devai/pin/constitution.md').read_bytes()),'project':sha((root/'.devai/config/project.json').read_bytes()),'policy':sha((root/'.devai/config/authority-policy.json').read_bytes()),'private_namespace_exists':ns.exists(),'private_names':sorted(str(p.relative_to(ns)) for p in ns.rglob('*')) if ns.exists() else []}
common=['init','bind','--reconciliation-host','--target',str(root),'--write','--format','json']
cases=[('missing-role',common),('wrong-owner',common+['--as-role','owner']),('wrong-inspector',common+['--as-role','inspector']),('wrong-case',common+['--as-role','Architect']),('mixed-constitution',common+['--as-role','architect','--constitution']),('mixed-p1',common+['--as-role','architect','--review-authority-policy','--after-constitution']),('duplicate-selector',common+['--as-role','architect','--reconciliation-host']),('session',common+['--as-role','architect','--authority-session','fake']),('missing-write',[x for x in common if x!='--write']+['--as-role','architect']),('foreign-plan',common+['--as-role','architect','--plan','fake.json']),('foreign-dry-run',common+['--as-role','architect','--dry-run']),('non-tty',common+['--as-role','architect']),('ordinary-p1-non-tty',['init','bind','--review-authority-policy','--after-constitution','--target',str(root),'--as-role','architect','--write','--format','json'])]
before=snap();results=[]
for name,argv in cases:
 p=subprocess.run(['node',str(bin),*argv],cwd=root,env=env,capture_output=True,timeout=30)
 (base/(name+'.stdout')).write_bytes(p.stdout);(base/(name+'.stderr')).write_bytes(p.stderr)
 assert p.returncode!=0,(name,p.stdout[-1000:],p.stderr[-1000:])
 raw=p.stdout+p.stderr;lines=[line for line in raw.splitlines() if line.startswith(b'{')];assert len(lines)==1,(name,raw[-1000:]);error=json.loads(lines[0])['error']
 if name=='non-tty':assert error['code']=='RECONCILIATION_PROVISION_REVIEW_INVALID',(name,error)
 elif name=='ordinary-p1-non-tty':assert error['code']=='AUTHORITY_POLICY_REVIEW_TERMINAL_REQUIRED',(name,error)
 else:
  expected={'mixed-p1':'AUTHORITY_POLICY_REVIEW_SELECTION_INVALID','missing-role':'AUTHORITY_DECLARATION_MISSING','wrong-owner':'AUTHORITY_HUMAN_ROLE_DENIED','wrong-inspector':'AUTHORITY_HUMAN_ROLE_DENIED','wrong-case':'AUTHORITY_DECLARATION_INVALID','session':'AUTHORITY_DECLARATION_CONFLICT','missing-write':'AUTHORITY_RECONCILIATION_INVOCATION_INVALID'}.get(name,'AUTHORITY_RECONCILIATION_INVOCATION_INVALID')
  assert error['code']==expected,(name,error)
 assert snap()==before,(name,before,snap())
 results.append({'case':name,'exit':p.returncode,'error_code':error['code'],'error_class':error['class'],'no_namespace_or_source_identity_change':True})
report={'kind':'installed-provision-early-refusal-matrix','package':str(package),'fixture':str(root),'results':results,'before':before,'after':snap(),'live_detran_effects':False,'qualification':'Piped non-TTY subprocesses; no native positive provisioning run.'}
(base/'results.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'report':str(base/'results.json'),'cases':len(results),'sha256':sha((base/'results.json').read_bytes())},indent=2))
