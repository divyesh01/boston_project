// GATE: automatic multi-browser merging must never be added.
//
// THE OWNER DECISION THIS ENFORCES
// --------------------------------
// Existing data reaches the shared database from ONE canonical browser. Every
// other browser's local data is DISCARDED, never merged. There is no "combine
// both laptops" path, and there must not be one.
//
// WHY (the evidence, not an opinion)
// ----------------------------------
// scripts/probe-cross-browser-merge-hazard.mjs runs the three collisions end to
// end against the real code and prints the money:
//   * same hotel, different local Property.id  -> $422.48 posted becomes $844.96
//   * different hotels, both local id 1        -> one hotel's $422.48 silently gone
//   * IdSequence reissues JOH001               -> two people, one 32h payroll row
// All three come from one fact: every foreign key in this app points at a Dexie
// `++id` autoincrement, which is a per-browser counter with no global meaning.
// Property.code is the only cross-browser-stable identifier the schema has.
//
// WHAT THIS GATE CHECKS (five gates, in order of how a merge would actually get
// built)
// -----------------------------------------------------------------------------
//   1. No module defines or exports a cross-database / multi-source merge symbol,
//      unless that file carries an explicit @canonical-merge-source declaration.
//   2. The mechanical precursors stay absent: one Dexie database in src/, no
//      indexedDB.databases() enumeration, no new IndexedDB database names.
//   3. THE PREMISE STILL HOLDS, checked at runtime, not by grep: the dedupe key
//      is still prefixed by property_id and property_id is still a per-browser
//      autoincrement. If property_id ever becomes globally stable, gate 3 FAILS
//      ON PURPOSE — the reason for the decision has moved and the decision has to
//      be re-taken by a human, not silently outlived by a gate nobody re-read.
//   4. The realtime CRDT sync path stays disabled: no endpoint in any committed
//      env file, no static y-websocket import, provider construction stays behind
//      the endpoint guard.
//   5. The gate cannot outlive its own evidence: the characterization probe still
//      exists and still covers the same three collisions.
//
// WHAT THIS GATE DELIBERATELY DOES NOT DO
// ---------------------------------------
// It does not ban the word "merge". Object merges, class-name merges, sorted
// merges and per-dataset row merges are all normal work and all pass. It fires on
// identifiers that pair a merge/sync verb with a DATABASE / BROWSER / DEVICE /
// PEER / REPLICA noun, at declaration sites only, with comments and string
// literals excluded.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/verify-no-auto-merge.mjs

await import("fake-indexeddb/auto");
globalThis.crypto ??= (await import("node:crypto")).webcrypto;

const __store = new Map();
const __storage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(k, String(v)),
  removeItem: (k) => __store.delete(k),
  clear: () => __store.clear(),
};
globalThis.localStorage = __storage;
globalThis.sessionStorage = __storage;
globalThis.window = globalThis;
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "harness", language: "en-US" },
    configurable: true,
  });
}

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? `\n         ${detail}` : ""}`);
    console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ""}`);
  }
}
const eq = (label, actual, expected) =>
  ok(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

const rel = (p) => path.relative(REPO, p).split(path.sep).join("/");

function walk(dir, exts, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
      walk(full, exts, out);
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(full);
    }
  }
  return out;
}

// Blank out comments and string/template/regex literal CONTENTS, preserving byte
// offsets and newlines so a reported index still points at the right line.
//
// Needed for correctness in both directions here. src/crdt.jsx's header comment
// contains the literal text "new WebsocketProvider()" while explaining why the
// provider must stay behind a guard, and this very file names every forbidden
// symbol in prose. A grep would fire on both. Offsets are preserved rather than
// deleted so gate 4's "is the guard before the construction site" question can be
// answered on the stripped text.
function blankNonCode(src) {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j += 1;
      blank(i, j);
      i = j;
    } else if (c === "/" && d === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j += 1;
      blank(i, Math.min(j + 2, n));
      i = j + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) break;
        if (c !== "`" && src[j] === "\n") break;
        j += 1;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return out.join("");
}

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

console.log("--- GATE: NO AUTOMATIC MULTI-BROWSER MERGE ---");
console.log("    decision: one canonical browser supplies existing data; every other");
console.log("              browser's local data is discarded, never merged.");

// ── GATE 1: no cross-database merge implementation ──────────────────────────
//
// Two tiers. The NAMED tier is the set of symbol names a merge feature would
// most plausibly be given; any of them is forbidden outright. The PATTERN tier
// catches names nobody thought of by requiring a merge/sync VERB fused to a
// database/browser/device/peer/replica NOUN — so `mergeRows`, `twMerge`,
// `mergeSort` and `deepMerge` are all fine, and `mergeDatabases`,
// `syncFromPeer`, `adoptDeviceData` are not.
const MERGE_NAMED = [
  "mergeLocalDatabases", "mergeDatabases", "mergeDatabase", "mergeBrowsers",
  "mergeBrowserData", "mergeDeviceData", "mergeLocalData", "mergeRemoteDatabase",
  "importFromBrowser", "importFromDevice", "importAnotherBrowser",
  "reconcileDatabases", "reconcileBrowsers", "unionDatabases",
  "syncFromPeer", "syncFromBrowser", "syncFromDevice", "adoptBrowserData",
  "combineDatabases", "combineBrowserData", "migrateFromBrowser",
];
const MERGE_PATTERN =
  /^(merge|sync|reconcile|union|adopt|combine|import|absorb|ingest|fuse)[A-Za-z]*?(Databases?|Browsers?|Devices?|Peers?|Replicas?|Installs?|Instances?)(From|Into|Data|s)?$/;

// A file may implement one deliberately, but only if it says so in a form a
// machine can find and a reviewer cannot miss.
const CANONICAL_MARKER = /@canonical-merge-source:\s*\S+/;

function declaredNames(code) {
  const found = [];
  const push = (name, index) => { if (name) found.push({ name, index }); };
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
    /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(code)) !== null) push(m[1], m.index);
  }
  let e;
  const exportList = /export\s*\{([^}]*)\}/g;
  while ((e = exportList.exec(code)) !== null) {
    for (const part of e[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) push(name, e.index);
    }
  }
  return found;
}

function scanForMergeSymbols(files, { namedOnly = false } = {}) {
  const hits = [];
  const declared = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const code = blankNonCode(raw);
    const marked = CANONICAL_MARKER.test(raw);
    for (const { name, index } of declaredNames(code)) {
      const named = MERGE_NAMED.includes(name);
      const patterned = !namedOnly && MERGE_PATTERN.test(name);
      if (!named && !patterned) continue;
      const record = { file: rel(file), name, line: lineOf(raw, index), tier: named ? "named" : "pattern" };
      (marked ? declared : hits).push(record);
    }
  }
  return { hits, declared };
}

console.log("\n[1] no module defines or exports a cross-database merge symbol");
{
  const srcFiles = walk(path.join(REPO, "src"), [".js", ".jsx", ".ts", ".tsx"]);
  const scriptFiles = walk(path.join(REPO, "scripts"), [".mjs", ".js"]);
  ok("there is production source to scan", srcFiles.length > 50, `${srcFiles.length} files under src/`);
  console.log(`        scanned ${srcFiles.length} files under src/ (both tiers) and ${scriptFiles.length} under scripts/ (named tier)`);

  const srcScan = scanForMergeSymbols(srcFiles);
  const scriptScan = scanForMergeSymbols(scriptFiles, { namedOnly: true });
  const all = [...srcScan.hits, ...scriptScan.hits];
  const marked = [...srcScan.declared, ...scriptScan.declared];

  for (const h of marked) {
    console.log(`        DECLARED  ${h.file}:${h.line}  ${h.name}  (@canonical-merge-source present)`);
  }
  ok("no undeclared cross-database merge symbol exists", all.length === 0,
    all.length
      ? all.map((h) => `${h.file}:${h.line}  ${h.name}  [${h.tier} tier]`).join("\n         ")
      : "");
  ok("nothing claims a canonical merge source (the decision is that there is no merge)",
    marked.length === 0,
    marked.length ? `${marked.length} file(s) carry @canonical-merge-source — a human must confirm that is still intended` : "");

  // Filenames, because a merge tool is usually a new file before it is a new symbol.
  const badFiles = [...srcFiles, ...scriptFiles]
    .map((f) => path.basename(f))
    .filter((b) => /(merge|sync|reconcile|combine)[-_.]?(db|database|databases|browser|browsers|device|devices|peer|peers)/i.test(b));
  ok("no file is named like a cross-database merge module", badFiles.length === 0, badFiles.join(", "));
}

// ── GATE 2: the mechanical precursors stay absent ───────────────────────────
//
// A merge cannot be written without first reaching a SECOND body of data. In a
// browser that means either a second IndexedDB database (a staging area for the
// other browser's export) or indexedDB.databases() to discover one. Both are
// cheap to check and both are load-bearing: the app owns exactly one data
// database, and `rri_crypto_store` (non-extractable AES-GCM key material, see
// securityUtils' openCryptoDB) is the only other name that legitimately exists.
const KNOWN_IDB_NAMES = new Set(["RedRoofIntelligence", "rri_crypto_store"]);

console.log("\n[2] the mechanical precursors of a merge stay absent");
{
  const srcFiles = walk(path.join(REPO, "src"), [".js", ".jsx", ".ts", ".tsx"]);
  const dexieSites = [];
  const enumSites = [];
  const nameLiterals = new Set();

  for (const file of srcFiles) {
    const raw = fs.readFileSync(file, "utf8");
    const code = blankNonCode(raw);
    let m;
    const dexie = /new\s+Dexie\s*\(/g;
    while ((m = dexie.exec(code)) !== null) {
      // Read the literal back out of the ORIGINAL text at the same offset.
      const tail = raw.slice(m.index, m.index + 200);
      const lit = tail.match(/new\s+Dexie\s*\(\s*(['"`])([^'"`]*)\1/);
      dexieSites.push({ file: rel(file), line: lineOf(raw, m.index), name: lit ? lit[2] : "(non-literal)" });
      if (lit) nameLiterals.add(lit[2]);
    }
    const enumRe = /indexedDB\s*\.\s*databases\s*\(/g;
    while ((m = enumRe.exec(code)) !== null) enumSites.push(`${rel(file)}:${lineOf(raw, m.index)}`);

    const openRe = /indexedDB\s*\.\s*(?:open|deleteDatabase)\s*\(/g;
    while ((m = openRe.exec(code)) !== null) {
      const tail = raw.slice(m.index, m.index + 200);
      const lit = tail.match(/indexedDB\s*\.\s*(?:open|deleteDatabase)\s*\(\s*(['"`])([^'"`]*)\1/);
      if (lit) nameLiterals.add(lit[2]);
      // A non-literal name is an identifier; resolve the common `const X = '...'` form.
      const idm = tail.match(/indexedDB\s*\.\s*(?:open|deleteDatabase)\s*\(\s*([A-Za-z_$][\w$]*)/);
      if (!lit && idm) {
        const def = raw.match(new RegExp(`const\\s+${idm[1]}\\s*=\\s*(['"\`])([^'"\`]*)\\1`));
        nameLiterals.add(def ? def[2] : `(unresolved ${idm[1]} in ${rel(file)})`);
      }
    }
  }

  console.log(`        new Dexie() sites: ${dexieSites.map((d) => `${d.file}:${d.line} => "${d.name}"`).join(", ") || "none"}`);
  console.log(`        IndexedDB database names referenced in src/: ${[...nameLiterals].join(", ") || "none"}`);
  eq("src/ opens exactly ONE Dexie database", dexieSites.length, 1);
  eq("and it is declared in src/api/localDb.js", dexieSites[0]?.file, "src/api/localDb.js");
  eq("under the single canonical name", dexieSites[0]?.name, "RedRoofIntelligence");
  ok("nothing enumerates the origin's other databases (indexedDB.databases())",
    enumSites.length === 0, enumSites.join(", "));

  const unknown = [...nameLiterals].filter((n) => !KNOWN_IDB_NAMES.has(n));
  ok("no NEW IndexedDB database name has appeared", unknown.length === 0,
    unknown.length
      ? `unrecognised: ${unknown.join(", ")} — a second data database is how a merge staging area would arrive. ` +
        `If this name is legitimate, add it to KNOWN_IDB_NAMES with a reason.`
      : "");
}

// ── GATE 3: the premise still holds (runtime, not grep) ─────────────────────
//
// This is the half that makes the gate expire correctly instead of outliving its
// reason. The decision rests on TWO facts, and both are checked by executing the
// real code:
//
//   (i)  transactionDedupeKey is prefixed by property_id, so the identity of a
//        transaction is only as stable as the identity of its property; and
//   (ii) property_id is a Dexie `++id` autoincrement, which is a PER-BROWSER
//        counter — two browsers independently mint 1, 2, 3…
//
// If someone makes property_id globally stable (a UUID, or Property.code as the
// primary key, or a server-issued id), fact (ii) stops being true, this gate
// FAILS, and that failure is the correct outcome: the reason for refusing to
// merge has changed and a human has to re-take the decision. Do not "fix" a
// gate-3 failure by relaxing the assertion.
console.log("\n[3] the premise of the decision still holds (executed, not grepped)");
{
  const localDb = (await import("@/api/localDb")).default;
  const { db } = await import("@/api/base44Client");
  const { transactionDedupeKey } = await import("@/lib/transactionNorm");
  const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");

  // (i) the key is property-scoped
  const row = { date: "2026-01-05", time: "08:14", folio_number: "F1001", transaction_code: "RM", amount: 129 };
  const k1 = transactionDedupeKey({ ...row, property_id: 1 }, 0);
  const k2 = transactionDedupeKey({ ...row, property_id: 2 }, 0);
  console.log(`        property 1 => ${k1}`);
  console.log(`        property 2 => ${k2}`);
  eq("the dedupe key's FIRST segment is the property id", k1.split("|")[0], "1");
  ok("changing only property_id changes the whole key", k1 !== k2);

  // (ii) property_id is a per-browser counter — proven by running two of them
  await localDb.delete();
  await localDb.open();
  __store.clear();
  await signInAsAllPropertyOwner();
  const primKey = localDb.Property.schema.primKey;
  console.log(`        Property primary key: keyPath=${JSON.stringify(primKey.keyPath)} auto=${primKey.auto}`);
  eq("Property still keys on `id`", primKey.keyPath, "id");
  ok("Property.id is still a LOCAL autoincrement, not a globally stable key",
    primKey.auto === true,
    "primKey.auto is false — property_id may now be globally stable. STOP: re-take the merge decision, " +
    "then update or retire this gate deliberately. Do not relax this assertion.");

  const browserA = await db.entities.Property.create({ code: "GATE-A", name: "Browser A hotel", rooms: 10, active: true });

  await localDb.delete();
  await localDb.open();
  __store.clear();
  await signInAsAllPropertyOwner();
  const browserB = await db.entities.Property.create({ code: "GATE-B", name: "Browser B hotel", rooms: 10, active: true });

  console.log(`        two independent databases, first property in each: A.id=${browserA.id}, B.id=${browserB.id}`);
  eq("browser A's first property is id 1", browserA.id, 1);
  ok("browser B's first property is THE SAME id for a DIFFERENT hotel",
    browserB.id === browserA.id,
    `A=${browserA.id} B=${browserB.id} — if these now differ, the counter has become global; re-take the decision`);

  const uniqueIdx = [];
  for (const t of localDb.tables) {
    for (const i of t.schema.indexes) if (i.unique) uniqueIdx.push(`${t.name}.${i.keyPath}`);
  }
  console.log(`        unique business keys in the whole schema: ${uniqueIdx.join(", ") || "none"}`);
  eq("Property.code is still the ONLY cross-browser-stable identifier", uniqueIdx.join(","), "Property.code");
}

// ── GATE 4: the realtime CRDT sync path stays disabled ──────────────────────
//
// A second live browser is also reachable over the wire, not just through a
// second database. src/crdt.jsx wraps the whole app in a Yjs provider; the only
// thing that keeps two tabs from converging into one shared doc is that the
// y-websocket transport stays OFF. Three facts, checked by evidence:
//   (a) no COMMITTED env file gives VITE_WEBSOCKET_ENDPOINT a value (an empty
//       value or an omitted key is the shipped "off"); .env.local is git-ignored
//       and per-machine, so it is not part of the committed contract.
//   (b) no production source STATICALLY imports y-websocket — a static import
//       wires the transport in unconditionally; the dynamic import behind the
//       endpoint guard is the only allowed form.
//   (c) every `new WebsocketProvider(...)` site is preceded by the endpoint
//       guard, so the provider is constructed only when an endpoint is truthy.
console.log("\n[4] the realtime CRDT sync path stays disabled");
{
  // (a) committed env files — resolve the tracked set from git, not from disk,
  // because "committed" is the contract (.env.local / untracked .env.* are
  // per-machine and out of scope). Fall back to the canonical committed names
  // if git is unavailable.
  const WS_KEY = "VITE_WEBSOCKET_ENDPOINT";
  let envFiles = [];
  let source = "git ls-files";
  try {
    const out = execFileSync("git", ["-C", REPO, "ls-files"], { encoding: "utf8" });
    envFiles = out.split("\n").map((s) => s.trim()).filter(Boolean)
      .filter((f) => /^\.env(\.[^/]+)?$/.test(f));
  } catch {
    source = "fallback (git unavailable)";
    envFiles = [".env", ".env.production", ".env.example"]
      .filter((f) => fs.existsSync(path.join(REPO, f)));
  }
  console.log(`        committed env files (${source}): ${envFiles.join(", ") || "none"}`);

  const readWsValue = (content) => {
    // Last non-comment assignment wins; strip inline comment and surrounding quotes.
    const re = new RegExp(`^\\s*${WS_KEY}\\s*=(.*)$`);
    let present = false;
    let value = "";
    for (const line of content.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = line.match(re);
      if (m) {
        present = true;
        value = m[1].replace(/\s+#.*$/, "").trim().replace(/^['"]|['"]$/g, "").trim();
      }
    }
    return { present, value };
  };

  ok("at least one committed env file exists to check", envFiles.length >= 1,
    "no committed env file found — cannot prove the endpoint stays unset");
  const wsOffenders = [];
  for (const f of envFiles) {
    const abs = path.join(REPO, f);
    if (!fs.existsSync(abs)) continue; // tracked but not on disk — nothing to read
    const { present, value } = readWsValue(fs.readFileSync(abs, "utf8"));
    console.log(`          ${f}: ${WS_KEY} ${present ? (value === "" ? "= (empty)" : `= "${value}"`) : "omitted"}`);
    if (present && value !== "") wsOffenders.push(`${f} sets ${WS_KEY}="${value}"`);
  }
  ok(`no committed env file gives ${WS_KEY} a value`, wsOffenders.length === 0,
    wsOffenders.join("\n         ") +
    (wsOffenders.length ? " — a committed endpoint turns realtime sync ON for every deploy" : ""));

  // (b) + (c): scan production source under src/.
  const srcFiles = walk(path.join(REPO, "src"), [".js", ".jsx", ".ts", ".tsx"]);
  const staticImports = [];
  const unguarded = [];
  const providerSites = [];
  // Static import of y-websocket at statement level: `import ... from 'y-websocket'`
  // or `import 'y-websocket'`. `import(` (dynamic) has no space before `(` and no
  // `from`, so it is excluded. Matched on RAW text (blankNonCode blanks the string
  // specifier), then gated on the blanked text so a prose mention of the import in a
  // comment does not count — the `import` keyword of real code survives blanking.
  const STATIC_WS = /\bimport\b\s+(?:[^;'"()\n]*\bfrom\s+)?(['"])y-websocket\1/g;
  // The construction site, and the endpoint guard that must precede it. Both read
  // off the blanked text so crdt.jsx's header comment (which contains the literal
  // "new WebsocketProvider()" while explaining the guard) does not trip either.
  const PROVIDER = /new\s+WebsocketProvider\s*\(/g;
  const GUARD = /if\s*\(\s*!\s*ENDPOINT\s*\)/;

  for (const file of srcFiles) {
    const raw = fs.readFileSync(file, "utf8");
    const code = blankNonCode(raw);
    let m;
    STATIC_WS.lastIndex = 0;
    while ((m = STATIC_WS.exec(raw)) !== null) {
      if (code[m.index] !== " ") staticImports.push(`${rel(file)}:${lineOf(raw, m.index)}`);
    }
    PROVIDER.lastIndex = 0;
    while ((m = PROVIDER.exec(code)) !== null) {
      const at = m.index;
      providerSites.push(`${rel(file)}:${lineOf(raw, at)}`);
      const guardBefore = code.slice(0, at).search(GUARD);
      if (!(guardBefore >= 0 && guardBefore < at)) unguarded.push(`${rel(file)}:${lineOf(raw, at)}`);
    }
  }
  console.log(`        scanned ${srcFiles.length} src files; WebsocketProvider sites: ${providerSites.join(", ") || "none"}`);
  ok("no production source statically imports y-websocket", staticImports.length === 0,
    staticImports.length ? `static import at ${staticImports.join(", ")} — must be a guarded dynamic import` : "");
  ok("every WebsocketProvider construction is preceded by the endpoint guard",
    unguarded.length === 0,
    unguarded.length ? `unguarded construction at ${unguarded.join(", ")} — provider built without checking ENDPOINT` : "");
}

// ── GATE 5: the gate cannot outlive its own evidence ────────────────────────
//
// Every reason this gate refuses a merge is proven, end to end, by the
// characterization probe. If that probe is deleted or hollowed out, the gate
// becomes a rule with no demonstrated cause behind it — enforcing a decision
// nobody can still see the evidence for. So the probe's existence and its three
// collisions are themselves an assertion here.
console.log("\n[5] the gate cannot outlive its own evidence");
{
  const probeRel = "scripts/probe-cross-browser-merge-hazard.mjs";
  const probeAbs = path.join(REPO, probeRel);
  const exists = fs.existsSync(probeAbs);
  ok("the characterization probe still exists", exists, probeRel);

  const raw = exists ? fs.readFileSync(probeAbs, "utf8") : "";
  const bytes = exists ? fs.statSync(probeAbs).size : 0;
  console.log(`        ${probeRel}: ${bytes} bytes`);
  ok("the probe is non-trivial (real evidence, not a stub)", bytes > 3000, `${bytes} bytes`);

  const markers = [
    ["same-hotel doubling", /posted becomes/],
    ["different-hotel silent suppression", /silently suppressed/],
    ["JOH001 payroll reissue", /JOH001/],
  ];
  for (const [label, re] of markers) {
    ok(`the probe still covers the ${label} collision`, re.test(raw),
      `marker ${re} not found — the gate must not outlive the collision it enforces`);
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(72)}`);
console.log("VERDICT — automatic multi-browser merge cannot be added by accident:");
console.log("  no cross-database merge symbol, no second data database, the per-browser");
console.log("  id premise still holds at runtime, the realtime sync transport stays");
console.log("  endpoint-gated, and the characterization probe still proves the hazard.");
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  • ${f}`));
}
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
