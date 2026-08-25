/**
 * PROBE: a settings save that does not land must not be reported as a save, and a
 * stored setting that cannot be read must not be replaced by a default in silence.
 *
 * NOT ONE OF THE 30 PLAYBOOK ITEMS. Found 2026-08-24 while inventorying the 45
 * empty catch blocks in src/ (measured with a balanced-brace scanner, not grep).
 * Nine of them sit in the localStorage settings modules and they all have the same
 * two shapes:
 *
 *     export function getXConfig() {
 *       try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; }
 *       catch { return { ...DEFAULTS }; }          // <- corrupt store, no notice
 *     }
 *
 *     export function saveXConfig(cfg) {
 *       try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch {}
 *       notifySettingsChanged();                   // <- announced either way
 *     }
 *
 * WHY THIS IS A MONEY DEFECT AND NOT A HYGIENE ONE. These keys hold the commission
 * rate per booking source, the card-processing fee, the fee-on-refunds switch, the
 * tax rate and the per-property tax periods. Every net-revenue and every tax figure
 * in the app is computed from them (see hotel.js `commissionFor`, taxConfig.js
 * `calculateTax`). So when `localStorage.setItem` throws — quota exhausted, or
 * Safari Private Browsing, or storage blocked in a third-party context — the
 * sequence the owner experiences is:
 *
 *   1. types the negotiated 22% Expedia rate into Settings
 *   2. the write throws and is swallowed
 *   3. notifySettingsChanged() fires anyway, so every widget re-reads...
 *   4. ...and gets the OLD rate back, because nothing was written
 *   5. the page shows its "Saved" affordance, and TaxConfigModal closes itself
 *   6. net revenue is computed at the old rate, for as long as the app is used
 *
 * There is no error, no toast and no console line anywhere in that sequence. This
 * is exactly what CLAUDE.md section 10 forbids: "Report errors loudly, not silently."
 *
 * WHAT THIS PROBE PINS DOWN
 *   1. the normal round trip still works (so the fix did not break saving)
 *   2. every setter returns true when the value landed and false when it did not
 *   3. no setter throws on a failed write (a page must not crash over a setting)
 *   4. a failed write is announced on the console, naming the key
 *   5. after a failed write the OLD value is still what the app computes with,
 *      measured through hotel.js `commissionFor` rather than a formula retyped here
 *   6. unreadable stored JSON is announced, naming the key, and still falls back
 *      to defaults rather than throwing
 *   7. a stored tax array that is not an array is announced before being dropped
 *   8. a stored CC fee that is not a number is announced before being dropped
 *   9. saveWeatherConfig still strips apiKey now that it writes through the shared
 *      helper — the OpenWeather key is server-side only and must never persist
 *
 * Run: node --import ./scripts/_loader-boot.mjs scripts/probe-settings-persistence.mjs
 */

// ── Environment ──────────────────────────────────────────────────────────────
// A localStorage whose failure modes can be switched on, because the whole point
// is what happens when the browser refuses the write.
const store = new Map();
let failWrites = false;
let failReads = false;

{
  const storage = {
    getItem: (k) => {
      if (failReads) {
        const err = new Error("The operation is insecure.");
        err.name = "SecurityError";
        throw err;
      }
      return store.has(k) ? store.get(k) : null;
    },
    setItem: (k, v) => {
      if (failWrites) {
        // The shape a real browser throws when the origin is out of quota.
        const err = new Error("Failed to execute 'setItem' on 'Storage': Setting the value exceeded the quota.");
        err.name = "QuotaExceededError";
        throw err;
      }
      store.set(k, String(v));
    },
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  };
  globalThis.localStorage ??= storage;
  globalThis.sessionStorage ??= storage;
}

// Console capture. The fix's whole user-visible contribution outside the UI is a
// console line, so the probe has to be able to read the console.
const logged = [];
const realError = console.error;
const realWarn = console.warn;
console.error = (...a) => {
  logged.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(" "));
};
console.warn = (...a) => {
  logged.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(" "));
};
const say = (...a) => realError.apply(console, a);
function drain() {
  const out = logged.slice();
  logged.length = 0;
  return out;
}
const mentions = (lines, needle) => lines.some((l) => l.includes(needle));

const commission = await import("@/lib/commissionRates");
const taxConfig = await import("@/lib/taxConfig");
const taxSettings = await import("@/lib/taxSettings");
const pricingSettings = await import("@/lib/pricingSettings");
const revenueThresholds = await import("@/lib/revenueThresholds");
const alertThresholds = await import("@/lib/alertThresholds");
const weatherSettings = await import("@/lib/weatherSettings");
const { commissionFor } = await import("@/lib/hotel");

const RATES_KEY = "rri_commission_rates_v2";
const CC_FEE_KEY = "rri_cc_fee_rate";
const CC_REFUNDS_KEY = "rri_cc_fee_refunds_v1";
const TAX_CONFIG_KEY = "rri_tax_config_v1";
const TAX_SETTINGS_KEY = "rri_tax_settings_v1";

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    failures.push(detail ? `${label} — ${detail}` : label);
    say(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const eq = (label, actual, expected) =>
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

function reset() {
  store.clear();
  failWrites = false;
  failReads = false;
  drain();
}

say("--- PROBE: SETTINGS THAT SAVE AND LOAD IN SILENCE ---");

// ── 1. The normal round trip, so the fix cannot have broken saving ───────────
say("\n[1] a successful save round-trips and reports success");
{
  reset();
  const wrote = commission.setCommissionRates({
    ...commission.getCommissionRates(),
    EXPEDIA: { type: "percentage", rate: 0.22, taxExempt: false },
  });
  eq("setCommissionRates reports success", wrote, true);
  eq("the rate the owner typed is what the app reads back", commission.getCommissionRates().EXPEDIA.rate, 0.22);
  // `commissionFor` resolves the LONGEST matching key, so the separate
  // "EXPEDIA HOTEL COLLECT" entry must NOT move when "EXPEDIA" is edited. My
  // first draft asserted 0.22 here and failed: the code was right, the
  // assertion was wrong.
  eq("...and what the real consumer resolves", commissionFor("EXPEDIA").rate, 0.22);
  eq("editing EXPEDIA leaves the longer EXPEDIA HOTEL COLLECT key alone",
    commissionFor("EXPEDIA HOTEL COLLECT").rate, 0.15);
  eq("a successful save says nothing on the console", drain().length, 0);

  eq("setCcFeeRate reports success", commission.setCcFeeRate(0.019), true);
  eq("the CC fee round-trips", commission.getCcFeeRate(), 0.019);
  eq("setCcFeeOnRefunds reports success", commission.setCcFeeOnRefunds(true), true);
  eq("the refunds switch round-trips", commission.getCcFeeOnRefunds(), true);
  eq("setTaxConfig reports success", taxConfig.setTaxConfig({ taxRate: 0.0825, taxEnabled: true, sources: taxConfig.TAX_SOURCES }), true);
  eq("the tax rate round-trips", taxConfig.getTaxRate(), 0.0825);
  eq("saveTaxSettings reports success", taxSettings.saveTaxSettings([{ property_id: "*", state_rate: 0.0825 }]), true);
  eq("the tax periods round-trip", taxSettings.getTaxSettings().length, 1);
  eq("savePricingConfig reports success", pricingSettings.savePricingConfig({ enabled: true }), true);
  eq("saveRevenueThresholds reports success", revenueThresholds.saveRevenueThresholds({ highRevenueThreshold: 7000, mediumRevenueThreshold: 4000 }), true);
  eq("the revenue thresholds round-trip", revenueThresholds.getRevenueThresholds().highRevenueThreshold, 7000);
  eq("saveAlertThresholds reports success", alertThresholds.saveAlertThresholds({ occupancyThreshold: 0.55 }), true);
  eq("the alert thresholds round-trip", alertThresholds.getAlertThresholds().occupancyThreshold, 0.55);
  eq("saveWeatherConfig reports success", weatherSettings.saveWeatherConfig({ lat: 42.36, lon: -71.06 }), true);
  eq("the coordinates round-trip", weatherSettings.getWeatherConfig().lat, 42.36);
  // The API key is server-side only. A converted writer must not start persisting
  // one just because it now goes through a shared helper.
  //
  // The value is deliberately four characters and obviously not key-shaped. My
  // first draft used "SHOULD-NEVER-PERSIST", and probe-no-real-credentials.mjs
  // failed on it: its CRED_ASSIGN pattern flags any 6+ character quoted value
  // assigned to apiKey, and its rule is that such a literal must be justified in
  // the ALLOWED_TEST_FIXTURES allowlist. Nothing here needs to go in that
  // allowlist — the assertion below is about the FIELD NAME being stripped, so
  // the value carries no meaning at all, and a probe that plants a
  // credential-shaped string to test credential handling is the pattern I keep
  // telling other agents not to write.
  weatherSettings.saveWeatherConfig({ lat: 42.36, lon: -71.06, apiKey: "nope" });
  ok("saveWeatherConfig still strips apiKey", weatherSettings.getWeatherConfig().apiKey === undefined,
    "an apiKey survived the write");
  ok("...and no key-shaped value reached storage",
    !String(store.get("rri_weather_config") || "").includes("apiKey"),
    `stored: ${store.get("rri_weather_config")}`);
}

// ── 2. A refused write must be reported, not swallowed ───────────────────────
say("\n[2] a refused write is reported as a failure, by every setter");
{
  reset();
  failWrites = true;
  const setters = [
    ["setCommissionRates", () => commission.setCommissionRates({ EXPEDIA: { type: "percentage", rate: 0.3, taxExempt: false } }), RATES_KEY],
    ["setCcFeeRate", () => commission.setCcFeeRate(0.04), CC_FEE_KEY],
    ["setCcFeeOnRefunds", () => commission.setCcFeeOnRefunds(true), CC_REFUNDS_KEY],
    ["setTaxConfig", () => taxConfig.setTaxConfig({ taxRate: 0.09, taxEnabled: true, sources: taxConfig.TAX_SOURCES }), TAX_CONFIG_KEY],
    ["saveTaxSettings", () => taxSettings.saveTaxSettings([{ property_id: "*", state_rate: 0.09 }]), TAX_SETTINGS_KEY],
    ["savePricingConfig", () => pricingSettings.savePricingConfig({ enabled: false }), "rri_pricing_config"],
    ["saveRevenueThresholds", () => revenueThresholds.saveRevenueThresholds({ highRevenueThreshold: 1 }), "rri_revenue_thresholds"],
    ["saveAlertThresholds", () => alertThresholds.saveAlertThresholds({ occupancyThreshold: 0.9 }), "rri_alert_thresholds"],
    ["saveWeatherConfig", () => weatherSettings.saveWeatherConfig({ lat: 1, lon: 2 }), "rri_weather_config"],
  ];
  for (const [name, call, key] of setters) {
    drain();
    let threw = null;
    let result;
    try {
      result = call();
    } catch (e) {
      threw = e;
    }
    ok(`${name} does not throw when the browser refuses the write`, threw === null,
      threw ? `threw ${threw.name}: ${threw.message}` : undefined);
    eq(`${name} returns false when nothing was written`, result, false);
    const lines = drain();
    ok(`${name} says so on the console`, lines.length > 0, "console was silent");
    ok(`...and names the key it could not write (${key})`, mentions(lines, key),
      `logged instead: ${JSON.stringify(lines).slice(0, 200)}`);
  }
}

// ── 3. What the app computes with after a refused write ──────────────────────
// The reason the silence matters. Measured through hotel.js, not re-derived.
say("\n[3] after a refused write the app still computes with the OLD rate");
{
  reset();
  commission.setCommissionRates({
    ...commission.getCommissionRates(),
    EXPEDIA: { type: "percentage", rate: 0.15, taxExempt: false },
  });
  const before = commissionFor("EXPEDIA").rate;
  eq("baseline rate in effect", before, 0.15);

  failWrites = true;
  const wrote = commission.setCommissionRates({
    ...commission.getCommissionRates(),
    EXPEDIA: { type: "percentage", rate: 0.22, taxExempt: false },
  });
  failWrites = false;

  eq("the setter admits the negotiated rate did not persist", wrote, false);
  const after = commissionFor("EXPEDIA").rate;
  eq("the app is still on the old rate", after, 0.15);

  // The size of the defect, computed rather than stated.
  const GROSS = 1000;
  const intendedCommission = GROSS * 0.22;
  const appliedCommission = GROSS * after;
  const gap = intendedCommission - appliedCommission;
  ok("the unreported gap is non-zero", gap !== 0, `gap was ${gap}`);
  say(`        on $${GROSS.toFixed(2)} of Expedia gross: owner set ${(0.22 * 100).toFixed(0)}% ($${intendedCommission.toFixed(2)}),`);
  say(`        app applied ${(after * 100).toFixed(0)}% ($${appliedCommission.toFixed(2)}) — $${gap.toFixed(2)} per $1,000 booked, unreported`);
}

// ── 4. Unreadable stored JSON is announced before defaults are substituted ───
say("\n[4] a corrupt stored value is announced, and still falls back safely");
{
  reset();
  store.set(RATES_KEY, '{"EXPEDIA":{"type":"percentage","rate":0.22');
  let threw = null;
  let rates;
  try {
    rates = commission.getCommissionRates();
  } catch (e) {
    threw = e;
  }
  ok("getCommissionRates does not throw on corrupt JSON", threw === null,
    threw ? `threw ${threw.name}: ${threw.message}` : undefined);
  eq("it falls back to the built-in default rate", rates?.EXPEDIA?.rate, 0.15);
  const lines = drain();
  ok("the discarded value is announced", lines.length > 0, "console was silent");
  ok(`...naming the key (${RATES_KEY})`, mentions(lines, RATES_KEY),
    `logged instead: ${JSON.stringify(lines).slice(0, 200)}`);

  reset();
  store.set(TAX_CONFIG_KEY, "not json at all");
  eq("getTaxRate falls back to the default rate", taxConfig.getTaxRate(), 0.117);
  ok("the discarded tax config is announced", mentions(drain(), TAX_CONFIG_KEY), "console was silent");

  reset();
  store.set("rri_pricing_config", "{oops");
  ok("getPricingConfig still returns a usable config", typeof pricingSettings.getPricingConfig().baseRates === "object");
  ok("the discarded pricing config is announced", mentions(drain(), "rri_pricing_config"), "console was silent");

  reset();
  store.set("rri_revenue_thresholds", "[");
  eq("getRevenueThresholds falls back", revenueThresholds.getRevenueThresholds().highRevenueThreshold, 6000);
  ok("the discarded revenue thresholds are announced", mentions(drain(), "rri_revenue_thresholds"), "console was silent");

  reset();
  store.set("rri_alert_thresholds", "]");
  eq("getAlertThresholds falls back", alertThresholds.getAlertThresholds().occupancyThreshold, 0.60);
  ok("the discarded alert thresholds are announced", mentions(drain(), "rri_alert_thresholds"), "console was silent");
}

// ── 5. A tax list that is not a list drops every period — say so ─────────────
say("\n[5] stored tax periods of the wrong shape are announced before being dropped");
{
  reset();
  store.set(TAX_SETTINGS_KEY, '{"property_id":"*","state_rate":0.0825}');
  const list = taxSettings.getTaxSettings();
  eq("a non-array tax store yields no periods", list.length, 0);
  ok("dropping every configured tax period is announced", mentions(drain(), TAX_SETTINGS_KEY), "console was silent");
}

// ── 6. A CC fee that is not a number is discarded — say so ───────────────────
say("\n[6] a stored CC fee that is not a number is announced before being dropped");
{
  reset();
  store.set(CC_FEE_KEY, "two and a half percent");
  eq("getCcFeeRate falls back to the default fee", commission.getCcFeeRate(), 0.025);
  ok("the discarded CC fee is announced", mentions(drain(), CC_FEE_KEY), "console was silent");
}

// ── 7. Reads that throw outright (Safari private mode) ───────────────────────
say("\n[7] storage that refuses reads is announced, and never crashes a page");
{
  reset();
  failReads = true;
  let threw = null;
  try {
    commission.getCommissionRates();
    commission.getCcFeeRate();
    commission.getCcFeeOnRefunds();
    taxConfig.getTaxConfig();
    taxSettings.getTaxSettings();
    pricingSettings.getPricingConfig();
    revenueThresholds.getRevenueThresholds();
    alertThresholds.getAlertThresholds();
  } catch (e) {
    threw = e;
  }
  failReads = false;
  ok("no reader throws when storage refuses reads", threw === null,
    threw ? `threw ${threw.name}: ${threw.message}` : undefined);
  ok("the blocked storage is announced", drain().length > 0, "console was silent");
}

// ── 8. The EIGHTH settings module, and the settings it turned out to ignore ───
// housekeepingConfig.js was missed when the seven above were converted (found
// 2026-08-25 while triaging the 40 raw browser-storage call sites). It had the
// same swallowed read and unguarded write, and something worse of its own: two of
// its four settings were decorative. `generateHousekeepingSchedule` hardcoded
// `* 30` and `* 15` — the very numbers housekeepingConfig ships as defaults — so
// the owner could set "Checkout (min)" to 45, click Save Standards, get
// "Productivity standards saved.", and watch neither the "N minutes required"
// line nor the estimated labor cost move. Ever.
say("\n[8] housekeeping standards: stored, clamped, reported, and actually USED");
{
  const hk = await import("@/lib/housekeepingConfig");
  const { generateHousekeepingSchedule } = await import("@/lib/laborOptimization");
  const { toCents, formatCents } = await import("@/lib/decimal");
  const HK_KEY = "rri_housekeeping_config_p1";

  // 8a. round trip and the boolean contract
  reset();
  eq("saveHousekeepingConfig reports success", hk.saveHousekeepingConfig("p1", {
    minutesPerCheckout: 45, minutesPerStayover: 20, hourlyWage: 18.25, targetLaborRevenuePercent: 12,
  }), true);
  const back = hk.getHousekeepingConfig("p1");
  eq("checkout minutes round-trip", back.minutesPerCheckout, 45);
  eq("stayover minutes round-trip", back.minutesPerStayover, 20);
  eq("hourly wage round-trips", back.hourlyWage, 18.25);
  eq("target labor % round-trips", back.targetLaborRevenuePercent, 12);
  eq("a successful save says nothing on the console", drain().length, 0);

  // 8b. THE REGRESSION THIS SECTION EXISTS FOR. The defaults are deliberately the
  // historical hardcoded constants, so threading standards through is a no-op at
  // defaults — that is what makes the fix safe. What must NOT be a no-op is a
  // CHANGED standard. Before the fix, all three of these returned 450.
  const noStandards = generateHousekeepingSchedule(10, 10);
  eq("no standards supplied reproduces the historical 10x30 + 10x15", noStandards.requiredMinutes, 450);
  eq("the shipped defaults agree with it (the fix is a no-op at defaults)",
    generateHousekeepingSchedule(10, 10, hk.getHousekeepingConfig("never-saved")).requiredMinutes, 450);
  const tuned = generateHousekeepingSchedule(10, 10, back);
  eq("the owner's 45/20 standards reach the schedule", tuned.requiredMinutes, 10 * 45 + 10 * 20);
  ok("...and therefore differ from the hardcoded answer", tuned.requiredMinutes !== 450,
    `both were ${tuned.requiredMinutes} — the standards are being ignored again`);
  eq("staff needed follows the tuned minutes (650 / 480, rounded up)", tuned.staffNeeded, 2);
  // A partial object must not read as zero work.
  eq("a partial standards object falls back per field, not to zero",
    generateHousekeepingSchedule(10, 10, { minutesPerCheckout: 45 }).requiredMinutes, 10 * 45 + 10 * 15);
  eq("a non-finite standard falls back to the default rather than erasing the workload",
    generateHousekeepingSchedule(10, 0, { minutesPerCheckout: "abc" }).requiredMinutes, 300);

  // 8c. a typed 0 is clamped to the floor, NOT reverted to the previous value.
  // The editor's onChange reports Number(e.target.value), and Number("") is 0, so
  // clearing a field sent a real 0 into `Number(x) || current` and got the old
  // value back — the clamp floors were unreachable from the UI.
  eq("clearing checkout minutes clamps to the floor, not back to 45",
    (hk.saveHousekeepingConfig("p1", { minutesPerCheckout: 0 }), hk.getHousekeepingConfig("p1").minutesPerCheckout), 10);
  eq("clearing the wage clamps to the federal minimum, not back to 18.25",
    (hk.saveHousekeepingConfig("p1", { hourlyWage: 0 }), hk.getHousekeepingConfig("p1").hourlyWage), 7.25);
  eq("a field absent from the update keeps its stored value",
    hk.getHousekeepingConfig("p1").minutesPerStayover, 20);
  eq("out-of-range high still clamps to the ceiling",
    (hk.saveHousekeepingConfig("p1", { minutesPerCheckout: 500 }), hk.getHousekeepingConfig("p1").minutesPerCheckout), 90);
  eq("the wage deliberately has no ceiling",
    (hk.saveHousekeepingConfig("p1", { hourlyWage: 250 }), hk.getHousekeepingConfig("p1").hourlyWage), 250);

  // 8d. a write that cannot land says so, and leaves the old standards in effect
  reset();
  hk.saveHousekeepingConfig("p1", { minutesPerCheckout: 45, hourlyWage: 18.25 });
  drain();
  failWrites = true;
  let threw = null;
  let wrote = null;
  try {
    wrote = hk.saveHousekeepingConfig("p1", { minutesPerCheckout: 80, hourlyWage: 99 });
  } catch (e) {
    threw = e;
  }
  failWrites = false;
  ok("a refused write does not throw out of the click handler", threw === null,
    threw ? `threw ${threw.name}: ${threw.message}` : undefined);
  eq("a refused write reports false", wrote, false);
  const lines = drain();
  ok("the refusal is announced naming the key", mentions(lines, HK_KEY), `console said: ${JSON.stringify(lines)}`);
  eq("the OLD checkout minutes are still what the app reads", hk.getHousekeepingConfig("p1").minutesPerCheckout, 45);
  eq("the OLD wage is still what the app reads", hk.getHousekeepingConfig("p1").hourlyWage, 18.25);

  // 8e. unreadable and unusable stored values are announced, never crash a page
  reset();
  store.set(HK_KEY, "{not json");
  let readThrew = null;
  let cfg = null;
  try {
    cfg = hk.getHousekeepingConfig("p1");
  } catch (e) {
    readThrew = e;
  }
  ok("corrupt stored JSON does not throw", readThrew === null,
    readThrew ? `threw ${readThrew.name}: ${readThrew.message}` : undefined);
  eq("corrupt stored JSON falls back to the default wage", cfg && cfg.hourlyWage, 16.50);
  ok("...and is announced naming the key", mentions(drain(), HK_KEY), "console was silent");

  reset();
  store.set(HK_KEY, JSON.stringify({ minutesPerCheckout: "abc", hourlyWage: 19 }));
  const partial = hk.getHousekeepingConfig("p1");
  eq("an unusable single field falls back to its default", partial.minutesPerCheckout, 30);
  eq("...while its usable neighbours survive", partial.hourlyWage, 19);
  ok("...and the discarded field is announced", mentions(drain(), "minutesPerCheckout"), "console was silent");

  reset();
  failReads = true;
  let blockedThrew = null;
  try {
    hk.getHousekeepingConfig("p1");
  } catch (e) {
    blockedThrew = e;
  }
  failReads = false;
  ok("a reader never throws when storage refuses reads", blockedThrew === null,
    blockedThrew ? `threw ${blockedThrew.name}: ${blockedThrew.message}` : undefined);

  // 8f. the estimated labor cost is integer cents, on the same basis as payroll.
  // Housekeeping.jsx computed `(requiredMinutes / 60) * Number(hourlyWage)` and
  // handed the float dollars to money(). Measured over 636,000 wage/minute pairs
  // ($7.25-$60.00 in 25c steps x 1-3000 minutes): the two forms disagree on 9,295
  // of them, and the float form is the LOW one in all 9,295 — the same downward
  // bias as tracker #53. Being honest about the blast radius: the label formats at
  // ZERO decimals, and in none of those 9,295 did the displayed string change. So
  // this is a conformance fix against the BUSINESS integer-cents directive with a
  // real but invisible error, not a visible money defect. The visible defect in
  // this cluster is 8b.
  const costCents = (wage, minutes) => Math.round((toCents(wage) * minutes) / 60);
  eq("the exact cost of 450 minutes at $16.50 is $123.75", costCents(16.50, 450), 12375);
  eq("18 minutes at $7.25 is 218 cents", costCents(7.25, 18), 218);
  eq("...where the float form yielded 217", toCents((18 / 60) * 7.25), 217);
  // `formatCents(c, 0)` FLOORS (`Math.floor(abs / SCALE)`), it does not round — so
  // $123.75 displays as "$123". My first draft of this assertion expected "$124"
  // and failed; the code was right. It also means the re-measurement of visibility
  // above had to be redone with a truncating formatter, and 0 of the 9,295 changed
  // the displayed string either way: a 1-cent shortfall only crosses a floor
  // boundary when the correct figure is an exact dollar, which never occurs here.
  eq("the label renders the cents figure without a float hop", formatCents(costCents(16.50, 450), 0), "$123");
  eq("...and whole dollars are displayed as whole dollars", formatCents(12400, 0), "$124");
  // The page derives its cost from the STORED standards, so an unsaved edit cannot
  // produce a figure that is true of no configuration at all.
  reset();
  hk.saveHousekeepingConfig("p1", { minutesPerCheckout: 45, minutesPerStayover: 20, hourlyWage: 18.25 });
  const stored = hk.getHousekeepingConfig("p1");
  const plan = generateHousekeepingSchedule(10, 10, stored);
  eq("stored standards drive both the minutes and the cost", plan.requiredMinutes, 650);
  eq("650 minutes at $18.25 is $197.71", costCents(stored.hourlyWage, plan.requiredMinutes), 19771);
}

console.error = realError;
console.warn = realWarn;

say(`\n${"─".repeat(70)}`);
if (failures.length) {
  say("Failures:");
  failures.forEach((f) => say(`  • ${f}`));
}
say(`PASS ${pass}   FAIL ${fail}`);
// Printed with console.error directly rather than through say(). Both are the same
// function by this point (console.error was restored two lines up), but
// probe-suite-integrity.mjs reads the SOURCE, not the output: its summary contract
// looks for a console.log/error/info call whose first template literal opens with
// PASSED:/FAILED:. Routed through the say() wrapper, this suite was classified
// NO_SUMMARY while printing a perfectly good verdict at runtime — a suite whose
// verdict a machine cannot find is one verify-all cannot honestly summarise.
console.error(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
