# DIVYESH V3 Governance Pointer

DIVYESH V3 is repository governance infrastructure, not application runtime code.
Its single canonical entry point is `docs/divyesh-v3/manifest.json`, currently at
protocol version `3.0.0` with normalized protocol hash
`sha256:8998c0c8b7363198bd601111a088dee96b526583b5fdbc47b6e9a0f7212ce003`.

The manifest owns the canonical file list and platform adapter registry. Codex,
Claude, Gemini, and Antigravity load that same manifest through their small bootstrap
adapters. They must not create platform-specific copies of the constitution.

Run `npm run verify:v3` before substantive repository work. The verifier checks the
manifest, normalized hashes, canonical files, adapter schemas, and bootstrap pointers.
`scripts/probe-divyesh-v3-bootstrap.mjs` mutation-tests drift detection and normalized
line endings.

This file is only a Brain index pointer. It does not define or override V3 rules.
