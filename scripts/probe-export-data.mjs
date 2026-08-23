// Probe: the owner-facing export + fast-filter layer (src/lib/exportData.js).
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-export-data.mjs
//
// WHAT THIS IS DEFENDING
// Exports are the one output nobody re-checks. A dashboard number that looks
// wrong gets questioned; a CSV gets opened in Excel and pasted into a lender
// pack. So the failure modes below are all silent-by-construction, which is why
// they are asserted rather than eyeballed:
//
//   * a column that exists on row 2 but not row 1 disappearing from the file
//   * "Nuñez" arriving as "NuÃ±ez" because the file carries no BOM
//   * a cell beginning "=" executing when the recipient opens it
//   * "Today" excluding the evening shift because the range was computed in UTC
//   * an inclusive-looking date pair silently dropping its last day
//
// The date assertions are written to hold in ANY timezone: each expectation is
// built from local calendar parts, so the probe cannot pass vacuously on a UTC
// machine and fail on the owner's. The UTC-divergence cases additionally REPORT
// what the naive toISOString() path would have produced, so the bug being
// prevented is visible in the output rather than only in a comment.

process.env.TZ = process.env.TZ || "America/New_York";

let pass = 0;
let fail = 0;
const failures = [];
const T = (name, cond, detail = "") => {
  let ok = false;
  let thrown = "";
  try {
    ok = typeof cond === "function" ? !!cond() : !!cond;
  } catch (err) {
    thrown = ` threw ${err?.name}: ${err?.message}`;
  }
  if (ok) { pass++; } else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}${thrown}`); }
};

// securityUtils reaches for crypto and localStorage at module scope in places.
if (!globalThis.crypto?.getRandomValues) {
  globalThis.crypto = {
    ...globalThis.crypto,
    getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = i * 7 % 256; return a; },
  };
}
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const X = await import("../src/lib/exportData.js");

console.log("=".repeat(72));
console.log("OWNER EXPORT + FAST FILTERS — verification");
console.log("=".repeat(72));

// ── 1. Local calendar keys ───────────────────────────────────────────────────
console.log("\n=== 1. Dates are read in the owner's timezone, not UTC ===");
{
  // 9pm local on 20 Aug. In every timezone behind UTC this is already 21 Aug in
  // UTC, which is what makes the naive path wrong.
  const evening = new Date(2026, 7, 20, 21, 0, 0);
  T("toLocalDayKey reads the local calendar day", X.toLocalDayKey(evening) === "2026-08-20",
    String(X.toLocalDayKey(evening)));
  const utcSlice = evening.toISOString().slice(0, 10);
  console.log(`  local day 2026-08-20 21:00 -> toLocalDayKey ${X.toLocalDayKey(evening)}, toISOString slice ${utcSlice}` +
    (utcSlice === "2026-08-20" ? "  (this machine is at/ahead of UTC, so the two agree here)" : "  <- the naive path is off by a day"));

  const newYearsEve = new Date(2026, 11, 31, 23, 30, 0);
  T("31 December late evening stays in its own year",
    X.toLocalDayKey(newYearsEve) === "2026-12-31", String(X.toLocalDayKey(newYearsEve)));

  T("an ISO string is accepted", X.toLocalDayKey(new Date(2026, 0, 5, 12).toISOString()) === "2026-01-05");
  T("garbage returns null rather than a wrong day", X.toLocalDayKey("not a date") === null);
  T("null returns null — NOT the Unix epoch, which new Date(null) would give",
    X.toLocalDayKey(null) === null, String(X.toLocalDayKey(null)));
  T("undefined returns null", X.toLocalDayKey(undefined) === null);
  T("the empty string returns null, not the epoch", X.toLocalDayKey("") === null, String(X.toLocalDayKey("")));
  T("false returns null, not the epoch", X.toLocalDayKey(false) === null, String(X.toLocalDayKey(false)));
  T("epoch milliseconds are still accepted as a real date",
    X.toLocalDayKey(new Date(2026, 4, 6, 12).getTime()) === "2026-05-06",
    String(X.toLocalDayKey(new Date(2026, 4, 6, 12).getTime())));
  T("months and days are zero-padded", X.toLocalDayKey(new Date(2026, 0, 9, 12)) === "2026-01-09",
    String(X.toLocalDayKey(new Date(2026, 0, 9, 12))));
}

// ── 2. Quick ranges ──────────────────────────────────────────────────────────
console.log("\n=== 2. Quick ranges land on the days an owner means ===");
{
  // Fixed clock: Thursday 20 August 2026, 21:00 local.
  const now = new Date(2026, 7, 20, 21, 0, 0);
  const r = (id) => X.resolveQuickRange(id, now);

  T("today = the local day, both ends", r("today").from === "2026-08-20" && r("today").to === "2026-08-20",
    JSON.stringify(r("today")));
  T("7 days includes today and the six before it (14th-20th)",
    r("7d").from === "2026-08-14" && r("7d").to === "2026-08-20", JSON.stringify(r("7d")));
  T("30 days spans 22 Jul - 20 Aug",
    r("30d").from === "2026-07-22" && r("30d").to === "2026-08-20", JSON.stringify(r("30d")));
  T("month to date starts on the 1st", r("mtd").from === "2026-08-01", JSON.stringify(r("mtd")));
  T("quarter to date starts 1 Jul for an August day", r("qtd").from === "2026-07-01", JSON.stringify(r("qtd")));
  T("year to date starts 1 Jan", r("ytd").from === "2026-01-01", JSON.stringify(r("ytd")));
  T("all time is open at BOTH ends, not a wide guess",
    r("all").from === null && r("all").to === null, JSON.stringify(r("all")));
  T("an unknown id degrades to all-time rather than throwing",
    r("nonsense").from === null, JSON.stringify(r("nonsense")));

  // Quarter boundaries: each of the four must map to its own quarter start.
  for (const [month, expected] of [[0, "01"], [2, "01"], [3, "04"], [5, "04"], [6, "07"], [8, "07"], [9, "10"], [11, "10"]]) {
    const d = new Date(2026, month, 15, 12);
    T(`quarter start for month ${month + 1} is 2026-${expected}-01`,
      X.resolveQuickRange("qtd", d).from === `2026-${expected}-01`,
      String(X.resolveQuickRange("qtd", d).from));
  }

  // Month-length arithmetic: 30 days back from 1 March in a non-leap year must
  // cross February correctly rather than land on "2026-02-31".
  const mar1 = new Date(2026, 2, 1, 10);
  T("30 days back from 1 Mar 2026 = 31 Jan 2026 (no invalid day)",
    X.resolveQuickRange("30d", mar1).from === "2026-01-31", String(X.resolveQuickRange("30d", mar1).from));
  const mar1Leap = new Date(2028, 2, 1, 10);
  T("and in a leap year = 1 Feb 2028",
    X.resolveQuickRange("30d", mar1Leap).from === "2028-02-01", String(X.resolveQuickRange("30d", mar1Leap).from));

  // Every advertised preset must resolve. A button in QUICK_RANGES with no
  // implementation would render and then do nothing.
  for (const q of X.QUICK_RANGES) {
    const got = X.resolveQuickRange(q.id, now);
    T(`preset "${q.id}" resolves to a well-formed range`,
      got && (got.from === null || /^\d{4}-\d{2}-\d{2}$/.test(got.from)) &&
      (got.to === null || /^\d{4}-\d{2}-\d{2}$/.test(got.to)), JSON.stringify(got));
    T(`preset "${q.id}" never ends before it starts`,
      !got.from || !got.to || got.from <= got.to, JSON.stringify(got));
  }
  T("isQuickRange accepts a real id", X.isQuickRange("mtd") === true);
  T("isQuickRange rejects an unknown id", X.isQuickRange("last-tuesday") === false);
}

// ── 3. Range membership ──────────────────────────────────────────────────────
console.log("\n=== 3. A date range includes both of its endpoints ===");
{
  const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();
  T("no range = everything passes", X.withinRange(at(2020, 1, 1), null, null) === true);
  T("the FIRST day is included", X.withinRange(at(2026, 8, 1), "2026-08-01", "2026-08-31") === true);
  T("the LAST day is included — a half-open range would drop it",
    X.withinRange(at(2026, 8, 31), "2026-08-01", "2026-08-31") === true);
  T("the last day is included even at 23:59 local",
    X.withinRange(at(2026, 8, 31, 23), "2026-08-01", "2026-08-31") === true);
  T("an evening event on the last day is NOT pushed out by UTC",
    X.withinRange(at(2026, 8, 31, 21), "2026-08-01", "2026-08-31") === true);
  T("the day before the range is excluded", X.withinRange(at(2026, 7, 31), "2026-08-01", "2026-08-31") === false);
  T("the day after the range is excluded", X.withinRange(at(2026, 9, 1), "2026-08-01", "2026-08-31") === false);
  T("an open-ended start works", X.withinRange(at(2019, 1, 1), null, "2026-08-31") === true);
  T("an open-ended end works", X.withinRange(at(2030, 1, 1), "2026-08-01", null) === true);
  T("an undated row is excluded when a range is active, not passed through",
    X.withinRange(null, "2026-08-01", "2026-08-31") === false);
  T("an unparseable date is excluded when a range is active",
    X.withinRange("whenever", "2026-08-01", "2026-08-31") === false);
  T("an undated row still passes when NO range is active",
    X.withinRange(null, null, null) === true);

  const rows = [{ created_date: at(2026, 8, 2) }, { created_date: null }, { created_date: "" }, {}];
  T("countUndated counts every unreadable date", X.countUndated(rows) === 3, String(X.countUndated(rows)));
  T("countUndated respects a custom key",
    X.countUndated([{ when: at(2026, 8, 2) }, { when: null }], "when") === 1);
}

// ── 4. CSV correctness ───────────────────────────────────────────────────────
console.log("\n=== 4. CSV: no lost columns, no executed formulas, Excel-readable ===");
{
  // THE DATA-LOSS CASE. Row 1 has no `device`; row 2 does. Object.keys(rows[0])
  // would export two columns and drop `device` entirely.
  const hetero = [
    { id: "1", action: "Login" },
    { id: "2", action: "Password Change", device: "iPhone" },
    { id: "3", detail: "note", action: "Export" },
  ];
  const cols = X.unionColumns(hetero);
  T("unionColumns finds every key across every row",
    cols.length === 4 && cols.includes("device") && cols.includes("detail"), cols.join(","));
  T("unionColumns preserves first-seen order", cols.join(",") === "id,action,device,detail", cols.join(","));
  T("unionColumns tolerates nulls and non-objects in the array",
    X.unionColumns([null, "x", { a: 1 }]).join(",") === "a");
  T("unionColumns of nothing is empty", X.unionColumns([]).length === 0 && X.unionColumns(null).length === 0);

  const csv = X.buildCsv(hetero);
  const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
  T("the header carries all four columns", lines[0] === '"id","action","device","detail"', lines[0]);
  T("a row missing a column exports an empty cell, not a shifted row",
    lines[1] === '"1","Login","",""', lines[1]);
  T("a later row's extra column is present", lines[2] === '"2","Password Change","iPhone",""', lines[2]);
  T("every data row has the same cell count as the header",
    lines.every((l) => l.split('","').length === 4), lines.join(" | "));

  T("the file starts with a UTF-8 BOM so Excel reads it as UTF-8", csv.charCodeAt(0) === 0xfeff,
    `first char code ${csv.charCodeAt(0)}`);
  T("records are CRLF-terminated per RFC 4180", /\r\n/.test(csv) && !/[^\r]\n/.test(csv));
  T("the file ends with a line terminator", csv.endsWith("\r\n"));
  T("bom: false omits it", X.buildCsv(hetero, { bom: false }).charCodeAt(0) !== 0xfeff);

  // Formula injection. Each of these opens as a live formula in Excel/Sheets.
  //
  // The minus case is the canonical DDE payload rather than the string "-1".
  // UPDATED 2026-08-20: this used to assert that "-1" exported as '-1, which was
  // asserting a defect — see §4b below and the note on csvCell in exportData.js.
  const evil = [
    { a: "=1+1", b: "+1", c: "-2+3+cmd|' /C calc'!A0", d: "@SUM(A1)", e: "\tTAB", f: "\rCR", g: "  =cmd|' /C calc'!A0" },
  ];
  const line = X.buildCsv(evil, { bom: false }).split("\r\n")[1];
  for (const [label, cell] of [["=", '"\'=1+1"'], ["+", '"\'+1"'], ["-", '"\'-2+3+cmd'], ["@", '"\'@SUM(A1)"']]) {
    T(`a cell starting "${label}" is neutralised with a leading quote`, line.includes(cell), line);
  }
  T("a tab-prefixed cell is neutralised", line.includes('"\'\tTAB"'), JSON.stringify(line));
  T("a CR-prefixed cell is neutralised", line.includes('"\'\rCR"'), JSON.stringify(line));
  T("a whitespace-padded formula is neutralised", line.includes("\"'  =cmd"), line);

  // ── 4b. Negative money must stay a NUMBER ─────────────────────────────────
  // The formula guard fires on any cell whose first character is "-", and every
  // refund, adjustment, loyalty discount and closed-balance folio in this app is
  // stored signed-negative (REFUND_FIELDS in paymentNorm.js). Guarding those
  // turned the one column an owner most wants to total into text.
  {
    const money = X.buildCsv(
      [{ amount: -25.5, refund: "-1234.56", zero: 0, exp: "-1.2e3", pct: ".5", pos: 1234.56 }],
      { bom: false },
    ).split("\r\n")[1];
    T("a negative number is NOT prefixed with a quote", money.includes('"-25.5"'), money);
    T("a negative numeric STRING is not prefixed either", money.includes('"-1234.56"'), money);
    T("negative exponent notation is recognised as numeric", money.includes('"-1.2e3"'), money);
    T("a bare decimal is recognised as numeric", money.includes('".5"'), money);
    T("no cell in a money row carries a guard quote", !money.includes("\"'"), money);
    // And the guard is still maximal for anything that is not exactly a number.
    for (const payload of ["-2+3", "- 1", "+1", "-1,000", "-$5", "=-1"]) {
      const cell = X.buildCsv([{ a: payload }], { bom: false }).split("\r\n")[1];
      T(`"${payload}" is not treated as a number`, cell === `"'${payload}"`, cell);
    }
  }

  // Quoting and escapes.
  const tricky = [{ a: 'say "hi"', b: "a,b", c: "line1\nline2", d: null, e: undefined, f: 0, g: false }];
  const tl = X.buildCsv(tricky, { bom: false }).split("\r\n")[1];
  T("embedded double quotes are doubled", tl.includes('"say ""hi"""'), tl);
  T("an embedded comma does not split the record", tl.includes('"a,b"'), tl);
  T("an embedded newline stays inside its quoted cell", tl.includes('"line1\nline2"'), JSON.stringify(tl));
  T("null exports as an empty cell, not the text 'null'", !/"null"/.test(tl), tl);
  T("undefined exports as an empty cell, not 'undefined'", !/"undefined"/.test(tl), tl);
  T("zero exports as 0 and is NOT blanked by a falsy check", tl.includes('"0"'), tl);
  T("false exports as false and is NOT blanked", tl.includes('"false"'), tl);

  // Explicit columns: labels, order, and a formatter.
  const labelled = X.buildCsv([{ created_date: "2026-08-20T01:00:00.000Z", n: 5 }], {
    bom: false,
    columns: [
      { key: "n", label: "Count" },
      { key: "created_date", label: "When", format: (v) => X.toLocalDayKey(v) },
    ],
  }).split("\r\n");
  T("explicit columns control the order", labelled[0] === '"Count","When"', labelled[0]);
  T("a format function is applied to the cell", labelled[1] === '"5","2026-08-19"' || labelled[1] === '"5","2026-08-20"',
    labelled[1]);
  T("a column with no label falls back to its key",
    X.buildCsv([{ x: 1 }], { bom: false, columns: [{ key: "x" }] }).split("\r\n")[0] === '"x"');
  T("an empty row set with no columns yields no header row",
    X.buildCsv([], { bom: false }) === "");
}

// ── 5. Download guard ────────────────────────────────────────────────────────
console.log("\n=== 5. Export button cannot silently do nothing ===");
{
  let threw = null;
  try { X.downloadCsv([], { filename: "x" }); } catch (e) { threw = e; }
  T("exporting zero rows throws instead of downloading an empty file", !!threw, String(threw));
  T("and the message says WHY, so the page can show it",
    /no rows match/i.test(threw?.message || ""), threw?.message);

  // Simulate the browser bits and assert the anchor is attached before .click()
  // (Firefox ignores a detached anchor) and that the blob is not revoked on the
  // same tick (which races the browser's read and produces an empty file).
  const events = [];
  let revoked = false;
  globalThis.URL.createObjectURL = () => "blob:probe";
  globalThis.URL.revokeObjectURL = () => { revoked = true; events.push("revoke"); };
  globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
  const anchor = {
    click: () => events.push("click"),
    remove: () => events.push("remove"),
    set download(v) { anchor._download = v; },
    get download() { return anchor._download; },
    style: {},
  };
  globalThis.document = {
    createElement: () => anchor,
    body: { appendChild: () => events.push("append") },
  };

  const n = X.downloadCsv([{ a: 1 }, { a: 2 }], { filename: "audit-log" });
  T("downloadCsv returns the row count so the caller can report it", n === 2, String(n));
  T("the anchor is appended BEFORE it is clicked", events.indexOf("append") < events.indexOf("click"),
    events.join(","));
  T("the blob URL is NOT revoked on the same tick as the click", revoked === false, events.join(","));
  T("the filename is stamped with a local date and time",
    /^audit-log_\d{4}-\d{2}-\d{2}_\d{4}\.csv$/.test(anchor.download), String(anchor.download));
  await new Promise((r) => setTimeout(r, 5));
  T("the blob URL IS revoked on a later tick, so nothing leaks", revoked === true, events.join(","));
  T("an explicit .csv filename is passed through unchanged", () => {
    X.downloadCsv([{ a: 1 }], { filename: "exact-name.csv" });
    return anchor.download === "exact-name.csv";
  }, String(anchor.download));
}

// ── 6. Filename stamping ─────────────────────────────────────────────────────
console.log("\n=== 6. Filenames ===");
{
  const at = new Date(2026, 7, 20, 9, 5, 0);
  T("stamp uses local date and zero-padded local time",
    X.stampFilename("audit log", "csv", at) === "audit-log_2026-08-20_0905.csv",
    X.stampFilename("audit log", "csv", at));
  T("path separators and quotes cannot escape the filename, and '..' is collapsed",
    X.stampFilename('../../etc/pa"sswd', "csv", at) === ".-.-etc-pa-sswd_2026-08-20_0905.csv" ||
    X.stampFilename('../../etc/pa"sswd', "csv", at) === "etc-pa-sswd_2026-08-20_0905.csv",
    X.stampFilename('../../etc/pa"sswd', "csv", at));
  T("no dot-dot survives in a stamped filename",
    !X.stampFilename("../../x", "csv", at).includes(".."), X.stampFilename("../../x", "csv", at));
  T("an empty base still produces a usable name",
    X.stampFilename("", "csv", at) === "export_2026-08-20_0905.csv", X.stampFilename("", "csv", at));
  T("the extension is honoured", X.stampFilename("x", "xlsx", at).endsWith(".xlsx"));
}

// ── 7. Filter persistence ────────────────────────────────────────────────────
console.log("\n=== 7. The dashboard remembers how the owner left it ===");
{
  const fallback = { range: "30d", result: "all", category: "ALL" };
  X.clearStoredFilters("audit");
  T("with nothing stored, the defaults come back",
    JSON.stringify(X.readStoredFilters("audit", fallback)) === JSON.stringify(fallback));

  X.writeStoredFilters("audit", { range: "today", result: "failed", category: "AUTH" });
  const back = X.readStoredFilters("audit", fallback);
  T("a stored choice is restored", back.range === "today" && back.result === "failed", JSON.stringify(back));

  X.writeStoredFilters("audit", { range: "today", evil: "<script>", __proto__: { polluted: true } });
  const guarded = X.readStoredFilters("audit", fallback);
  T("keys the page never declared are dropped", guarded.evil === undefined, JSON.stringify(guarded));
  T("undeclared keys cannot reach the page state", Object.keys(guarded).join(",") === "range,result,category",
    Object.keys(guarded).join(","));
  T("declared keys absent from storage fall back", guarded.category === "ALL", JSON.stringify(guarded));
  T("prototype pollution through the stored blob does not take",
    ({}).polluted === undefined && guarded.polluted === undefined);

  store.set("rri_filters_audit", "{not json");
  T("corrupt storage degrades to defaults instead of crashing the page",
    JSON.stringify(X.readStoredFilters("audit", fallback)) === JSON.stringify(fallback));
  store.set("rri_filters_audit", '"a string"');
  T("a non-object payload degrades to defaults",
    JSON.stringify(X.readStoredFilters("audit", fallback)) === JSON.stringify(fallback));
  store.set("rri_filters_audit", "[1,2,3]");
  T("an array payload degrades to defaults",
    JSON.stringify(X.readStoredFilters("audit", fallback)) === JSON.stringify(fallback));

  // Safari private mode throws on setItem. A filter preference must never take
  // the page down with it.
  const good = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => { throw new Error("SecurityError"); },
    setItem: () => { throw new Error("QuotaExceededError"); },
    removeItem: () => { throw new Error("SecurityError"); },
  };
  T("a throwing localStorage read returns defaults",
    JSON.stringify(X.readStoredFilters("audit", fallback)) === JSON.stringify(fallback));
  T("a throwing localStorage write reports false rather than throwing",
    X.writeStoredFilters("audit", { range: "today" }) === false);
  T("a throwing localStorage clear does not throw", () => { X.clearStoredFilters("audit"); return true; });
  globalThis.localStorage = good;
}

// ── 8. Visible filter state ──────────────────────────────────────────────────
console.log("\n=== 8. An active filter is visible, so a subtotal is never read as a total ===");
{
  T("describeRange names a single day with its year",
    X.describeRange("2026-08-20", "2026-08-20") === new Date(2026, 7, 20)
      .toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
    String(X.describeRange("2026-08-20", "2026-08-20")));
  T("describeRange joins two days with an en dash",
    /–/.test(X.describeRange("2026-08-01", "2026-08-20")), String(X.describeRange("2026-08-01", "2026-08-20")));
  T("a cross-year range shows both years",
    (X.describeRange("2025-12-01", "2026-01-15").match(/20\d\d/g) || []).length === 2,
    String(X.describeRange("2025-12-01", "2026-01-15")));
  T("no range describes as null, so the caller renders nothing",
    X.describeRange(null, null) === null);
  T("an open start is described as 'until'", /^until /.test(X.describeRange(null, "2026-08-20")));
  T("an open end is described as 'from'", /^from /.test(X.describeRange("2026-08-20", null)));

  const parts = X.describeFilters({ Range: "Aug 1 – Aug 20", Property: null, Search: "refund", Failed: true, Empty: "" });
  T("describeFilters lists only the filters that are actually on",
    parts.length === 3, JSON.stringify(parts));
  T("a boolean filter is listed by name alone", parts.includes("Failed"), JSON.stringify(parts));
  T("a valued filter is listed as label: value", parts.includes("Search: refund"), JSON.stringify(parts));
  T("nothing active yields an empty list", X.describeFilters({}).length === 0);
  T("describeFilters tolerates null input", X.describeFilters(null).length === 0);
}

// ── 9. The XLSX button produces the SAME file as the CSV button ──────────────
console.log("\n=== 9. CSV and Excel agree on columns, labels and values ===");
{
  const COLS = [
    { key: "date", label: "Date" },
    { key: "guest", label: "Guest" },
    { key: "amount", label: "Amount" },
  ];
  const rows = [
    { date: "2026-08-01", guest: "Nuñez", amount: -25.5, ignored: "not in COLS" },
    { date: "2026-08-02", guest: "=cmd|' /C calc'!A0", amount: "1234.56" },
  ];
  const sheet = X.buildSheetRows(rows, { columns: COLS });

  T("the header row is the owner-facing labels", JSON.stringify(sheet[0]) === '["Date","Guest","Amount"]', JSON.stringify(sheet[0]));
  T("the sheet has one row per record plus the header", sheet.length === 3, `got ${sheet.length}`);
  T("a column absent from the spec is not exported", sheet[0].length === 3 && sheet[1].length === 3);
  T("a negative amount is a NUMBER in the sheet, so Excel can total it",
    sheet[1][2] === -25.5 && typeof sheet[1][2] === "number", JSON.stringify(sheet[1][2]));
  T("a numeric string is coerced to a number too",
    sheet[2][2] === 1234.56 && typeof sheet[2][2] === "number", JSON.stringify(sheet[2][2]));
  T("a formula payload is neutralised in the sheet as well",
    String(sheet[2][1]).startsWith("'="), JSON.stringify(sheet[2][1]));
  T("unicode is preserved verbatim", sheet[1][1] === "Nuñez", JSON.stringify(sheet[1][1]));

  // The two builders must agree cell for cell, otherwise the CSV and XLSX buttons
  // hand two different files to the same accountant.
  const csvLines = X.buildCsv(rows, { bom: false, columns: COLS }).split("\r\n").filter(Boolean);
  T("CSV headers match sheet headers",
    csvLines[0] === sheet[0].map((h) => `"${h}"`).join(","), csvLines[0]);
  T("CSV body matches sheet body cell for cell",
    csvLines.slice(1).every((line, i) => line === sheet[i + 1].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")),
    csvLines.slice(1).join(" | "));

  T("with no column spec the sheet still unions every key",
    JSON.stringify(X.buildSheetRows(rows)[0]) === '["date","guest","amount","ignored"]',
    JSON.stringify(X.buildSheetRows(rows)[0]));
  T("an empty row set builds no sheet rows", X.buildSheetRows([]).length === 0);
  T("downloadExcel throws rather than silently doing nothing", () => {
    try { X.downloadExcel([], { filename: "x" }); return false; } catch { return true; }
  });
}

console.log("\n" + "=".repeat(72));
console.log(`PASS ${pass}   FAIL ${fail}`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log("  ✗ " + f));
}
console.log("=".repeat(72));
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
