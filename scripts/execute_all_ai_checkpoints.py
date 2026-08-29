#!/usr/bin/env python3
"""Legacy compatibility entry point for the canonical AI ledger runner.

The routing implementation lives in ``scripts/run_ai_ledger.mjs`` so provider
identity, empty-response validation, and token-budget adaptation cannot drift
between two independent live-call harnesses.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main() -> int:
    project_root = Path(__file__).resolve().parents[1]
    runner = project_root / "scripts" / "run_ai_ledger.mjs"
    completed = subprocess.run(
        ["node", str(runner)],
        cwd=project_root,
        check=False,
    )
    return completed.returncode


if __name__ == "__main__":
    sys.exit(main())
