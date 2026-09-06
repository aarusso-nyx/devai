import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import evidence_transport as e


def bundle(change=None):
    files = {name: b'{}' for name in e.MEMBERS}
    files['results.tgz'] = e.archive({'result.json': b'{}'})
    files['artifacts.tgz'] = e.archive({'nested/output.txt': b'clean output'})
    if change:
        change(files)
    files['manifest.json'] = e.canonical({'schemaVersion': '1.0.0', 'members': {
        name: {'sha256': e.digest(data), 'size': len(data)} for name, data in files.items()}})
    return e.archive(files)


def malicious(name, type=tarfile.REGTYPE):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as tar:
        member = tarfile.TarInfo(name)
        member.type = type
        member.linkname = '/private/secret'
        tar.addfile(member)
    return output.getvalue()


class TransportTests(unittest.TestCase):
    def test_deterministic_roundtrip(self):
        a = bundle()
        self.assertEqual(a, bundle())
        self.assertEqual(set(e.verify_bundle(a, e.digest(a))), set(e.MEMBERS))

    def test_outer_digest_before_parser(self):
        with patch.object(e, 'read_archive') as parser:
            with self.assertRaisesRegex(ValueError, 'BUNDLE_DIGEST_MISMATCH'):
                e.verify_bundle(b'not an archive', '0' * 64)
            parser.assert_not_called()

    def test_member_replacement(self):
        data = bundle()
        files = e.read_archive(data)
        files['envelope.json'] = b'{"otherCandidate":true}'
        changed = e.archive(files)
        with self.assertRaisesRegex(ValueError, 'BUNDLE_MEMBER_MISMATCH'):
            e.verify_bundle(changed, e.digest(changed))

    def test_missing_extra_and_trust_injection(self):
        for name, remove in [('envelope.json', True), ('trust-store.json', False), ('extra', False)]:
            with self.subTest(name=name):
                files = e.read_archive(bundle())
                if remove:
                    del files[name]
                else:
                    files[name] = b'{}'
                data = e.archive(files)
                with self.assertRaisesRegex(ValueError, 'BUNDLE_POPULATION_INVALID'):
                    e.verify_bundle(data, e.digest(data))

    def test_paths_and_special_members(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('/escape', tarfile.REGTYPE),
                           ('C:/escape', tarfile.REGTYPE), ('a\\b', tarfile.REGTYPE),
                           ('link', tarfile.SYMTYPE), ('hard', tarfile.LNKTYPE), ('device', tarfile.CHRTYPE)]:
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    e.read_archive(malicious(name, kind))

    def test_nested_archive_validated_before_materialization(self):
        data = bundle(lambda files: files.update({'artifacts.tgz': malicious('../escape')}))
        with self.assertRaises(ValueError):
            e.verify_bundle(data, e.digest(data))

    def test_no_fallback_on_missing_bundle_digest(self):
        with patch.dict(os.environ, {'LEDGER_TRANSPORT': 'bundle'}, clear=True), patch.object(e, 'gh') as remote:
            with self.assertRaisesRegex(ValueError, 'BUNDLE_DIGEST_REQUIRED'):
                e.materialize('unused')
            remote.assert_not_called()

    def test_explicit_transport(self):
        for value in ['', 'auto', 'unknown']:
            with patch.dict(os.environ, {'LEDGER_TRANSPORT': value}, clear=True):
                with self.assertRaisesRegex(ValueError, 'LEDGER_TRANSPORT_REQUIRED'):
                    e.materialize('unused')

    def test_private_bundle_materialization(self):
        import base64
        data = bundle()
        env = {'LEDGER_TRANSPORT': 'bundle', 'BUNDLE_SHA256': e.digest(data),
               'TRUST_STORE_B64': base64.b64encode(b'{"external":true}').decode(), 'EVIDENCE_READ_TOKEN': 'fixture'}
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, env, clear=True), patch.object(e, 'gh', return_value=data):
            target = Path(root) / 'control'
            e.materialize(target)
            self.assertEqual(json.loads((target / 'trust-store.json').read_text()), {'external': True})
            self.assertEqual((target / 'artifacts/nested/output.txt').read_text(), 'clean output')
            self.assertEqual((target / 'envelope.json').stat().st_mode & 0o777, 0o600)

    def test_failed_authentication_does_not_materialize(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'control'
            with patch.dict(os.environ, {'LEDGER_TRANSPORT': 'bundle', 'BUNDLE_SHA256': '1' * 64}, clear=True):
                with self.assertRaisesRegex(ValueError, 'EVIDENCE_CREDENTIAL_REQUIRED'):
                    e.materialize(target)
            self.assertFalse(target.exists())


if __name__ == '__main__':
    unittest.main()
