import importlib.util,json,os,sys,unittest,hashlib
from pathlib import Path
BASE=Path(__file__).resolve().parents[6]
# Use the repository's existing actual-TTY installed-bin harness unchanged.
module_path=BASE/'packages/cli/tests/installed/authority_policy_review_pty.py'
spec=importlib.util.spec_from_file_location('installed_p1',module_path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class SourceLinks(m.InstalledReview):
 def test_opaque_source_link_success(self):
  self.precursor()
  outside=self.root.parent/(self.root.name+'-outside');outside.write_text('target is never an authority input')
  link=self.root/'source-link';link.symlink_to(outside)
  self.git('add','source-link')
  terminal,report,raw,before=self.review('opaque-source-link')
  observed=report['inputs']['source_files']['source-link'] if 'inputs' in report else None
  terminal.line(f"CREATE {report['plan_sha256']} {report['artifact']['sha256']}")
  self.assertEqual(terminal.finish(),0,terminal.raw)
  self.assertEqual((self.root/'.devai/config/authority-policy.json').read_bytes(),raw)
  self.assertTrue(link.is_symlink());self.assertEqual(link.readlink(),outside)
  self.record('opaque-source-link-success.json',{'envelopes':m.envelopes(terminal.raw),'link_sha256':m.digest(os.fsencode(str(outside))),'target_sha256':m.digest(outside.read_bytes()),'installed_package':str(m.PACKAGE)})
 def test_linkbyte_drift_refuses(self):
  self.precursor();link=self.root/'source-link';link.symlink_to('missing-a');self.git('add','source-link')
  terminal,report,raw,before=self.review('linkbyte-drift')
  link.unlink();link.symlink_to('missing-b')
  terminal.line(f"CREATE {report['plan_sha256']} {report['artifact']['sha256']}")
  self.assertNotEqual(terminal.finish(),0,terminal.raw)
  self.assertFalse((self.root/'.devai/config/authority-policy.json').exists())
  final=m.envelopes(terminal.raw)[1];self.assertFalse(final['ok'])
  self.record('linkbyte-drift-refusal.json',{'envelopes':m.envelopes(terminal.raw),'installed_package':str(m.PACKAGE)})
 def test_strict_authority_pin_symlink_refuses(self):
  self.precursor();pin=self.root/'.devai/pin/constitution.md';outside=self.root.parent/(self.root.name+'-pin');outside.write_bytes(pin.read_bytes());pin.unlink();pin.symlink_to(outside)
  terminal=m.Terminal(['init','bind','--review-authority-policy','--after-constitution','--target',str(self.root),'--as-role','architect','--write','--format','json'],self.root);self.addCleanup(terminal.close)
  terminal.receive(lambda raw:len(m.envelopes(raw))>=1)
  self.assertNotEqual(terminal.process.wait(timeout=10),0)
  env=m.envelopes(terminal.raw);self.assertFalse(env[0]['ok']);self.assertIn(b'AUTHORITY_POLICY_REVIEW_INPUTS_UNSUPPORTED',terminal.raw)
  self.record('strict-pin-link-refusal.json',{'envelopes':env,'installed_package':str(m.PACKAGE)})
 def test_target_symlink_refuses(self):
  self.precursor();outside=self.root.parent/(self.root.name+'-target');outside.write_text('preserve target')
  target=self.root/'.devai/config/authority-policy.json';target.symlink_to(outside)
  terminal=m.Terminal(['init','bind','--review-authority-policy','--after-constitution','--target',str(self.root),'--as-role','architect','--write','--format','json'],self.root);self.addCleanup(terminal.close)
  terminal.receive(lambda raw:len(m.envelopes(raw))>=1)
  self.assertNotEqual(terminal.process.wait(timeout=10),0)
  self.assertTrue(target.is_symlink());self.assertEqual(outside.read_text(),'preserve target')
  self.assertIn(b'AUTHORITY_POLICY_REVIEW_TARGET_NOT_ABSENT',terminal.raw)
  self.record('strict-target-link-refusal.json',{'envelopes':m.envelopes(terminal.raw),'installed_package':str(m.PACKAGE)})
if __name__=='__main__':
 suite=unittest.TestSuite(SourceLinks(name) for name in ['test_opaque_source_link_success','test_linkbyte_drift_refuses','test_strict_authority_pin_symlink_refuses','test_target_symlink_refuses'])
 result=unittest.TextTestRunner(verbosity=2).run(suite);sys.exit(not result.wasSuccessful())
