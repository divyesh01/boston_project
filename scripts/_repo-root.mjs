// The repository root, as a real filesystem path, on every operating system.
//
// WHY THIS FILE EXISTS. Seven probes used to compute the repo root like this:
//
//     const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
//
// On macOS and Linux that works by luck. On Windows it is broken, because a
// file:// URL's `.pathname` keeps a LEADING SLASH before the drive letter:
//
//     new URL('..', 'file:///C:/repo/scripts/x.mjs').pathname
//       -> '/C:/repo/'
//     path.resolve('/C:/repo/')
//       -> 'C:\C:\Users\divye\...\boston_project'      <-- the drive twice
//
// Every readFileSync against that path threw ENOENT, so on 2026-08-21 these
// seven suites did not fail — they never STARTED:
//
//     probe-csrf-default-closed, probe-delete-guard,
//     probe-money-kept-double-count, probe-password-policy,
//     probe-ui-disabled-reason, probe-ui-feedback, probe-ws-server
//
// A suite that cannot start verifies NOTHING, while its absence from the FAILED
// list reads like a pass. That is the worst possible failure mode for a gate, so
// the fix is one shared helper rather than seven separate patches: with seven
// copies, the eighth script written next month gets the bug back.
//
// `fileURLToPath` is Node's own URL→path converter. It strips the leading slash
// on Windows, decodes percent-escapes (this repo lives under a OneDrive path,
// and a space in a folder name arrives as `%20` in a URL), and rejects a
// non-file URL instead of silently producing nonsense.
//
// scripts/probe-repo-root.mjs fails if any script reintroduces the `.pathname`
// form, so this cannot regress quietly.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

// `new URL('..', ...)` ends in a slash, so fileURLToPath returns a trailing
// separator ('C:\repo\'). path.resolve removes it, so callers that build paths
// by string concatenation instead of path.join get the same answer.
/** Absolute path to the repository root, e.g. `C:\...\boston_project` or `/home/me/boston_project`. */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export default REPO_ROOT;
