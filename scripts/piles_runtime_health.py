#!/usr/bin/env python3
"""Sanitized integrity checks for the Piles Auto Assignment Python runtime."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


MANIFEST_NAME = "piles-runtime-manifest.json"
MANIFEST_SCHEMA_VERSION = 1
DEFAULT_BUILDER_VERSION = "1"
DEFAULT_BROWSER_CONFIG = "chromium"
UNHEALTHY_EXIT = 20

IDENTITY_PROGRAM = """# RUNTIME_IDENTITY
import json, sys
print(json.dumps({
    "prefix": sys.prefix,
    "base_prefix": getattr(sys, "base_prefix", sys.prefix),
    "version": f"{sys.version_info.major}.{sys.version_info.minor}",
}))
"""

IMPORT_PROGRAM = """# RUNTIME_IMPORTS
import dotenv
import playwright
import psycopg2
import requests
import piles_auto_assignment
print("ok")
"""

BROWSER_PROGRAM = """# RUNTIME_BROWSER_LAUNCH
from playwright.sync_api import sync_playwright
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    browser.close()
print("ok")
"""


def requirements_sha256(requirements_path: str | Path) -> str:
    return hashlib.sha256(Path(requirements_path).read_bytes()).hexdigest()


def compute_runtime_fingerprint(
    requirements_path: str | Path,
    python_version: str,
    builder_version: str,
    browser_config: str,
) -> str:
    payload = {
        "browser_config": str(browser_config),
        "builder_version": str(builder_version),
        "python_version": str(python_version),
        "requirements_sha256": requirements_sha256(requirements_path),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


# Keep requirements hashing discoverable from the public fingerprint contract.
compute_runtime_fingerprint.requirements_sha256 = requirements_sha256  # type: ignore[attr-defined]


def _run_safe(command: list[str], *, env: dict[str, str] | None = None) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )
    except (OSError, subprocess.SubprocessError):
        return False, ""
    return result.returncode == 0, result.stdout.strip()


def _load_manifest(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    if not path.is_file():
        return None, "manifest_missing"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None, "manifest_invalid"
    if not isinstance(value, dict) or value.get("schema_version") != MANIFEST_SCHEMA_VERSION:
        return None, "manifest_invalid"
    return value, None


def _site_packages_exist(generation: Path) -> bool:
    candidates = list((generation / "lib").glob("python*/site-packages"))
    candidates.append(generation / "Lib" / "site-packages")
    return any(path.is_dir() for path in candidates)


def inspect_runtime(
    *,
    runtime_root: str | Path,
    requirements_path: str | Path,
    python_bin: str | Path | None = None,
    browser_path: str | Path | None = None,
    mode: str = "light",
    builder_version: str = DEFAULT_BUILDER_VERSION,
    browser_config: str = DEFAULT_BROWSER_CONFIG,
) -> dict[str, Any]:
    if mode not in {"light", "full"}:
        raise ValueError("mode must be light or full")

    root = Path(runtime_root).resolve()
    python = Path(python_bin) if python_bin else root / "current" / "bin" / "python"
    result: dict[str, Any] = {
        "healthy": False,
        "states": [],
        "mode": mode,
        "runtime_root": str(root),
        "python_bin": str(python),
    }
    states: list[str] = result["states"]

    if not python.is_file() or not os.access(python, os.X_OK):
        states.append("missing_python")
        return result

    identity_ok, identity_output = _run_safe([str(python), "-c", IDENTITY_PROGRAM])
    identity: dict[str, str] = {}
    if identity_ok:
        try:
            parsed = json.loads(identity_output)
            if isinstance(parsed, dict):
                identity = {str(key): str(value) for key, value in parsed.items()}
        except json.JSONDecodeError:
            identity = {}
    if not identity or identity.get("prefix") == identity.get("base_prefix"):
        states.append("not_virtualenv")

    generation = Path(identity.get("prefix") or python.parent.parent)
    python_version = identity.get("version", "unknown")
    result["generation"] = str(generation)
    result["python_version"] = python_version

    pip_ok, _ = _run_safe([str(python), "-m", "pip", "--version"])
    if not pip_ok:
        states.append("missing_pip")
    if not _site_packages_exist(generation):
        states.append("missing_site_packages")

    import_env = os.environ.copy()
    repository_scripts = str(Path(__file__).resolve().parent)
    existing_pythonpath = import_env.get("PYTHONPATH", "")
    import_env["PYTHONPATH"] = repository_scripts + (os.pathsep + existing_pythonpath if existing_pythonpath else "")
    imports_ok, _ = _run_safe([str(python), "-c", IMPORT_PROGRAM], env=import_env)
    if not imports_ok:
        states.append("missing_imports")

    manifest, manifest_state = _load_manifest(generation / MANIFEST_NAME)
    if manifest_state:
        states.append(manifest_state)
    else:
        try:
            expected_fingerprint = compute_runtime_fingerprint(
                requirements_path,
                python_version,
                builder_version,
                browser_config,
            )
            result["fingerprint"] = expected_fingerprint
            expected_manifest = {
                "schema_version": MANIFEST_SCHEMA_VERSION,
                "fingerprint": expected_fingerprint,
                "python_version": python_version,
                "requirements_sha256": requirements_sha256(requirements_path),
                "builder_version": str(builder_version),
                "browser_config": str(browser_config),
            }
            if any(manifest.get(key) != value for key, value in expected_manifest.items()):
                states.append("manifest_mismatch")
        except OSError:
            states.append("manifest_mismatch")

    browser = Path(browser_path) if browser_path else None
    if browser is not None and (not browser.is_file() or not os.access(browser, os.X_OK)):
        states.append("browser_missing")
    elif mode == "full":
        browser_ok, _ = _run_safe([str(python), "-c", BROWSER_PROGRAM], env=import_env)
        if not browser_ok:
            states.append("browser_launch_failed")

    if not states:
        states.append("healthy")
        result["healthy"] = True
    return result


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", required=True)
    parser.add_argument("--requirements", required=True)
    parser.add_argument("--python-bin")
    parser.add_argument("--browser-path")
    parser.add_argument("--mode", choices=("light", "full"), default="light")
    parser.add_argument("--builder-version", default=DEFAULT_BUILDER_VERSION)
    parser.add_argument("--browser-config", default=DEFAULT_BROWSER_CONFIG)
    parser.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    result = inspect_runtime(
        runtime_root=args.runtime_root,
        requirements_path=args.requirements,
        python_bin=args.python_bin,
        browser_path=args.browser_path,
        mode=args.mode,
        builder_version=args.builder_version,
        browser_config=args.browser_config,
    )
    if args.json:
        print(json.dumps(result, sort_keys=True))
    else:
        print("Piles runtime: " + ",".join(result["states"]))
        if result.get("fingerprint"):
            print("Runtime fingerprint: " + result["fingerprint"])
    return 0 if result["healthy"] else UNHEALTHY_EXIT


if __name__ == "__main__":
    raise SystemExit(main())
