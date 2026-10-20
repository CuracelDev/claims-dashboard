import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


REPOSITORY = Path(__file__).resolve().parents[1]
BUILDER = REPOSITORY / "scripts" / "prepare-piles-production-runtime.sh"


FAKE_PYTHON = r'''#!__SYSTEM_PYTHON__
import json, os, shutil, stat, sys, time
from pathlib import Path

args = sys.argv[1:]
command = " ".join(args)
prefix = Path(sys.argv[0]).resolve().parent.parent
log = Path(os.environ["FAKE_COMMAND_LOG"])

def record(value):
    with log.open("a", encoding="utf-8") as handle:
        handle.write(value + "\n")

if "RUNTIME_BASE_VERSION" in command:
    print("3.11")
    raise SystemExit(0)
if args[:2] == ["-m", "venv"]:
    target = Path(args[2])
    target.joinpath("bin").mkdir(parents=True)
    target.joinpath("lib/python3.11/site-packages").mkdir(parents=True)
    shutil.copyfile(__file__, target / "bin/python")
    (target / "bin/python").chmod((target / "bin/python").stat().st_mode | stat.S_IXUSR)
    record("venv")
    raise SystemExit(0)
if "RUNTIME_IDENTITY" in command:
    print(json.dumps({"prefix": str(prefix), "base_prefix": "/usr", "version": "3.11"}))
    raise SystemExit(0)
if args[:3] == ["-m", "pip", "--version"]:
    raise SystemExit(0)
if args[:2] == ["-m", "ensurepip"]:
    record("ensurepip")
    raise SystemExit(0)
if args[:3] == ["-m", "pip", "install"]:
    record("pip-install")
    if "-r" in args and os.environ.get("FAKE_FAIL_INSTALL") == "1":
        print(os.environ.get("DATABASE_URL", "install failed"), file=sys.stderr)
        raise SystemExit(17)
    if "-r" in args and os.environ.get("FAKE_INSTALL_SLEEP"):
        time.sleep(float(os.environ["FAKE_INSTALL_SLEEP"]))
    raise SystemExit(0)
if args[:3] == ["-m", "playwright", "install"]:
    record("browser-install-with-deps" if "--with-deps" in args else "browser-install")
    browser = Path(os.environ["FAKE_BROWSER_PATH"])
    browser.parent.mkdir(parents=True, exist_ok=True)
    browser.write_text("browser", encoding="utf-8")
    browser.chmod(browser.stat().st_mode | stat.S_IXUSR)
    if os.environ.get("FAKE_BROWSER_SLEEP"):
        time.sleep(float(os.environ["FAKE_BROWSER_SLEEP"]))
    raise SystemExit(0)
if "RUNTIME_IMPORTS" in command:
    raise SystemExit(0)
if "RUNTIME_BROWSER_EXECUTABLE" in command:
    print(os.environ["FAKE_BROWSER_PATH"])
    raise SystemExit(0)
if "RUNTIME_BROWSER_LAUNCH" in command:
    raise SystemExit(23 if os.environ.get("FAKE_BROWSER_LAUNCH_FAIL") == "1" else 0)
raise SystemExit(2)
'''


class BuilderFixture:
    def __init__(self, root: Path):
        self.root = root
        self.runtime = root / "runtime"
        self.requirements = root / "requirements.txt"
        self.requirements.write_text("requests==2.32.5\n", encoding="utf-8")
        self.base_python = root / "fake-python"
        self.command_log = root / "commands.log"
        self.command_log.write_text("", encoding="utf-8")
        self.browser = root / "browsers/chromium/chrome"
        self.base_python.write_text(
            FAKE_PYTHON.replace("__SYSTEM_PYTHON__", sys.executable), encoding="utf-8"
        )
        self.base_python.chmod(self.base_python.stat().st_mode | 0o100)

    def env(self, **values):
        env = os.environ.copy()
        env.update({
            "PILES_RUNTIME_ROOT": str(self.runtime),
            "PILES_RUNTIME_REQUIREMENTS_FILE": str(self.requirements),
            "PILES_RUNTIME_BASE_PYTHON": str(self.base_python),
            "PILES_RUNTIME_CONTROL_PYTHON": sys.executable,
            "PILES_RUNTIME_MAX_ATTEMPTS": "1",
            "PILES_RUNTIME_RETRY_DELAY_SECONDS": "0",
            "PILES_RUNTIME_REPAIR_WAIT_SECONDS": "5",
            "PLAYWRIGHT_BROWSERS_PATH": str(self.browser.parent.parent),
            "FAKE_BROWSER_PATH": str(self.browser),
            "FAKE_COMMAND_LOG": str(self.command_log),
            "DATABASE_URL": "postgres://user:secret@example.invalid/private",
        })
        env.update(values)
        return env

    def run(self, **values):
        return subprocess.run(
            ["/bin/sh", str(BUILDER)],
            cwd=REPOSITORY,
            env=self.env(**values),
            text=True,
            capture_output=True,
            timeout=20,
        )

    def current_target(self):
        return (self.runtime / "current").resolve()

    def commands(self):
        return self.command_log.read_text(encoding="utf-8").splitlines()


class PilesRuntimeBuilderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.fixture = BuilderFixture(Path(self.temp.name))

    def test_recovers_when_only_a_damaged_legacy_python_survives(self):
        legacy = self.fixture.root / "legacy/bin"
        legacy.mkdir(parents=True)
        (legacy / "python").write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        (legacy / "python").chmod(0o700)
        result = self.fixture.run(PILES_RUNTIME_VENV_DIR=str(legacy.parent))
        self.assertEqual(result.returncode, 0, result.stderr)
        current = self.fixture.current_target()
        self.assertTrue(current.is_dir())
        self.assertTrue((current / "piles-runtime-manifest.json").is_file())
        self.assertIn("ensurepip", self.fixture.commands())
        self.assertNotIn("secret", result.stdout + result.stderr)

    def test_healthy_matching_generation_is_a_noop(self):
        first = self.fixture.run()
        second = self.fixture.run()
        self.assertEqual((first.returncode, second.returncode), (0, 0), first.stderr + second.stderr)
        self.assertEqual(self.fixture.commands().count("venv"), 1)
        self.assertEqual(first.stdout.count("Runtime generation promoted"), 1)
        self.assertIn("already healthy", second.stdout)

    def test_install_failure_preserves_current_and_redacts_subprocess_error(self):
        self.assertEqual(self.fixture.run().returncode, 0)
        before = self.fixture.current_target()
        self.fixture.requirements.write_text("requests==2.32.6\n", encoding="utf-8")
        result = self.fixture.run(FAKE_FAIL_INSTALL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.fixture.current_target(), before)
        self.assertNotIn("postgres://", result.stdout + result.stderr)

    def test_browser_launch_failure_never_promotes_candidate(self):
        result = self.fixture.run(FAKE_BROWSER_LAUNCH_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.fixture.runtime / "current").exists())
        self.assertIn("browser_launch_failed", result.stderr)

    def test_only_explicit_deployment_mode_may_install_os_dependencies(self):
        result = self.fixture.run(PILES_RUNTIME_INSTALL_OS_DEPS="true")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("browser-install-with-deps", self.fixture.commands())

    def test_requirements_change_promotes_new_generation_and_preserves_previous(self):
        self.assertEqual(self.fixture.run().returncode, 0)
        first = self.fixture.current_target()
        self.fixture.requirements.write_text("requests==2.32.6\n", encoding="utf-8")
        self.assertEqual(self.fixture.run().returncode, 0)
        second = self.fixture.current_target()
        self.assertNotEqual(first, second)
        self.assertEqual((self.fixture.runtime / "previous").resolve(), first)
        manifest = json.loads((second / "piles-runtime-manifest.json").read_text(encoding="utf-8"))
        self.assertNotEqual(manifest["fingerprint"], json.loads((first / "piles-runtime-manifest.json").read_text(encoding="utf-8"))["fingerprint"])

    def test_concurrent_builders_share_one_promoted_generation(self):
        env = self.fixture.env(FAKE_INSTALL_SLEEP="0.5")
        processes = [
            subprocess.Popen(["/bin/sh", str(BUILDER)], cwd=REPOSITORY, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            for _ in range(2)
        ]
        outputs = [process.communicate(timeout=15) for process in processes]
        self.assertEqual([process.returncode for process in processes], [0, 0], outputs)
        self.assertEqual(self.fixture.commands().count("venv"), 1)

    def test_termination_during_candidate_build_leaves_active_pointer_unchanged(self):
        self.assertEqual(self.fixture.run().returncode, 0)
        before = self.fixture.current_target()
        self.fixture.requirements.write_text("requests==2.32.6\n", encoding="utf-8")
        process = subprocess.Popen(
            ["/bin/sh", str(BUILDER)], cwd=REPOSITORY,
            env=self.fixture.env(FAKE_BROWSER_SLEEP="10"),
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        deadline = time.time() + 5
        while time.time() < deadline and "browser-install" not in self.fixture.commands():
            time.sleep(0.05)
        process.send_signal(signal.SIGTERM)
        process.communicate(timeout=5)
        self.assertEqual(self.fixture.current_target(), before)
        leftovers = list(self.fixture.runtime.glob(".build-*"))
        self.assertEqual(leftovers, [])


if __name__ == "__main__":
    unittest.main()
