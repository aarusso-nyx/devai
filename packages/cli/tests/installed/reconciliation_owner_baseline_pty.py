"""Public positive-grammar registration RED, never negative-guard qualification.

Uses explicit DEVAI_INSTALLED_PACKAGE and DEVAI_P1_INSTALLED_EVIDENCE. The
source/plan schema is not frozen yet, so approval plan content is a benign JSON
sentinel with an exact digest; its semantic validity is deliberately not claimed.
"""

import hashlib
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import tempfile
import termios
import time
import unittest

import authority_policy_review_pty as shared


class OwnerPublicBaseline(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="devai-owner-baseline-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        for name in [".devai/pin/constitution.md", ".devai/config/project.json", ".devai/constitution.md"]:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(subprocess.check_output(
                ["git", "show", f"{shared.BASELINE}:{name}"], cwd=shared.SOURCE))
        self.plan = self.root / "owner-plan.json"
        self.plan.write_text('{"standing":"positive-grammar sentinel; not an approval or frozen plan schema"}\n')
        self.plan_sha256 = hashlib.sha256(self.plan.read_bytes()).hexdigest()
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        subprocess.run(["git", "add", "."], cwd=self.root, check=True)
        subprocess.run(["git", "-c", "user.name=Inspector fixture", "-c", "user.email=fixture@example.invalid",
                        "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"], cwd=self.root, check=True)

    def capture(self, argv):
        before = shared.inventory(self.root)
        master, slave = pty.openpty()
        attributes = termios.tcgetattr(slave)
        attributes[3] &= ~termios.ECHO
        termios.tcsetattr(slave, termios.TCSANOW, attributes)
        process = subprocess.Popen([shared.NODE, str(shared.BIN), *argv], cwd=self.root,
                                   stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
                                   env={**os.environ, "NO_COLOR": "1", "GIT_OPTIONAL_LOCKS": "0"})
        os.close(slave)
        raw = b""
        deadline = time.monotonic() + 20
        try:
            while time.monotonic() < deadline:
                readable, _, _ = select.select([master], [], [], .05)
                if readable:
                    try:
                        chunk = os.read(master, 1024 * 1024)
                    except OSError as error:
                        if error.errno != 5:
                            raise
                        break
                    if not chunk:
                        break
                    raw += chunk
                elif process.poll() is not None:
                    break
            self.assertIsNotNone(process.poll(), "positive-grammar baseline did not settle")
        finally:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=10)
            os.close(master)
        after = shared.inventory(self.root)
        shared.EVIDENCE.mkdir(parents=True, exist_ok=True)
        (shared.EVIDENCE / f"{self._testMethodName}.json").write_text(json.dumps({
            "standing": "INSTALLED_POSITIVE_GRAMMAR_BASELINE_ONLY",
            "package": str(shared.PACKAGE), "argv": argv, "pid": process.pid,
            "all_three_real_ttys": True, "input_delivered": False,
            "exit": process.returncode, "stdout_stderr_pty": raw.decode(),
            "plan_sha256": self.plan_sha256, "plan_semantic_validity_claimed": False,
            "before": before, "after": after, "negative_guards_qualified": False,
        }, indent=2) + "\n")
        self.assertEqual(after, before)
        return process.returncode, raw.decode()

    def test_architect_reconciliation_host_read_only_positive_grammar(self):
        code, output = self.capture(["init", "bind", "--reconciliation-host", "--target", str(self.root),
                                     "--as-role", "architect", "--format", "json"])
        self.assertEqual(code, 0, output)

    def test_owner_approve_help_is_registered(self):
        code, output = self.capture(["evidence", "reconcile", "approve", "--help"])
        self.assertEqual(code, 0, output)

    def test_direct_owner_approval_positive_grammar_reaches_registered_route(self):
        _, output = self.capture(["evidence", "reconcile", "approve", "--repo-root", str(self.root),
                                  "--plan", "owner-plan.json", "--plan-sha256", self.plan_sha256,
                                  "--as-role", "owner", "--write", "--format", "json"])
        # This checks route presence only. Later schema/host/approval refusals do
        # not qualify any guard here; they need the frozen contract fixtures.
        self.assertNotIn("Unknown or incomplete command", output)


if __name__ == "__main__":
    unittest.main(verbosity=2)
