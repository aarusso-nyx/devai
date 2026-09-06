#!/usr/bin/env python3
"""Private evidence transport. Trust roots never come from the archive."""
import argparse
import base64
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile

REPOSITORY = 'aarusso-nyx/devai-evidence'
MEMBERS = ('artifacts.tgz', 'envelope.json', 'environment.json', 'results.tgz',
           'task-policy.json', 'toolchain.json')
LIMIT = 1024 * 1024 * 1024


def require(condition, code):
    if not condition:
        raise ValueError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def archive(files):
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode='wb', mtime=0, filename='') as zipped:
        with tarfile.open(fileobj=zipped, mode='w', format=tarfile.USTAR_FORMAT) as tar:
            for name, data in sorted(files.items()):
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o600
                tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def read_archive(data):
    require(len(data) <= LIMIT, 'ARCHIVE_TOO_LARGE')
    files = {}
    seen = set()
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
        for member in tar:
            name = member.name
            parts = PurePosixPath(name).parts
            require(not name.startswith('/') and '\\' not in name and
                    '..' not in parts and not re.match(r'^[A-Za-z]:', name), 'ARCHIVE_PATH_INVALID')
            normalized = str(PurePosixPath(name))
            require(normalized not in seen, 'ARCHIVE_DUPLICATE')
            seen.add(normalized)
            require(member.isfile() or member.isdir(), 'ARCHIVE_TYPE_INVALID')
            require(not member.pax_headers, 'ARCHIVE_EXTENSIONS_INVALID')
            if member.isdir():
                continue
            require(normalized != '.', 'ARCHIVE_PATH_INVALID')
            total += member.size
            require(total <= LIMIT and len(files) < 100000, 'ARCHIVE_TOO_LARGE')
            files[normalized] = tar.extractfile(member).read()
    for name in files:
        require(not any(str(parent) in files for parent in PurePosixPath(name).parents), 'ARCHIVE_PARENT_COLLISION')
    return files


def directory_files(root):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink(), 'INPUT_DIRECTORY_INVALID')
    files = {}
    for path in sorted(root.rglob('*')):
        require(not path.is_symlink(), 'INPUT_SYMLINK_INVALID')
        if path.is_dir():
            continue
        require(path.is_file(), 'INPUT_TYPE_INVALID')
        files[path.relative_to(root).as_posix()] = path.read_bytes()
    return files


def verify_bundle(data, expected):
    require(bool(re.fullmatch('[a-f0-9]{64}', expected or '')), 'BUNDLE_DIGEST_REQUIRED')
    require(digest(data) == expected, 'BUNDLE_DIGEST_MISMATCH')
    files = read_archive(data)
    require(set(files) == set(MEMBERS) | {'manifest.json'}, 'BUNDLE_POPULATION_INVALID')
    manifest = json.loads(files.pop('manifest.json'))
    require(set(manifest) == {'schemaVersion', 'members'} and
            manifest['schemaVersion'] == '1.0.0', 'BUNDLE_MANIFEST_INVALID')
    expected_manifest = {name: {'sha256': digest(data), 'size': len(data)}
                         for name, data in files.items()}
    require(manifest['members'] == expected_manifest, 'BUNDLE_MEMBER_MISMATCH')
    # Validate nested archives before creating even one destination file.
    for name in ('results.tgz', 'artifacts.tgz'):
        read_archive(files[name])
    for name in ('envelope.json', 'task-policy.json', 'toolchain.json', 'environment.json'):
        require(isinstance(json.loads(files[name]), dict), 'BUNDLE_JSON_INVALID')
    return files


def write_files(destination, files):
    destination = Path(destination)
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    for name, data in files.items():
        path = destination / name
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with path.open('xb') as stream:
            os.chmod(path, 0o600)
            stream.write(data)


def gh(args, token):
    require(bool(token), 'EVIDENCE_CREDENTIAL_REQUIRED')
    result = subprocess.run(['gh', *args], capture_output=True,
                            env={**os.environ, 'GH_TOKEN': token})
    require(result.returncode == 0, 'EVIDENCE_REMOTE_OPERATION_FAILED')
    return result.stdout


def materialize(destination):
    mode = os.environ.get('LEDGER_TRANSPORT')
    require(mode in ('legacy', 'bundle'), 'LEDGER_TRANSPORT_REQUIRED')
    if mode == 'bundle':
        expected = os.environ.get('BUNDLE_SHA256', '')
        require(bool(re.fullmatch('[a-f0-9]{64}', expected)), 'BUNDLE_DIGEST_REQUIRED')
        data = gh(['release', 'download', 'evidence-' + expected, '--repo', REPOSITORY,
                   '--pattern', 'evidence.tgz', '--output', '-'], os.environ.get('EVIDENCE_READ_TOKEN'))
        files = verify_bundle(data, expected)
    else:
        names = ('ARTIFACTS_TGZ_B64', 'ENVELOPE_B64', 'ENVIRONMENT_B64', 'RESULTS_TGZ_B64',
                 'TASK_POLICY_B64', 'TOOLCHAIN_B64')
        files = {}
        for name, variable in zip(MEMBERS, names):
            require(bool(os.environ.get(variable)), 'LEGACY_INPUT_MISSING')
            files[name] = base64.b64decode(os.environ[variable], validate=True)
        for name in ('results.tgz', 'artifacts.tgz'):
            read_archive(files[name])
    require(bool(os.environ.get('TRUST_STORE_B64')), 'TRUST_STORE_REQUIRED')
    files['trust-store.json'] = base64.b64decode(os.environ['TRUST_STORE_B64'], validate=True)
    require(isinstance(json.loads(files['trust-store.json']), dict), 'TRUST_STORE_INVALID')
    if os.environ.get('RELEASE_SIGNERS_B64'):
        files['release-allowed-signers'] = base64.b64decode(os.environ['RELEASE_SIGNERS_B64'], validate=True)
    nested = {name: read_archive(files[name + '.tgz']) for name in ('results', 'artifacts')}
    write_files(destination, files)
    for name, contents in nested.items():
        write_files(Path(destination) / name, contents)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='action', required=True)
    pack = sub.add_parser('pack')
    for key in ('export', 'toolchain', 'environment', 'output'):
        pack.add_argument('--' + key, required=True)
    verify = sub.add_parser('verify')
    verify.add_argument('--archive', required=True)
    verify.add_argument('--sha256', required=True)
    load = sub.add_parser('materialize')
    load.add_argument('--output', required=True)
    upload = sub.add_parser('upload')
    upload.add_argument('--archive', required=True)
    upload.add_argument('--sha256', required=True)
    args = parser.parse_args()
    if args.action == 'pack':
        source = Path(getattr(args, 'export'))
        files = {name: (source / name).read_bytes() for name in ('envelope.json', 'task-policy.json')}
        for name in ('results', 'artifacts'):
            files[name + '.tgz'] = archive(directory_files(source / name))
        for name in ('toolchain', 'environment'):
            files[name + '.json'] = Path(getattr(args, name)).read_bytes()
        manifest = {'schemaVersion': '1.0.0', 'members': {
            name: {'sha256': digest(data), 'size': len(data)} for name, data in files.items()}}
        files['manifest.json'] = canonical(manifest)
        data = archive(files)
        verify_bundle(data, digest(data))
        with Path(args.output).open('xb') as stream:
            os.chmod(args.output, 0o600)
            stream.write(data)
        print(json.dumps({'sha256': digest(data), 'repository': REPOSITORY}))
    elif args.action == 'verify':
        verify_bundle(Path(args.archive).read_bytes(), args.sha256)
        print('{"ok":true}')
    elif args.action == 'materialize':
        materialize(args.output)
        print('{"ok":true}')
    else:
        require(Path(args.archive).name == 'evidence.tgz', 'EVIDENCE_FILENAME_REQUIRED')
        data = Path(args.archive).read_bytes()
        verify_bundle(data, args.sha256)
        token = os.environ.get('GH_TOKEN')
        repo = json.loads(gh(['api', 'repos/' + REPOSITORY], token))
        require(repo.get('private') is True, 'EVIDENCE_REPOSITORY_NOT_PRIVATE')
        releases = json.loads(gh(['api', '--paginate', '--slurp', 'repos/' + REPOSITORY + '/releases'], token))
        tag = 'evidence-' + args.sha256
        existing = next((r for page in releases for r in page if r['tag_name'] == tag), None)
        if existing:
            require(not existing['draft'] and existing.get('immutable') is True, 'EVIDENCE_RELEASE_NOT_IMMUTABLE')
            require([a['name'] for a in existing['assets']] == ['evidence.tgz'], 'EVIDENCE_ASSET_POPULATION_INVALID')
            remote = gh(['release', 'download', tag, '--repo', REPOSITORY, '--pattern', 'evidence.tgz', '--output', '-'], token)
            require(remote == data, 'EVIDENCE_EXISTING_MISMATCH')
        else:
            settings = json.loads(gh(['api', 'repos/' + REPOSITORY + '/immutable-releases'], token))
            require(settings.get('enabled') is True, 'EVIDENCE_IMMUTABILITY_REQUIRED')
            gh(['release', 'create', tag, '--repo', REPOSITORY, '--draft', '--title', tag,
                '--notes', 'Digest-addressed private candidate evidence.'], token)
            gh(['release', 'upload', tag, args.archive, '--repo', REPOSITORY], token)
            remote = gh(['release', 'download', tag, '--repo', REPOSITORY, '--pattern', 'evidence.tgz', '--output', '-'], token)
            require(remote == data, 'EVIDENCE_UPLOAD_MISMATCH')
            gh(['release', 'edit', tag, '--repo', REPOSITORY, '--draft=false'], token)
            published = json.loads(gh(['api', 'repos/' + REPOSITORY + '/releases/tags/' + tag], token))
            require(published.get('immutable') is True, 'EVIDENCE_RELEASE_NOT_IMMUTABLE')
        print('{"ok":true}')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never emit parser errors or remote output containing protected inputs.
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z_]+', str(error)) else 'EVIDENCE_OPERATION_FAILED'
        print(json.dumps({'ok': False, 'code': code}))
        raise SystemExit(1)
