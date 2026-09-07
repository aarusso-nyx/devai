import json
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
import base64
import os
import sys
import evidence_transport as e
import installed_control_transport as c


def fixture():
    return {name: b'{}' for name in ['host.tgz', 'seed/package.json',
        'seed/host/provision-package.mjs', 'seed/index/release-host-bootstrap.js',
        'dag/approval-candidate.json', 'verification-root/policy.json']}


class Controls(unittest.TestCase):
    def test_approved_bytes(self):
        files = fixture(); data = e.archive(files)
        with tempfile.TemporaryDirectory() as root:
            out = Path(root) / 'control'
            c.materialize_controls(data, e.digest(data), out)
            self.assertEqual({name: (out / name).read_bytes() for name in files}, files)

    def test_wrong_digest_precedes_writes(self):
        with tempfile.TemporaryDirectory() as root:
            out = Path(root) / 'control'
            with self.assertRaisesRegex(ValueError, 'DIGEST_MISMATCH'):
                c.materialize_controls(e.archive(fixture()), '0' * 64, out)
            self.assertFalse(out.exists())

    def test_invalid_population(self):
        for name in ('seed/host/provision-package.mjs', 'host.tgz'):
            files = fixture(); del files[name]; data = e.archive(files)
            with self.assertRaisesRegex(ValueError, 'POPULATION_INVALID'):
                c.materialize_controls(data, e.digest(data), '/unused')
        files = fixture(); files['candidate/run.js'] = b'bad'; data = e.archive(files)
        with self.assertRaisesRegex(ValueError, 'POPULATION_INVALID'):
            c.materialize_controls(data, e.digest(data), '/unused')

    def test_unsafe_archive_precedes_writes(self):
        files = fixture(); files['seed/../escape'] = b'unsafe'; data = e.archive(files)
        with tempfile.TemporaryDirectory() as root:
            out = Path(root) / 'control'
            with self.assertRaisesRegex(ValueError, 'ARCHIVE_PATH_INVALID'):
                c.materialize_controls(data, e.digest(data), out)
            self.assertFalse(out.exists())

    def test_authentication_failure_has_no_fallback(self):
        with tempfile.TemporaryDirectory() as root:
            out = Path(root) / 'control'
            args = ['transport', '--output', str(out), '--evidence', root,
                    '--candidate', root, '--commit', 'a' * 40, '--tree', 'b' * 40]
            env = {'INSTALLED_CONTROL_SHA256': 'c' * 64,
                   'INSTALLED_OFFLINE_CONFIG_B64': base64.b64encode(b'{}').decode(),
                   'EVIDENCE_READ_TOKEN': 'fixture-read-only'}
            with patch.object(sys, 'argv', args), patch.dict(os.environ, env, clear=True), \
                 patch.object(e, 'gh', side_effect=ValueError('EVIDENCE_REMOTE_OPERATION_FAILED')) as gh:
                with self.assertRaisesRegex(ValueError, 'REMOTE_OPERATION_FAILED'):
                    c.main()
                gh.assert_called_once_with(['release', 'download', 'control-' + 'c' * 64,
                    '--repo', 'aarusso-nyx/devai-evidence', '--pattern', 'controls.tgz', '--output', '-'],
                    'fixture-read-only')
            self.assertFalse(out.exists())

    def test_configuration_binds_exact_candidate(self):
        repo = {'id': 'aarusso-nyx/devai', 'commit': 'a' * 40, 'tree': 'b' * 40}
        config = {'seed': {'members': {'approved': 'pin'}}, 'provision': {},
                  'verification': {'dagControl': {'approvalSha256': 'c' * 64},
                    'request': {'action_id': 'release offline-verify'},
                    'expected': {'repository': repo, 'trustStore': {'external': True}}}}
        with tempfile.TemporaryDirectory() as root:
            for name in ('controls', 'evidence', 'work', 'candidate'):
                (Path(root) / name).mkdir()
            paths = [Path(root) / name for name in ('controls', 'evidence', 'work', 'candidate')]
            with self.assertRaisesRegex(ValueError, 'CANDIDATE_MISMATCH'):
                c.prepare_config(json.dumps(config), *paths, repo['id'], 'd' * 40, repo['tree'])
            self.assertFalse((paths[2] / 'installed').exists())
            actual = c.prepare_config(json.dumps(config), *paths, repo['id'], repo['commit'], repo['tree'])
            self.assertEqual(actual['verification']['expected']['trustStore'], {'external': True})
            self.assertEqual(actual['seed']['members'], {'approved': 'pin'})
            self.assertEqual(actual['verification']['directory'], str(paths[1].resolve()) + '/mutation-export')


if __name__ == '__main__':
    unittest.main()
