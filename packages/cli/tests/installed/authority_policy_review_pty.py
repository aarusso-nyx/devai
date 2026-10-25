"""Real installed-bin qualification; no imports or resolver/TTY/publisher mocks.

Run through validation-runner with DEVAI_INSTALLED_PACKAGE and
DEVAI_P1_INSTALLED_EVIDENCE set to explicit absolute paths. Package staging and
tarball admission belong to the orchestrator, not this test harness.
"""

import base64
import errno
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import tempfile
import termios
import time
import unittest


SOURCE = Path(__file__).resolve().parents[4]
BASELINE = "2df84159caabf869b866fb2a05e5b06be83295fb"
PACKAGE = Path(os.environ["DEVAI_INSTALLED_PACKAGE"]).resolve(strict=True)
EVIDENCE = Path(os.environ["DEVAI_P1_INSTALLED_EVIDENCE"]).resolve()
NODE = shutil.which("node")
BIN = PACKAGE / "dist/runtime/index/bin.js"
CANONICAL = PACKAGE / "dist/law/constitution.md"


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def inventory(root):
    return {
        str(path.relative_to(root)): digest(path.read_bytes())
        for path in sorted(root.rglob("*"))
        if path.is_file() and not path.is_symlink()
    }


def envelopes(raw):
    return [json.loads(line) for line in raw.decode().replace("\r", "").split("\n")[:-1]
            if line.startswith('{"schemaVersion"')]


class Terminal:
    def __init__(self, argv, root):
        self.master, slave = pty.openpty()
        attributes = termios.tcgetattr(slave)
        attributes[3] &= ~termios.ECHO
        termios.tcsetattr(slave, termios.TCSANOW, attributes)
        self.process = subprocess.Popen(
            [NODE, str(BIN), *argv], cwd=root, stdin=slave, stdout=slave,
            stderr=slave, start_new_session=True,
            env={**os.environ, "NO_COLOR": "1", "GIT_OPTIONAL_LOCKS": "0"},
        )
        os.close(slave)
        self.raw = b""
        self.delivered = False

    def receive(self, predicate):
        deadline = time.monotonic() + 20
        while not predicate(self.raw):
            if time.monotonic() >= deadline:
                raise AssertionError(f"PTY deadline; pid={self.process.pid}: {self.raw[-3000:]!r}")
            readable, _, _ = select.select([self.master], [], [], .05)
            if readable:
                try:
                    data = os.read(self.master, 1024 * 1024)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b""
                if not data:
                    if predicate(self.raw):
                        break
                    raise AssertionError(f"PTY closed before expected output: {self.raw[-3000:]!r}")
                self.raw += data
        return self.raw

    def line(self, value):
        self.delivered = True
        os.write(self.master, value.encode() + b"\n")

    def finish(self):
        self.receive(lambda raw: len(envelopes(raw)) == 2)
        return self.process.wait(timeout=10)

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=10)
        os.close(self.master)


class InstalledReview(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="devai-installed-p1-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        for name in [".devai/pin/constitution.md", ".devai/config/project.json", ".devai/constitution.md"]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(subprocess.check_output(
                ["git", "show", f"{BASELINE}:{name}"], cwd=SOURCE))
        (self.root / "README.md").write_text("# disposable installed-package qualification\n")
        self.git("init", "-q")
        self.git("add", ".")
        self.git("-c", "user.name=Inspector fixture", "-c", "user.email=fixture@example.invalid",
                 "-c", "commit.gpgSign=false", "commit", "-qm", "fixture")

    def git(self, *argv):
        return subprocess.check_output(["git", *argv], cwd=self.root)

    def invoke(self, *argv):
        return subprocess.run([NODE, str(BIN), *argv], cwd=self.root,
                              capture_output=True, timeout=20,
                              env={**os.environ, "NO_COLOR": "1", "GIT_OPTIONAL_LOCKS": "0"})

    def record(self, name, value):
        EVIDENCE.mkdir(parents=True, exist_ok=True)
        (EVIDENCE / name).write_text(json.dumps(value, indent=2) + "\n")

    def review(self, label=None):
        argv = ["init", "bind", "--review-authority-policy", "--after-constitution",
                "--target", str(self.root), "--as-role", "architect", "--write", "--format", "json"]
        before = inventory(self.root)
        terminal = Terminal(argv, self.root)
        self.addCleanup(terminal.close)
        terminal.receive(lambda raw: len(envelopes(raw)) == 1 and b"CREATE " in raw)
        self.assertFalse(terminal.delivered)
        self.assertEqual(inventory(self.root), before)
        ready = envelopes(terminal.raw)[0]
        self.assertTrue(ready["ok"])
        report = ready["result"]["value"]
        raw = base64.b64decode(report["artifact"]["bytes_base64"], validate=True)
        self.assertEqual(digest(raw), report["artifact"]["sha256"])
        self.assertEqual(len(raw), report["artifact"]["size_bytes"])
        plan = {key: value for key, value in report.items() if key != "plan_sha256"}
        canonical = json.dumps(plan, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        self.assertEqual(digest(canonical), report["plan_sha256"])
        self.assertFalse(report["grants_authority"])
        self.record((label or self._testMethodName) + "-ready.json", {
            "package": str(PACKAGE), "pid": terminal.process.pid, "argv": argv,
            "input_delivered": False, "ready_envelope": ready,
            "stdout_stderr_pty": terminal.raw.decode(), "inventory": before,
        })
        return terminal, report, raw, before

    def precursor(self):
        result = self.invoke("init", "bind", "--constitution", "--target", str(self.root),
                             "--as-role", "architect", "--write", "--format", "json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / ".devai/pin/constitution.md").read_bytes(), CANONICAL.read_bytes())
        return result

    def test_public_help(self):
        result = self.invoke("init", "bind", "--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"--review-authority-policy", result.stdout)
        self.assertIn(b"--after-constitution", result.stdout)
        self.record("help.json", {"stdout": result.stdout.decode(), "stderr": result.stderr.decode()})

    def test_installed_version_matches_manifest(self):
        result = self.invoke("--version")
        self.assertEqual(result.returncode, 0, result.stderr)
        version = json.loads((PACKAGE / "package.json").read_text())["version"]
        self.assertEqual(result.stdout.decode().split()[0], f"devai/{version}")

    def test_legacy_dry_branches(self):
        before = inventory(self.root)
        for argv in [["init", "bind"], ["init", "bind", "--full"], ["init", "upgrade"]]:
            with self.subTest(argv=argv):
                result = self.invoke(*argv, "--target", str(self.root), "--format", "json")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(inventory(self.root), before)
                self.assertTrue(envelopes(result.stdout + result.stderr))

    def test_pipe_refuses_before_preparation(self):
        before = inventory(self.root)
        result = self.invoke("init", "bind", "--review-authority-policy", "--after-constitution",
                             "--target", str(self.root), "--as-role", "architect", "--write", "--format", "json")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn(b"AUTHORITY_POLICY_REVIEW_TERMINAL_REQUIRED", result.stdout + result.stderr)
        self.assertEqual(inventory(self.root), before)

    def test_cancel_preserves_all_files(self):
        terminal, _, _, before = self.review()
        terminal.delivered = True
        os.write(terminal.master, b"\x04")
        self.assertEqual(terminal.finish(), 0)
        final = envelopes(terminal.raw)[1]
        self.assertEqual(final["result"]["value"]["status"], "cancelled")
        self.assertFalse(final["result"]["value"]["binding_performed"])
        self.assertEqual(inventory(self.root), before)
        self.record("cancel.json", {"envelopes": envelopes(terminal.raw), "after": inventory(self.root)})

    def test_wrong_confirmation_preserves_all_files(self):
        terminal, _, _, before = self.review()
        terminal.line("CREATE " + "0" * 64 + " " + "0" * 64)
        self.assertEqual(terminal.finish(), 2)
        self.assertIn(b"AUTHORITY_POLICY_REVIEW_CONFIRMATION_MISMATCH", terminal.raw)
        self.assertEqual(inventory(self.root), before)

    def test_existing_target_is_preserved(self):
        target = self.root / ".devai/config/authority-policy.json"
        target.write_text("{\"foreign\":true}\n")
        before = inventory(self.root)
        terminal = Terminal(["init", "bind", "--review-authority-policy", "--after-constitution",
                             "--target", str(self.root), "--as-role", "architect", "--write",
                             "--format", "json"], self.root)
        self.addCleanup(terminal.close)
        terminal.receive(lambda raw: bool(envelopes(raw)))
        self.assertFalse(envelopes(terminal.raw)[0]["ok"])
        self.assertIn(b"AUTHORITY_POLICY_REVIEW_TARGET_NOT_ABSENT", terminal.raw)
        self.assertEqual(terminal.process.wait(timeout=10), 2)
        self.assertEqual(inventory(self.root), before)

    def test_exact_precursor_then_exact_create(self):
        terminal, report, raw, _ = self.review()
        precursor = self.precursor()
        after_precursor = inventory(self.root)
        terminal.line(f"CREATE {report['plan_sha256']} {report['artifact']['sha256']}")
        self.assertEqual(terminal.finish(), 0, terminal.raw)
        target = self.root / ".devai/config/authority-policy.json"
        self.assertEqual(target.read_bytes(), raw)
        after = inventory(self.root)
        self.assertEqual({key: value for key, value in after.items() if key != ".devai/config/authority-policy.json"}, after_precursor)
        completion = envelopes(terminal.raw)[1]
        self.assertEqual(completion["result"]["value"]["digest_sha256"], digest(raw))
        self.record("created.json", {"envelopes": envelopes(terminal.raw), "after": after,
                                    "precursor_stdout": precursor.stdout.decode(),
                                    "artifact_sha256": digest(raw), "size_bytes": len(raw)})

    def test_fresh_review_of_actual_successor(self):
        self.precursor()
        terminal, report, raw, before = self.review()
        terminal.line(f"CREATE {report['plan_sha256']} {report['artifact']['sha256']}")
        self.assertEqual(terminal.finish(), 0, terminal.raw)
        self.assertEqual((self.root / ".devai/config/authority-policy.json").read_bytes(), raw)
        after = inventory(self.root)
        self.assertEqual({key: value for key, value in after.items()
                          if key != ".devai/config/authority-policy.json"}, before)
        self.record("fresh-successor-created.json", {"envelopes": envelopes(terminal.raw), "after": after})

    def test_two_installed_processes_preserve_one_winner(self):
        first = self.review("race-first")
        second = self.review("race-second")
        self.assertNotEqual(first[0].process.pid, second[0].process.pid)
        self.assertEqual(first[3], second[3])
        self.assertFalse((self.root / ".devai/config/authority-policy.json").exists())
        self.precursor()
        after_precursor = inventory(self.root)
        for terminal, report, _, _ in [first, second]:
            terminal.line(f"CREATE {report['plan_sha256']} {report['artifact']['sha256']}")
        exits = [first[0].finish(), second[0].finish()]
        self.assertEqual(exits.count(0), 1, [first[0].raw, second[0].raw])
        winner = [first, second][exits.index(0)]
        loser = [first, second][1 - exits.index(0)]
        target = self.root / ".devai/config/authority-policy.json"
        self.assertEqual(target.read_bytes(), winner[2])
        stat = target.stat()
        winner_completion = envelopes(winner[0].raw)[1]["result"]["value"]
        self.assertEqual(winner_completion["publication_identity"]["ino"], str(stat.st_ino))
        self.assertFalse(envelopes(loser[0].raw)[1]["ok"])
        after = inventory(self.root)
        self.assertEqual({key: value for key, value in after.items()
                          if key != ".devai/config/authority-policy.json"}, after_precursor)
        self.record("two-process-race.json", {
            "pids": [first[0].process.pid, second[0].process.pid], "exits": exits,
            "envelopes": [envelopes(first[0].raw), envelopes(second[0].raw)],
            "artifact_sha256": digest(target.read_bytes()), "size_bytes": target.stat().st_size,
            "identity": {"dev": str(stat.st_dev), "ino": str(stat.st_ino)}, "after": after,
        })


if __name__ == "__main__":
    unittest.main(verbosity=2)
