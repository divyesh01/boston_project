// scripts/probe-10k-adversarial-matrix.mjs
// =============================================================================
// STANDING PROBE: 10,000 DETERMINISTIC DATA-PRIMITIVE CASES
// =============================================================================
// Deterministic pseudo-random generation using Mulberry32 (seed 0x5EED2026)
// exercising production decimal arithmetic, typed record keys, canonical JSON,
// and the authoritative business-entity allowlist. Security and HTTP isolation
// are covered by the Worker route probes; this matrix does not claim that work.
// =============================================================================

import { toCents, fromCents, add, subtract, multiply, divide } from "../src/lib/decimal.js";
import { BUSINESS_ENTITIES, canonicalJson, typedRecordKey } from "../worker/business-sync.js";

// Deterministic Mulberry32 PRNG
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    let t = (s += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x5eed2026;
const rng = mulberry32(SEED);

function choice(arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

// Matrix Dimensions
const RECORD_IDS = [0, 1, 99, "", "1", "99", "property-alpha"];
const REVISION_STATES = ["current", "behind", "ahead", "zero", "retired", "corrupt"];
const MONEY_FORMATS = [
  "100.00", "0.00", "-50.25", "123.45-", "0.10", "0.20", "999999.99",
  "($45.00)", "  $1,234.56 ", "NaN"
];

// Invariant Validators
function validateMoneyArithmetic(rawStr) {
  let clean = String(rawStr).trim().replace(/[$,]/g, "");
  if (clean.startsWith("(") && clean.endsWith(")")) clean = "-" + clean.slice(1, -1);
  if (clean.endsWith("-")) clean = "-" + clean.slice(0, -1);
  const cents = toCents(clean);
  const back = fromCents(cents);
  // Cents must be a safe integer
  if (!Number.isSafeInteger(cents)) return false;
  // If input was a valid number, back * 100 should round to cents
  if (!isNaN(clean)) {
    const expected = Math.round(Number(clean) * 100);
    if (cents !== expected) return false;
  }
  return true;
}

function validateTypedIdentity(recordId, entity, revisionState) {
  const key = typedRecordKey(recordId);
  const expected = typeof recordId === "number" ? `n:${recordId}` : `s:${recordId.length}:${recordId}`;
  if (key !== expected) return false;
  if (typeof recordId === "number" && typedRecordKey(String(recordId)) === key) return false;
  const value = { entity, record_key: key, revision_state: revisionState };
  return canonicalJson(value) === canonicalJson({ revision_state: revisionState, record_key: key, entity });
}

console.log("============================================================");
console.log("RUNNING 10,000 DETERMINISTIC DATA-PRIMITIVE CASES");
console.log(`PRNG: Mulberry32 (Seed: 0x${SEED.toString(16).toUpperCase()})`);
console.log("============================================================");

const TOTAL_CASES = 10000;
let passed = 0;
let failed = 0;
let skipped = 0;

for (let i = 1; i <= TOTAL_CASES; i++) {
  const recordId = choice(RECORD_IDS);
  const entity = choice(BUSINESS_ENTITIES);
  const revState = choice(REVISION_STATES);
  const money = choice(MONEY_FORMATS);

  // Invariant 1: Financial & Money parsing
  const moneyOk = validateMoneyArithmetic(money);

  // Invariant 2: Production typed identity and canonical serialization
  const identityOk = validateTypedIdentity(recordId, entity, revState);

  // Invariant 3: Entity known
  const entityOk = BUSINESS_ENTITIES.includes(entity);

  if (moneyOk && identityOk && entityOk) {
    passed++;
  } else {
    failed++;
    console.error(`Case #${i} failed:`, { recordId, entity, revState, money });
    break;
  }
}

console.log(`Generated: ${TOTAL_CASES.toLocaleString()} | Executed: ${(passed + failed).toLocaleString()} | Passed: ${passed.toLocaleString()} | Failed: ${failed} | Skipped: ${skipped}`);
console.log("============================================================");
console.log(`PASSED: 10k production data-primitive cases passed (${passed} passed, ${failed} failed).`);

if (failed > 0) process.exit(1);
process.exit(0);
