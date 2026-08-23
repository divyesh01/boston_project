/**
 * PROBE: a value already in integer cents must never be handed to a formatter
 * that expects dollars.
 *
 * NOT ONE OF THE 30 PLAYBOOK ITEMS. Found 2026-08-20 while auditing item #12
 * (`money()` hides cents), because the same grep that finds every money() call
 * also shows what is being passed to it.
 *
 * THE CONTRACT, measured in section 1 rather than assumed:
 *
 *   money  = (v) => formatCents(toCents(v), 0)   // v is DOLLARS
 *   money2 = (v) => formatCents(toCents(v), 2)   // v is DOLLARS
 *   formatCents(c, d)                            // c is CENTS
 *
 * So `money2(14900)` renders "$14,900.00". When 14900 is a rate held in integer
 * cents — $149.00 — the screen is wrong by exactly 100×.
 *
 * WHAT WAS BROKEN. Two surfaces, eleven figures:
 *
 *   src/pages/Pricing.jsx     recommendedCents, baseCents, competitorRateCents and
 *                             projectedRevenueCents are all integer cents (see
 *                             pricingSettings.js: `competitorRateCents: 14900`).
 *                             Every rate and revenue figure on the yield page —
 *                             tonight's recommended rate, the comp-set position,
 *                             the 7/14/30/90-day revenue opportunity, and every
 *                             cell of the rate forecast table — rendered 100× too
 *                             high. A $149.00 recommendation read "$14,900.00".
 *
 *   src/pages/RoomBoard.jsx   rate_cents (toRateCents = dollars × 100),
 *                             revenueCents and adrCents (roomBoard.js sums
 *                             rate_cents in integer arithmetic) — the per-stay
 *                             rate, the night revenue line and the ADR beside it.
 *
 * AND ONE THAT WAS NOT MERELY COSMETIC. Pricing.jsx built the channel-manager
 * payload as:
 *
 *     rateMap[type] = money2(today.types[type].recommendedCents);
 *
 * so the rate pushed to every connected OTA was the STRING "$14,900.00" — a
 * currency-formatted string with a dollar sign and a thousands separator, in a
 * field that takes a number, carrying 100× the intended rate. The audit trail
 * written two lines later used a different, correct conversion, so the log would
 * have recorded $149 for a push of "$14,900.00". db.integrations.ChannelManager
 * .PushInventory is a client-side stub today and discards its mapping, which is
 * the only reason this has not already mispriced live inventory; that makes it a
 * latent defect, not an acceptable one.
 *
 * WHY THE STRUCTURAL SCAN IS THE POINT (section 4). Pinning the eleven lines that
 * were wrong would stop these eleven from regressing and nothing else. The scan
 * instead states the rule mechanically over the whole of src/: if the argument to
 * money()/money2() mentions an identifier ending in `Cents` or `_cents`, it must
 * pass through fromCents(). That closes the class, not the instances — a new page
 * that formats a cents field is caught on its first run.
 *
 * Run: node --import ./scripts/_loader-boot.mjs scripts/probe-cents-unit-mismatch.mjs
 */

// ── Environment ──────────────────────────────────────────────────────────────
{
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  globalThis.localStorage ??= storage;
  globalThis.sessionStorage ??= storage;
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const SRC = path.join(REPO, "src");

const { money, money2 } = await import("@/lib/hotel");
const { fromCents, formatCents } = await import("@/lib/decimal");
const { recommendRate, buildPricingForecast, addDays } = await import("@/lib/pricingEngine");
const { DEFAULT_PRICING_CONFIG } = await import("@/lib/pricingSettings");
const { roomBoardStats, toRateCents } = await import("@/lib/roomBoard");

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    failures.push(detail ? `${label} — ${detail}` : label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const eq = (label, actual, expected) =>
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

console.log("--- PROBE: CENTS HANDED TO A DOLLAR FORMATTER ---");

// ── 1. The formatter contract, measured ─────────────────────────────────────
console.log("\n[1] money()/money2() take dollars; formatCents() takes cents");
eq("money2 treats its argument as dollars", money2(14900), "$14,900.00");
eq("formatCents treats its argument as cents", formatCents(14900, 2), "$149.00");
eq("fromCents is the bridge between them", money2(fromCents(14900)), "$149.00");
// MEASURED, not assumed. My first draft of this line asserted "$150" and failed:
// formatCents computes `Math.floor(abs / SCALE)` for the whole-dollar part, so
// money() TRUNCATES. That strengthens item #12 rather than weakening it — a
// whole-dollar render does not just hide the cents, it always rounds the figure
// DOWN, so a column of money() figures understates by up to 99c per row.
eq("money truncates to whole dollars — it does not round", money(149.99), "$149");
// The exact size of the defect, computed rather than asserted.
eq("so a cents value rendered by money2 is 100x too high", money2(14900), money2(fromCents(14900) * 100));

// ── 2. The pricing engine speaks cents ──────────────────────────────────────
console.log("\n[2] pricingEngine emits integer cents");
{
  const rec = recommendRate({
    baseCents: 14900,
    occupancy: 0.85,
    isWeekend: false,
    weatherCondition: null,
    config: DEFAULT_PRICING_CONFIG,
  });
  ok("recommendedCents is an integer", Number.isInteger(rec.recommendedCents), `got ${rec.recommendedCents}`);
  // A room rate lives in the tens or low hundreds of dollars. Stated as a band so
  // this does not break when the owner edits a multiplier.
  const asDollars = fromCents(rec.recommendedCents);
  ok("read as cents, the recommendation is a plausible room rate",
    asDollars > 20 && asDollars < 1000, `got ${money2(asDollars)}`);
  ok("read as dollars, it is an absurd room rate — this is the defect",
    rec.recommendedCents > 5000, `got ${money2(rec.recommendedCents)}`);
  eq("competitorRateCents in the shipped config is cents",
    formatCents(DEFAULT_PRICING_CONFIG.competitorRateCents, 2), "$149.00");
}

// ── 3. The room board speaks cents ──────────────────────────────────────────
console.log("\n[3] roomBoardStats emits integer cents");
{
  eq("toRateCents converts dollars to cents", toRateCents(129), 12900);
  const DATE = "2026-01-15";
  const rooms = [
    { room_number: "101", property_id: "" },
    { room_number: "102", property_id: "" },
    { room_number: "103", property_id: "" },
    { room_number: "104", property_id: "" },
  ];
  const stays = [
    { room_number: "101", date: DATE, rate_cents: 12900, guest_name: "A", property_id: "" },
    { room_number: "102", date: DATE, rate_cents: 15900, guest_name: "B", property_id: "" },
  ];
  const stats = roomBoardStats(rooms, stays, DATE);
  eq("revenueCents is the integer-cents sum", stats.revenueCents, 28800);
  eq("adrCents is the integer-cents mean", stats.adrCents, 14400);
  eq("so the true night revenue is $288.00", money2(fromCents(stats.revenueCents)), "$288.00");
  eq("and rendering the cents value directly says $28,800.00", money2(stats.revenueCents), "$28,800.00");
}

// ── 4. No cents value reaches a dollar formatter anywhere in src/ ───────────
//
// The class-wide rule. Walks every money()/money2() call in src/, extracts the
// argument expression by matching parens, and requires fromCents() whenever the
// expression mentions a cents-suffixed identifier. Runs on comment-stripped
// source: a file that DOCUMENTS this defect must not fail the probe that fixed it
// (repo convention — see probe-money-kept-double-count.mjs §8). The [^:] guard
// keeps "https://" out of the line-comment rule.
console.log("\n[4] no cents-suffixed value is formatted as dollars");
{
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(js|jsx)$/.test(e.name) && !/\.test\.(js|jsx)$/.test(e.name)) out.push(p);
    }
    return out;
  };

  // The argument expression of a call, found by matching parens rather than by a
  // regex, so nested calls like money2(fromCents(a - b)) are read whole.
  const argAt = (src, openIdx) => {
    let depth = 0;
    for (let i = openIdx; i < src.length; i += 1) {
      if (src[i] === "(") depth += 1;
      else if (src[i] === ")") {
        depth -= 1;
        if (depth === 0) return src.slice(openIdx + 1, i);
      }
    }
    return src.slice(openIdx + 1);
  };

  const CENTSY = /\b[A-Za-z_$][A-Za-z0-9_$]*(?:Cents|_cents)\b/;
  const violations = [];
  let callsScanned = 0;
  let wrappedCorrectly = 0;

  for (const file of walk(SRC)) {
    const code = stripComments(fs.readFileSync(file, "utf8"));
    const re = /(?<![2A-Za-z0-9_$.])money2?\(/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      callsScanned += 1;
      const arg = argAt(code, m.index + m[0].length - 1);
      if (!CENTSY.test(arg)) continue;
      const rel = path.relative(REPO, file).replace(/\\/g, "/");
      const lineNo = code.slice(0, m.index).split("\n").length;
      if (/\bfromCents\s*\(/.test(arg)) wrappedCorrectly += 1;
      else violations.push(`${rel}:${lineNo}  ${m[0]}${arg.trim().slice(0, 60)})`);
    }
  }

  ok("the scan actually found money() calls to check", callsScanned > 100, `scanned ${callsScanned}`);
  ok("the scan is not vacuous — some calls do format a cents value via fromCents",
    wrappedCorrectly > 0, `found ${wrappedCorrectly}`);
  ok("no money()/money2() call formats a cents value without fromCents",
    violations.length === 0,
    violations.length ? `${violations.length} site(s):\n        ${violations.join("\n        ")}` : "");
  console.log(`        scanned ${callsScanned} money()/money2() calls, ${wrappedCorrectly} correctly bridged`);
}

// ── 5. The channel push sends a number, not a formatted string ──────────────
//
// A rate pushed to an OTA is not a label. money2() returns "$14,900.00": a dollar
// sign, a thousands separator, and 100x the rate. The audit call two lines below
// used a different conversion, so the trail and the push could not agree.
console.log("\n[5] the OTA rate payload is numeric dollars");
{
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/.*$/gm, "$1");
  const pricing = stripComments(fs.readFileSync(path.join(SRC, "pages", "Pricing.jsx"), "utf8"));

  ok("the rate map is not built from a formatted string",
    !/rateMap\[[^\]]*\]\s*=\s*money2?\(/.test(pricing),
    "rateMap[type] = money2(...) pushes \"$14,900.00\" to the channel manager");
  ok("the rate map is built from a cents-to-dollars conversion",
    /rateMap\[[^\]]*\]\s*=\s*fromCents\(/.test(pricing));
  ok("PushInventory is still the call being fed", /ChannelManager\.PushInventory\(/.test(pricing));

  // The audit path recorded Math.round(cents / 100) — whole dollars — so a $149.50
  // override was logged as $150.00. The push and the trail must agree exactly.
  ok("the audit path no longer truncates cents off the rate",
    !/const toDollars\s*=\s*\(cents\)\s*=>\s*Math\.round/.test(pricing),
    "toDollars() rounded to whole dollars, losing $0.50 on a $149.50 rate");
  ok("the override is handed dollars via fromCents",
    /newRate:\s*fromCents\(/.test(pricing));
  ok("Pricing.jsx imports fromCents", /import \{[^}]*fromCents[^}]*\} from "@\/lib\/decimal"/.test(pricing));
  ok("RoomBoard.jsx imports fromCents",
    /import \{[^}]*fromCents[^}]*\} from "@\/lib\/decimal"/.test(
      stripComments(fs.readFileSync(path.join(SRC, "pages", "RoomBoard.jsx"), "utf8"))
    ));
}

// ── 6. The two pricing surfaces speak only cents — blanket rule ─────────────
//
// Section 4 is name-based, and names lie. It missed `money2(rev)` in Pricing.jsx
// (a sum of projectedRevenueCents held in a variable called `rev`) and all five
// figures in PricingPanel.jsx (`recAdr`, `delta`, `projectedRev`, `revUplift`).
// Those two files are special: EVERY money figure they render is a pricing-engine
// value, and the engine emits nothing but integer cents. So for these two files
// the rule is absolute rather than name-triggered — a money2() call with no
// fromCents() in its argument is a defect regardless of what it is called.
console.log("\n[6] in Pricing.jsx and PricingPanel.jsx every money figure is bridged");
{
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/.*$/gm, "$1");
  const argAt = (src, openIdx) => {
    let depth = 0;
    for (let i = openIdx; i < src.length; i += 1) {
      if (src[i] === "(") depth += 1;
      else if (src[i] === ")") { depth -= 1; if (depth === 0) return src.slice(openIdx + 1, i); }
    }
    return src.slice(openIdx + 1);
  };

  // The chart tooltip is the one exemption, and only because the series itself is
  // converted at map time (`adr: fromCents(d.adrCents)`) — the formatter receives
  // dollars. That conversion is asserted separately below, so the exemption cannot
  // become a hiding place.
  const TOOLTIP = /formatter\s*=/;

  for (const rel of ["src/pages/Pricing.jsx", "src/components/dashboard/PricingPanel.jsx"]) {
    const code = stripComments(fs.readFileSync(path.join(REPO, rel), "utf8"));
    const lines = code.split("\n");
    const re = /(?<![2A-Za-z0-9_$.])money2?\(/g;
    const bad = [];
    let seen = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      seen += 1;
      const arg = argAt(code, m.index + m[0].length - 1);
      const lineNo = code.slice(0, m.index).split("\n").length;
      if (TOOLTIP.test(lines[lineNo - 1] || "")) continue;
      if (!/\bfromCents\s*\(/.test(arg)) bad.push(`${lineNo}: ${m[0]}${arg.trim().slice(0, 50)})`);
    }
    ok(`${rel} renders money figures at all (not vacuous)`, seen >= 5, `found ${seen}`);
    ok(`${rel}: every money figure passes through fromCents`, bad.length === 0,
      bad.length ? `${bad.length} unbridged: ${bad.join(" | ")}` : "");
  }

  const panel = stripComments(
    fs.readFileSync(path.join(REPO, "src/components/dashboard/PricingPanel.jsx"), "utf8")
  );
  ok("the ADR series is converted to dollars at map time",
    /adr:\s*fromCents\(d\.adrCents\)/.test(panel));
  ok("the panel no longer squares occupancy against a hardcoded room count",
    !/d\.occupancy \* Math\.round\(d\.occupancy \* 100\)/.test(panel),
    "Math.round(d.occupancy * Math.round(d.occupancy * 100)) valued 72 room nights at an 85% forecast");
  ok("the panel takes the base case from the engine instead of rebuilding it",
    /projectedBaseRevenueCents/.test(panel));
  ok("Pricing.jsx takes the base case from the engine too",
    /projectedBaseRevenueCents/.test(
      stripComments(fs.readFileSync(path.join(REPO, "src/pages/Pricing.jsx"), "utf8"))
    ));
}

// ── 7. The engine's base case values the SAME room nights it sells ──────────
//
// Both consumers used to reconstruct "revenue at base rates" from inputs private
// to buildPricingForecast's loop, and both got a different room count than the one
// the projected leg used — so the advertised "uplift vs base rates" compared two
// different hotels. The fix returns both legs from the one place `sold` exists.
console.log("\n[7] projected and base legs value one room-night count");
{
  const DATE = "2026-03-10"; // a Tuesday: weekday, so no weekend uplift to reason about
  const rooms = Array.from({ length: 20 }, (_, i) => ({ room_number: String(101 + i), room_type: "Standard" }));
  const reservations = Array.from({ length: 17 }, (_, i) => ({
    room_number: String(101 + i), check_in: DATE, check_out: addDays(DATE, 1),
  }));
  const [day] = buildPricingForecast({
    rooms, reservations, weatherByDate: {}, config: DEFAULT_PRICING_CONFIG, days: 1, fromDate: DATE,
  });

  eq("occupancy is 17 of 20", Math.round(day.occupancy * 100) / 100, 0.85);
  eq("projected room nights are the 17 rooms actually sold", day.projectedRoomNights, 17);
  eq("the base leg is those 17 nights at the $129.00 rack rate",
    day.projectedBaseRevenueCents, 17 * 12900);
  eq("the projected leg is those same 17 nights at the recommendation",
    day.projectedRevenueCents, 17 * day.types.Standard.recommendedCents);
  ok("so the uplift is a rate difference, not a room-count difference",
    day.projectedRevenueCents - day.projectedBaseRevenueCents ===
      17 * (day.types.Standard.recommendedCents - 12900));

  // The size of the defect this replaced, computed rather than claimed: the old
  // panel formula ignored `rooms` entirely and assumed 100 of them.
  const oldPanelNights = Math.round(day.occupancy * Math.round(day.occupancy * 100));
  ok("the formula this replaced disagreed with the real register",
    oldPanelNights !== day.projectedRoomNights,
    `old formula: ${oldPanelNights} room nights, actual: ${day.projectedRoomNights}`);
  console.log(`        old panel formula valued ${oldPanelNights} room nights; the register has ${day.projectedRoomNights}`);
}

console.log(`\n${"─".repeat(70)}`);
if (failures.length) {
  console.log("Failures:");
  failures.forEach((f) => console.log(`  • ${f}`));
}
console.log(`PASS ${pass}   FAIL ${fail}`);
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
