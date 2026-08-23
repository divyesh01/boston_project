// Standalone harness for src/lib/anomalyDetector.js — the automated financial
// anomaly & fraud detection engine.
//
// Runs the REAL shipped detection functions over mock transaction sets that
// contain rate overrides, adjustment spikes, and off-hours postings, plus the
// defensive null/empty input cases the ingestion pipeline can hit.
//
// Run: node scripts/test_anomaly_detector.mjs

import { register } from "node:module";
register(new URL("./resolve-alias.mjs", import.meta.url));

const {
  detectAnomalies,
  detectRateOverrides,
  detectExcessiveAdjustments,
  detectOffHoursPostings,
  ANOMALY_TYPES,
} = await import("@/lib/anomalyDetector");

let pass = 0;
let fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
  }
};

// Shape mirrors a normalized TransactionLine row (see src/lib/transactionNorm.js).
//
// The default username used to be a real staff member's personal Gmail address,
// copied out of a PMS export. The detector never looks at the domain — it only
// groups by the string — so a reserved-domain placeholder tests exactly the same
// code path without carrying someone's identity in the repo. `.test` is reserved
// by RFC 6761 and can never resolve.
const mk = (overrides) => ({
  date: "2026-01-15",
  time: "10:14:10 AM",
  username: "clerk.one86@staff.test",
  account_class: "staff",
  transaction_code: "RR",
  transaction_type: "CHARGE",
  charge_category: "ROOM RENT",
  folio_number: "AAA086",
  room_number: "138",
  amount: 72.8,
  ...overrides,
});

// ─────────────────────────── Rate Override Detection ───────────────────────────
console.log("\n=== detectRateOverrides ===");
{
  // Property ADR is $110 (fixed baseline). $40 is >50% below; $70 and $0-rate comps are edge cases.
  const rows = [
    mk({ folio_number: "F1", amount: 110 }),
    mk({ folio_number: "F2", amount: 40, room_number: "101" }),   // FLAG: 40 < 55
    mk({ folio_number: "F3", amount: 70, room_number: "102" }),   // not flagged: 70 >= 55
    mk({ folio_number: "F4", amount: 0, room_number: "103" }),    // FLAG: comp/zero rate
    mk({ folio_number: "F5", amount: -24, room_number: "104" }),  // reversal, not a rate — ignored
    mk({ transaction_code: "FPCC", transaction_description: "MASTER", charge_category: "", amount: 300 }), // not a room charge
  ];
  const flags = detectRateOverrides(rows, { adr: 110 });
  const flaggedFolios = new Set(flags.map((f) => f.folio_number));
  T("flags room charge below 50% of ADR (40 vs 110)", flags.length === 2 && flaggedFolios.has("F2"), JSON.stringify(flags));
  T("flags zero-rate comp room", flaggedFolios.has("F4"));
  T("does not flag rate above threshold (70 vs 110)", !flaggedFolios.has("F3"));
  T("does not flag negative reversal as a rate", !flaggedFolios.has("F5"));
  T("does not flag non-room transaction", !flaggedFolios.has("FPCC") && flags.length === 2);
  T("alert carries type + detail", flags[0]?.alert_type === ANOMALY_TYPES.RATE_OVERRIDE && typeof flags[0]?.detail === "string");
  T("alert severity is high", flags.every((f) => f.severity === "high"));

  // ADR derived from the rows themselves when not supplied.
  const derived = detectRateOverrides([
    mk({ folio_number: "D1", amount: 100 }),
    mk({ folio_number: "D2", amount: 120 }),
    mk({ folio_number: "D3", amount: 30, room_number: "9" }),   // < 55 (half of 110)
    mk({ folio_number: "D4", amount: 60, room_number: "8" }),   // >= 55, ok
  ]);
  T("ADR derived from positive room-charge rows when no baseline given", derived.length === 1 && derived[0]?.folio_number === "D3", JSON.stringify(derived));
}

// ─────────────────────── Adjustment / Void Spike Detection ───────────────────────
console.log("\n=== detectExcessiveAdjustments ===");
{
  const rows = [
    mk({ username: "a@staff.test", folio_number: "A1", amount: -100 }),
    mk({ username: "a@staff.test", folio_number: "A2", amount: -150 }),
    mk({ username: "a@staff.test", folio_number: "A3", amount: -50 }),  // day total 300 > 200 → FLAG
    mk({ username: "b@staff.test", folio_number: "B1", amount: -40 }),  // day total 70 → ok
    mk({ username: "b@staff.test", folio_number: "B2", amount: -30 }),
    mk({ username: "c@staff.test", folio_number: "C1", amount: 500 }),  // positive charge, ignored
    mk({ username: "d@staff.test", folio_number: "D1", amount: -150, date: "2026-01-10" }),
    mk({ username: "d@staff.test", folio_number: "D2", amount: -100, date: "2026-01-11" }), // split across days → ok
  ];
  const flags = detectExcessiveAdjustments(rows);
  const flaggedUsers = new Set(flags.map((f) => f.username));
  T("flags username with >$200 negative adjustments in one day", flaggedUsers.has("a@staff.test"), JSON.stringify(flags));
  T("does not flag username under threshold", !flaggedUsers.has("b@staff.test"));
  T("does not flag spread across different days", !flaggedUsers.has("d@staff.test"));
  T("alert records the day total", flags[0]?.amount === 300 && flags[0]?.detail.includes("300"));
  T("alert severity is high", flags.every((f) => f.severity === "high"));

  // Custom threshold override.
  const tight = detectExcessiveAdjustments(
    [mk({ username: "e@staff.test", amount: -150 })],
    { adjustmentAmount: 100 }
  );
  T("custom threshold respected (150 > 100)", tight.length === 1);
  const loose = detectExcessiveAdjustments(
    [mk({ username: "f@staff.test", amount: -150 })],
    { adjustmentAmount: 200 }
  );
  T("default threshold not crossed (150 <= 200)", loose.length === 0);
}

// ─────────────────────────── Off-Hours Posting Detection ───────────────────────────
console.log("\n=== detectOffHoursPostings ===");
{
  const rows = [
    mk({ folio_number: "O1", time: "03:15:00 AM", transaction_code: "CASH", transaction_description: "CASH", charge_category: "", amount: 80 }), // FLAG: cash at 3am by staff
    mk({ folio_number: "O2", time: "04:45:49 AM", room_number: "7" }),  // FLAG: room charge at 4am
    mk({ folio_number: "O3", time: "02:30:00 AM", transaction_type: "REFUND", transaction_code: "FPCC", transaction_description: "MASTER", charge_category: "", amount: 100 }), // FLAG: credit/refund at 2am
    mk({ folio_number: "O4", time: "10:00:00 AM", amount: 90 }),       // ok: not off-hours
    mk({ folio_number: "O5", time: "02:30:00 AM", username: "hkcrsuser", account_class: "system" }), // ok: system account
    mk({ folio_number: "O6", time: "12:45:00 AM", amount: 95 }),       // ok: before 1am window
    mk({ folio_number: "O7", time: "05:00:00 AM", amount: 60 }),       // ok: window end exclusive
    mk({ folio_number: "O8", time: "02:30:00 AM", transaction_code: "FPCC", transaction_description: "MASTER", charge_category: "", amount: 200 }), // ok: card CHARGE is revenue, not a credit
  ];
  const flags = detectOffHoursPostings(rows);
  const flaggedFolios = new Set(flags.map((f) => f.folio_number));
  T("flags cash posting at 3am by non-system account", flaggedFolios.has("O1"), JSON.stringify(flags));
  T("flags room charge at 4am", flaggedFolios.has("O2"));
  T("flags credit/refund at 2am", flaggedFolios.has("O3"));
  T("does not flag daytime posting", !flaggedFolios.has("O4"));
  T("does not flag system account", !flaggedFolios.has("O5"));
  T("does not flag before 1am window", !flaggedFolios.has("O6"));
  T("does not flag at 5am window end", !flaggedFolios.has("O7"));
  T("does not flag a card CHARGE (revenue, not credit)", !flaggedFolios.has("O8"));
  T("alert severity is medium", flags.every((f) => f.severity === "medium"));
}

// ─────────────────────────── Combined detectAnomalies ───────────────────────────
console.log("\n=== detectAnomalies (combined) ===");
{
  const rows = [
    mk({ folio_number: "C1", amount: 20 }),                                    // rate override
    mk({ folio_number: "C2", username: "a@staff.test", amount: -250 }),             // adjustment spike
    mk({ folio_number: "C3", time: "03:00:00 AM", transaction_code: "CASH", charge_category: "", amount: 60 }), // off-hours
    mk({ folio_number: "C4", amount: 110 }),                                   // clean
  ];
  const flags = detectAnomalies(rows);
  const types = flags.map((f) => f.alert_type).sort();
  T("combines all three rule families", types.length === 3, JSON.stringify(types));
  T("flags rate override", types.includes(ANOMALY_TYPES.RATE_OVERRIDE));
  T("flags adjustment spike", types.includes(ANOMALY_TYPES.EXCESSIVE_ADJUSTMENTS));
  T("flags off-hours posting", types.includes(ANOMALY_TYPES.OFF_HOURS_POSTING));
  T("every flag has a unique dedupe key", new Set(flags.map((f) => f.dedupe_key)).size === flags.length);
}

// ─────────────────────────── Defensive: hostile input never throws ───────────────────────────
console.log("\n=== Defensive: null/undefined/empty/hostile input ===");
{
  const hostile = [null, undefined, [], [null], [{}], "not-array", 0, 42, NaN, {}];
  for (const bad of hostile) {
    for (const fn of [detectAnomalies, detectRateOverrides, detectExcessiveAdjustments, detectOffHoursPostings]) {
      let threw = false;
      try {
        fn(bad);
      } catch {
        threw = true;
      }
      T(`${fn.name}(${Array.isArray(bad) ? "[]" : String(bad)}) does not throw`, !threw);
    }
  }
  const emptyResults = [detectAnomalies([]), detectRateOverrides([]), detectExcessiveAdjustments([]), detectOffHoursPostings([])];
  T("empty array returns [] from every detector", emptyResults.every((r) => Array.isArray(r) && r.length === 0));
  const nullRows = [detectAnomalies(null), detectRateOverrides(undefined), detectExcessiveAdjustments(null), detectOffHoursPostings(undefined)];
  T("null/undefined returns [] from every detector", nullRows.every((r) => Array.isArray(r) && r.length === 0));
  const junkRows = detectAnomalies([null, undefined, { amount: "not-a-number" }, {}]);
  T("rows without usable fields yield no false flags", junkRows.length === 0, JSON.stringify(junkRows));
}

console.log(`\n${"=".repeat(62)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(62)}`);
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
