#!/usr/bin/env python3
"""Materialize independently approved installed controls; never candidate evidence."""
import argparse
import base64
import io
import json
import os
from pathlib import Path
import re
import tarfile
import evidence_transport as evidence


def materialize_controls(data, expected, destination):
    evidence.require(re.fullmatch('[a-f0-9]{64}', expected or '') is not None,
                     'INSTALLED_CONTROL_DIGEST_REQUIRED')
    evidence.require(len(data) <= 128 * 1024 * 1024 and evidence.digest(data) == expected,
                     'INSTALLED_CONTROL_DIGEST_MISMATCH')
    files = evidence.read_archive(data)
    evidence.require(files and all(name.split('/')[0] in
                     ('seed', 'dag', 'verification-root', 'host.tgz') for name in files),
                     'INSTALLED_CONTROL_POPULATION_INVALID')
    evidence.require('host.tgz' in files and 'seed/package.json' in files and
                     'seed/host/provision-package.mjs' in files and
                     'seed/index/release-host-bootstrap.js' in files and
                     'dag/approval-candidate.json' in files,
                     'INSTALLED_CONTROL_POPULATION_INVALID')
    evidence.require(sum(map(len, files.values())) <= 256 * 1024 * 1024,
                     'INSTALLED_CONTROL_SIZE_INVALID')
    # The approved archive carries file modes required by the DAG's complete
    # member verification. No archive code executes during materialization.
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        modes = {m.name: m.mode for m in archive.getmembers() if m.isfile()}
    evidence.require(set(modes) == set(files) and
                     all(mode in (0o600, 0o644, 0o755) for mode in modes.values()),
                     'INSTALLED_CONTROL_MODE_INVALID')
    evidence.write_files(destination, files)
    for name, mode in modes.items():
        (Path(destination) / name).chmod(mode)


def prepare_config(template, controls, evidence_root, work, candidate, repository, commit, tree):
    evidence.require(repository == 'aarusso-nyx/devai' and
                     re.fullmatch('[a-f0-9]{40}', commit or '') and
                     re.fullmatch('[a-f0-9]{40}', tree or ''), 'INSTALLED_CANDIDATE_REQUIRED')
    config = json.loads(template)
    expected = config['verification']['expected']
    evidence.require(expected['repository'] == {'id': repository, 'commit': commit, 'tree': tree},
                     'INSTALLED_CANDIDATE_MISMATCH')
    evidence.require(config['verification']['request']['action_id'] == 'release offline-verify',
                     'INSTALLED_OFFLINE_ACTION_REQUIRED')
    controls, evidence_root, work, candidate = map(lambda p: str(Path(p).resolve(strict=True)),
                                                (controls, evidence_root, work, candidate))
    config['seed']['root'] = controls + '/seed'
    config['seed']['candidateRoot'] = candidate
    config['provision']['archive_path'] = controls + '/host.tgz'
    config['provision']['destination_parent'] = work + '/installed'
    config['verification']['dagControl']['root'] = controls + '/dag'
    config['verification']['dagControl']['candidateRoot'] = candidate
    config['verification']['directory'] = evidence_root + '/release-export'
    config['verification']['workDirectory'] = work + '/verification'
    config['verification']['expected']['verificationRoot'] = controls + '/verification-root'
    # Existing provisioner checks the exact supplied tar identity. No PATH lookup
    # or executable selection is delegated to candidate evidence.
    for name in ('installed', 'verification'):
        (Path(work) / name).mkdir(mode=0o700, exist_ok=False)
    return config


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--evidence', required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--tree', required=True)
    args = parser.parse_args()
    expected = os.environ.get('INSTALLED_CONTROL_SHA256', '')
    evidence.require(re.fullmatch('[a-f0-9]{64}', expected) is not None,
                     'INSTALLED_CONTROL_DIGEST_REQUIRED')
    template = base64.b64decode(os.environ.get('INSTALLED_OFFLINE_CONFIG_B64', ''), validate=True)
    evidence.require(0 < len(template) <= 1024 * 1024, 'INSTALLED_CONFIG_REQUIRED')
    data = evidence.gh(['release', 'download', 'control-' + expected,
                        '--repo', evidence.REPOSITORY, '--pattern', 'controls.tgz', '--output', '-'],
                       os.environ.get('EVIDENCE_READ_TOKEN'))
    root = Path(args.output)
    root.mkdir(mode=0o700, exist_ok=False)
    materialize_controls(data, expected, root / 'controls')
    config = prepare_config(template, root / 'controls', args.evidence, root, args.candidate,
                            os.environ.get('GITHUB_REPOSITORY'), args.commit, args.tree)
    with (root / 'config.json').open('xb') as stream:
        os.chmod(root / 'config.json', 0o600)
        stream.write(evidence.canonical(config))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Installed control materialization failed; retain private work for diagnosis.')
