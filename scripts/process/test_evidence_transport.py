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



def mutation_export(change=None):
    data = b'fixture artifact bytes'
    files = {'exported-state.json': b'{}', 'policy-closure.json': b'{}',
             'task-policies.json': b'[]', 'objects/' + e.digest(data): data}
    if change:
        change(files)
    return e.archive(files)


def mutation_bundle(change=None):
    files = e.read_archive(bundle())
    del files['manifest.json']
    files['mutation-export.tgz'] = mutation_export()
    files['mutation-input-plan.json'] = b'{}'
    if change:
        change(files)
    files['manifest.json'] = e.canonical({'schemaVersion': '2.0.0', 'members': {
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

    def test_decompressed_archive_limit_precedes_tar_parsing(self):
        data = e.archive({'small': b'x'})
        with patch.object(e, 'LIMIT', 1024), patch.object(e.tarfile, 'open') as parser:
            with self.assertRaisesRegex(ValueError, 'ARCHIVE_TOO_LARGE'):
                e.read_archive(data)
            parser.assert_not_called()

    def test_directory_entries_count_toward_population_limit(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as tar:
            for name in ['a', 'b', 'c']:
                member = tarfile.TarInfo(name)
                member.type = tarfile.DIRTYPE
                tar.addfile(member)
        with patch.object(e, 'MAX_MEMBERS', 2, create=True):
            with self.assertRaisesRegex(ValueError, 'ARCHIVE_TOO_LARGE'):
                e.read_archive(output.getvalue())

    def test_exact_decompressed_limit_is_accepted(self):
        import gzip
        data = e.archive({'small': b'x'})
        with patch.object(e, 'LIMIT', len(gzip.decompress(data))):
            self.assertEqual(e.read_archive(data), {'small': b'x'})

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


class MutationTransportTests(unittest.TestCase):
    def test_explicit_version_and_deterministic_population(self):
        data = mutation_bundle()
        self.assertEqual(data, mutation_bundle())
        self.assertEqual(set(e.verify_bundle(data, e.digest(data), '2.0.0')),
                         set(e.MEMBERS + e.MUTATION_MEMBERS))
        with self.assertRaises(ValueError):
            e.verify_bundle(data, e.digest(data), '1.0.0')
        old = bundle()
        with self.assertRaises(ValueError):
            e.verify_bundle(old, e.digest(old), '2.0.0')

    def test_digest_precedes_mutation_parser(self):
        with patch.object(e, 'verify_mutation_export') as parser:
            with self.assertRaisesRegex(ValueError, 'BUNDLE_DIGEST_MISMATCH'):
                e.verify_bundle(mutation_bundle(), '0' * 64, '2.0.0')
            parser.assert_not_called()

    def test_missing_mutation_member_and_trust_injection(self):
        changes = [lambda files: files.pop('mutation-export.tgz'),
                   lambda files: files.pop('mutation-input-plan.json'),
                   lambda files: files.update({'trust-store.json': b'{}'})]
        for change in changes:
            data = mutation_bundle(change)
            with self.assertRaisesRegex(ValueError, 'BUNDLE_POPULATION_INVALID'):
                e.verify_bundle(data, e.digest(data), '2.0.0')

    def test_nested_export_population_and_digest(self):
        def replace_object(files):
            name = next(name for name in files if name.startswith('objects/'))
            files[name] = b'changed object'
        for change in [replace_object, lambda files: files.update({'private-key.pem': b'private'}),
                       lambda files: files.pop('exported-state.json'),
                       lambda files: files.update({'objects/invalid': b'bytes'})]:
            data = mutation_bundle(lambda files: files.update({'mutation-export.tgz': mutation_export(change)}))
            with self.assertRaises(ValueError):
                e.verify_bundle(data, e.digest(data), '2.0.0')

    def test_unsafe_nested_export(self):
        data = mutation_bundle(lambda files: files.update({'mutation-export.tgz': malicious('../outside')}))
        with self.assertRaises(ValueError):
            e.verify_bundle(data, e.digest(data), '2.0.0')

    def test_no_legacy_fallback_for_current_evidence(self):
        with patch.dict(os.environ, {'LEDGER_TRANSPORT': 'legacy', 'BUNDLE_SCHEMA_VERSION': '2.0.0'}, clear=True):
            with self.assertRaisesRegex(ValueError, 'MUTATION_BUNDLE_REQUIRED'):
                e.materialize('unused')

    def test_materializes_current_export_only_after_validation(self):
        import base64
        data = mutation_bundle()
        env = {'LEDGER_TRANSPORT': 'bundle', 'BUNDLE_SCHEMA_VERSION': '2.0.0',
               'BUNDLE_SHA256': e.digest(data), 'TRUST_STORE_B64': base64.b64encode(b'{}').decode(),
               'EVIDENCE_READ_TOKEN': 'fixture'}
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, env, clear=True), patch.object(e, 'gh', return_value=data):
            target = Path(root) / 'verified'
            e.materialize(target)
            self.assertEqual((target / 'mutation-export/task-policies.json').read_bytes(), b'[]')
            self.assertEqual((target / 'mutation-export/exported-state.json').stat().st_mode & 0o777, 0o600)
        bad = mutation_bundle(lambda files: files.update({'mutation-export.tgz': malicious('../escape')}))
        env['BUNDLE_SHA256'] = e.digest(bad)
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, env, clear=True), patch.object(e, 'gh', return_value=bad):
            target = Path(root) / 'rejected'
            with self.assertRaises(ValueError):
                e.materialize(target)
            self.assertFalse(target.exists())


if __name__ == '__main__':
    unittest.main()
