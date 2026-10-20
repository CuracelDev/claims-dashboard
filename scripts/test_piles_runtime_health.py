import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

from scripts.piles_runtime_health import (
    MANIFEST_NAME,
    compute_runtime_fingerprint,
    inspect_runtime,
)


class RuntimeFixture:
    def __init__(self, root: Path):
        self.root = root
        self.generation = root / "generations" / "fixture"
        self.bin_dir = self.generation / "bin"
        self.python = self.bin_dir / "python"
        self.requirements = root / "requirements.txt"
        self.browser = root / "browsers" / "chromium" / "chrome"
        self.requirements.write_text("requests==2.32.5\n", encoding="utf-8")

    def make_python(self, *, pip=True, imports=True, browser_launch=True, secret=""):
        self.bin_dir.mkdir(parents=True, exist_ok=True)
        script = f"""#!{os.sys.executable}
import json, os, sys
command = " ".join(sys.argv[1:])
if "RUNTIME_IDENTITY" in command:
    print(json.dumps({{"prefix": {str(self.generation)!r}, "base_prefix": "/usr", "version": "3.11"}}))
    raise SystemExit(0)
if "-m pip --version" in command:
    print({(secret or 'pip missing')!r}, file=sys.stderr)
    raise SystemExit({0 if pip else 1})
if "RUNTIME_IMPORTS" in command:
    if "runtime-poison" in os.environ.get("PYTHONPATH", ""):
        raise SystemExit(9)
    print({(secret or 'import failed')!r}, file=sys.stderr)
    raise SystemExit({0 if imports else 1})
if "RUNTIME_BROWSER_LAUNCH" in command:
    print({(secret or 'browser failed')!r}, file=sys.stderr)
    raise SystemExit({0 if browser_launch else 1})
raise SystemExit(2)
"""
        self.python.write_text(script, encoding="utf-8")
        self.python.chmod(self.python.stat().st_mode | stat.S_IXUSR)

    def make_site_packages(self):
        (self.generation / "lib" / "python3.11" / "site-packages").mkdir(parents=True)

    def make_browser(self):
        self.browser.parent.mkdir(parents=True, exist_ok=True)
        self.browser.write_text("browser", encoding="utf-8")
        self.browser.chmod(self.browser.stat().st_mode | stat.S_IXUSR)

    def write_manifest(self, **overrides):
        fingerprint = compute_runtime_fingerprint(
            self.requirements,
            "3.11",
            "1",
            "chromium",
        )
        payload = {
            "schema_version": 1,
            "fingerprint": fingerprint,
            "python_version": "3.11",
            "requirements_sha256": compute_runtime_fingerprint.requirements_sha256(self.requirements),
            "builder_version": "1",
            "browser_config": "chromium",
            "created_at": "2026-10-20T12:00:00Z",
        }
        payload.update(overrides)
        (self.generation / MANIFEST_NAME).write_text(json.dumps(payload), encoding="utf-8")

    def healthy(self):
        self.make_python()
        self.make_site_packages()
        self.make_browser()
        self.write_manifest()

    def inspect(self, mode="light"):
        return inspect_runtime(
            runtime_root=self.root,
            requirements_path=self.requirements,
            python_bin=self.python,
            browser_path=self.browser,
            mode=mode,
            builder_version="1",
            browser_config="chromium",
        )


class PilesRuntimeHealthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.fixture = RuntimeFixture(Path(self.temp.name))

    def test_fingerprint_is_deterministic_and_binds_every_runtime_input(self):
        original = compute_runtime_fingerprint(self.fixture.requirements, "3.11", "1", "chromium")
        self.assertEqual(original, compute_runtime_fingerprint(self.fixture.requirements, "3.11", "1", "chromium"))
        self.assertNotEqual(original, compute_runtime_fingerprint(self.fixture.requirements, "3.12", "1", "chromium"))
        self.assertNotEqual(original, compute_runtime_fingerprint(self.fixture.requirements, "3.11", "2", "chromium"))
        self.assertNotEqual(original, compute_runtime_fingerprint(self.fixture.requirements, "3.11", "1", "firefox"))
        self.fixture.requirements.write_text("requests==2.32.6\n", encoding="utf-8")
        self.assertNotEqual(original, compute_runtime_fingerprint(self.fixture.requirements, "3.11", "1", "chromium"))

    def test_exact_production_corruption_reports_missing_pip_and_site_packages(self):
        self.fixture.make_python(pip=False)
        result = self.fixture.inspect()
        self.assertFalse(result["healthy"])
        self.assertIn("missing_pip", result["states"])
        self.assertIn("missing_site_packages", result["states"])

    def test_missing_python_and_non_virtualenv_are_distinct(self):
        missing = self.fixture.inspect()
        self.assertEqual(missing["states"], ["missing_python"])
        self.fixture.make_python()
        self.fixture.python.write_text("#!/bin/sh\nprintf '%s\\n' '{\"prefix\":\"/usr\",\"base_prefix\":\"/usr\",\"version\":\"3.11\"}'\n", encoding="utf-8")
        result = self.fixture.inspect()
        self.assertIn("not_virtualenv", result["states"])

    def test_manifest_missing_invalid_and_mismatch_are_distinct(self):
        self.fixture.make_python()
        self.fixture.make_site_packages()
        self.fixture.make_browser()
        self.assertIn("manifest_missing", self.fixture.inspect()["states"])
        (self.fixture.generation / MANIFEST_NAME).write_text("not-json", encoding="utf-8")
        self.assertIn("manifest_invalid", self.fixture.inspect()["states"])
        self.fixture.write_manifest(fingerprint="wrong")
        self.assertIn("manifest_mismatch", self.fixture.inspect()["states"])

    def test_missing_imports_are_reported_without_subprocess_diagnostics(self):
        secret = "postgres://user:password@example.invalid/private"
        self.fixture.make_python(imports=False, secret=secret)
        self.fixture.make_site_packages()
        self.fixture.make_browser()
        self.fixture.write_manifest()
        result = self.fixture.inspect()
        self.assertIn("missing_imports", result["states"])
        self.assertNotIn(secret, json.dumps(result))

    def test_light_mode_accepts_a_complete_generation_without_launching_browser(self):
        self.fixture.make_python(browser_launch=False)
        self.fixture.make_site_packages()
        self.fixture.make_browser()
        self.fixture.write_manifest()
        result = self.fixture.inspect(mode="light")
        self.assertTrue(result["healthy"], result)
        self.assertEqual(result["states"], ["healthy"])

    def test_import_probe_does_not_inherit_ambient_pythonpath(self):
        self.fixture.healthy()
        previous = os.environ.get("PYTHONPATH")
        os.environ["PYTHONPATH"] = "/tmp/runtime-poison"
        self.addCleanup(
            lambda: os.environ.pop("PYTHONPATH", None)
            if previous is None
            else os.environ.__setitem__("PYTHONPATH", previous)
        )
        result = self.fixture.inspect()
        self.assertTrue(result["healthy"], result)

    def test_full_mode_distinguishes_missing_browser_and_launch_failure(self):
        self.fixture.make_python()
        self.fixture.make_site_packages()
        self.fixture.write_manifest()
        self.assertIn("browser_missing", self.fixture.inspect(mode="full")["states"])
        self.fixture.make_browser()
        self.fixture.make_python(browser_launch=False)
        self.assertIn("browser_launch_failed", self.fixture.inspect(mode="full")["states"])

    def test_healthy_full_runtime_reports_only_safe_metadata(self):
        self.fixture.healthy()
        os.environ["DATABASE_URL"] = "postgres://secret"
        self.addCleanup(os.environ.pop, "DATABASE_URL", None)
        result = self.fixture.inspect(mode="full")
        self.assertTrue(result["healthy"], result)
        serialized = json.dumps(result)
        self.assertNotIn("postgres://secret", serialized)
        self.assertIn("fingerprint", result)
        self.assertEqual(result["python_version"], "3.11")


if __name__ == "__main__":
    unittest.main()
