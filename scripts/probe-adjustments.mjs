// Probe for the Adjustments & Refunds parser (src/lib/reportParsers.js
// scanAdjustmentsRefunds), which is on the production import path via
// scanReport() at reportParsers.js:474.
//
// THIS PROBE HAD NEVER RUN. It read a CSV from
// `C:/Users/divye/.gemini/antigravity/brain/5d90d1ef-.../media_1786512688834.csv`
// — an absolute path into another tool's upload cache on one machine — so it died
// at `readFileSync` with ENOENT everywhere else, and it had no assertions anyway:
// it printed three counts and exited 0 no matter what they were. The fixture is
// now inline, so the probe travels with the repo and actually fails when the
// parser regresses.
//
// The fixture reproduces the real HotelKey export shape: two stacked tables
// (Adjustments, then Refunds) separated by blank lines, followed by a totals
// block, with quoted commas, parenthesised negatives and mixed date formats.
//
// Run: node scripts/probe-adjustments.mjs

// reportParsers.js imports '@/api', so the alias resolver has to be registered
// before it loads. Static imports hoist above any register() call, hence the
// dynamic import below. (scripts/_loader-boot.mjs does the same thing for the
// suites that verify-all.mjs launches; doing it here too keeps this probe
// runnable on its own, which is how anyone debugging the parser will run it.)
import { register } from 'node:module';
register(new URL('./resolve-alias.mjs', import.meta.url));

const { parseCsvText, detectSections } = await import('../src/lib/csvParser.js');
const { scanAdjustmentsRefunds } = await import('../src/lib/reportParsers.js');

let pass = 0;
let fail = 0;
const T = (name, cond, detail = '') => {
  let ok = false;
  let thrown = '';
  try {
    ok = typeof cond === 'function' ? !!cond() : !!cond;
  } catch (err) {
    thrown = ` threw ${err?.name}: ${err?.message}`;
  }
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}${thrown}`); }
};

const run = (csv) => scanAdjustmentsRefunds(parseCsvText(csv), { source: 'probe' });

// ── 1. A well-formed two-table export ────────────────────────────────────────
console.log('\n=== 1. Stacked Adjustments + Refunds tables ===');
const CLEAN = `Adjustments and Refunds Activity
Property: Red Roof Inn,Date Range: 01-Feb-26 to 03-Feb-26

Date,Time,Transaction Type,Charge Type,Guest Name,Transaction Number,Room Number,Adjustment Reason Code,Adjusted Amount,Adjusted Tax,Username,Remarks
01-Feb-26,09:15,ADJUSTMENT,ROOM,"Smith, John",T1001,101,RATE_ERROR,($25.00),($2.50),jdoe,Rate keyed wrong
02-Feb-26,14:02,ADJUSTMENT,ROOM,"Doe, Jane",T1002,205,SERVICE,-10.00,-1.00,mgr,Late checkout waived

Date,Time,Guest Name,Transaction Number,Room Number,Payment Detail,Refund Code,Payment Type Refunded,Amount,Username,Remarks
03-Feb-26,11:30,"Lee, Amy",T2001,310,VISA ****1234,RF01,VISA,$120.00,jdoe,Cancelled within policy

Grand Total,,,,,,,,$85.00
`;
{
  const r = run(CLEAN);
  console.log(`    adjustments=${r.adjustments.length} refunds=${r.refunds.length} summary=${JSON.stringify(r.summary)}`);

  T('both adjustment rows parsed', r.adjustments.length === 2, `got ${r.adjustments.length}`);
  T('the refund row parsed', r.refunds.length === 1, `got ${r.refunds.length}`);
  T('totalRows counts both tables', r.totalRows === 3, `got ${r.totalRows}`);
  T('rowsToImport carries every row', r.rowsToImport.length === 3, `got ${r.rowsToImport.length}`);

  const a0 = r.adjustments[0];
  T('date converted to ISO', a0.date === '2026-02-01', `date=${a0.date}`);
  // Parenthesised accounting negatives are the reason parseAmount exists; an
  // adjustment that lands positive turns a credit into a charge.
  T('parenthesised amount stays negative', a0.adjustedAmount === -25, `adjustedAmount=${a0.adjustedAmount}`);
  T('parenthesised tax stays negative', a0.adjustedTax === -2.5, `adjustedTax=${a0.adjustedTax}`);
  T('quoted comma inside a name is one cell', a0.guestName === 'Smith, John', `guestName=${a0.guestName}`);
  T('room number read from the right column', a0.roomNumber === '101', `roomNumber=${a0.roomNumber}`);
  T('reason code read', a0.reasonCode === 'RATE_ERROR', `reasonCode=${a0.reasonCode}`);
  T('remarks survive', a0.remarks === 'Rate keyed wrong', `remarks=${a0.remarks}`);
  T('record_type tags the row', a0.record_type === 'adjustment');

  T('leading-minus amount also negative', r.adjustments[1].adjustedAmount === -10,
    `got ${r.adjustments[1].adjustedAmount}`);

  const f0 = r.refunds[0];
  T('refund parsed with its own headers', f0.record_type === 'refund' && f0.amount === 120,
    JSON.stringify(f0));
  T('refund payment type read', f0.paymentTypeRefunded === 'VISA', `got ${f0.paymentTypeRefunded}`);
  T('refund code read', f0.refundCode === 'RF01', `got ${f0.refundCode}`);
  T('grand total captured into summary', Object.values(r.summary).includes(85),
    JSON.stringify(r.summary));

  // The refund table's headers must not leak into the adjustments table.
  T('no adjustment picked up a refund field',
    r.adjustments.every((a) => a.paymentTypeRefunded === undefined));
}

// ── 2. detectSections still recognises the two tables ────────────────────────
console.log('\n=== 2. detectSections agrees there are two tables ===');
{
  const types = detectSections(parseCsvText(CLEAN)).map((s) => s.type);
  console.log(`    -> ${types.join(', ') || '(none)'}`);
  T('adjustments section detected', types.includes('adjustments_detail'), types.join(','));
  T('refunds section detected', types.includes('refunds_detail'), types.join(','));
}

// ── 3. THE BUG: the word "total" inside a data row ───────────────────────────
// Found 2026-08-20. The section scanner tested `has("total")` against EVERY CELL
// of the row, not against a label position, and it ran BEFORE the data-row
// branches. So an ordinary adjustment whose remarks read "total comp" was never
// stored as an adjustment — and because the match also set state = "SUMMARY",
// every remaining row of the table was swallowed too. A short table could lose
// all of its rows to one guest surname.
//
// Import rows are money. Silently dropping them is the failure this project's
// directives call out by name, so these assertions are the point of the file.
console.log('\n=== 3. Data rows containing the word "total" must not be dropped ===');
{
  const csv = `Date,Time,Transaction Type,Charge Type,Guest Name,Transaction Number,Room Number,Adjustment Reason Code,Adjusted Amount,Adjusted Tax,Username,Remarks
01-Feb-26,09:15,ADJUSTMENT,ROOM,"Smith, John",T1001,101,RATE_ERROR,-25.00,-2.50,jdoe,total comp approved
02-Feb-26,10:00,ADJUSTMENT,ROOM,"Totaro, Ann",T1002,102,SERVICE,-11.00,-1.10,jdoe,ok
03-Feb-26,11:00,ADJUSTMENT,ROOM,"Ng, Bo",T1003,103,SERVICE,-12.00,-1.20,jdoe,ok
`;
  const r = run(csv);
  console.log(`    adjustments=${r.adjustments.length} summary=${JSON.stringify(r.summary)}`);
  T('the row whose REMARKS say "total" is kept',
    r.adjustments.some((a) => a.transactionNumber === 'T1001'),
    `kept=${r.adjustments.map((a) => a.transactionNumber).join(',') || '(none)'}`);
  T('a guest surname containing "total" does not drop the row',
    r.adjustments.some((a) => a.transactionNumber === 'T1002'),
    `kept=${r.adjustments.map((a) => a.transactionNumber).join(',')}`);
  T('rows AFTER the offending one are still parsed',
    r.adjustments.some((a) => a.transactionNumber === 'T1003'),
    `kept=${r.adjustments.map((a) => a.transactionNumber).join(',')}`);
  T('all three rows survive', r.adjustments.length === 3, `got ${r.adjustments.length}`);
  T('nothing was misfiled as a summary total', Object.keys(r.summary).length === 0,
    JSON.stringify(r.summary));

  // Same hazard on the refunds side.
  const rc = `Date,Time,Guest Name,Transaction Number,Room Number,Payment Detail,Refund Code,Payment Type Refunded,Amount,Username,Remarks
01-Feb-26,09:15,"Lee, Amy",T2001,310,VISA ****1234,RF01,VISA,120.00,jdoe,refund of total stay
02-Feb-26,09:20,"Kim, Sue",T2002,311,VISA ****9999,RF02,VISA,60.00,jdoe,ok
`;
  const r2 = run(rc);
  T('a refund remark containing "total" does not drop the refund', r2.refunds.length === 2,
    `got ${r2.refunds.length} summary=${JSON.stringify(r2.summary)}`);
  T('refund amounts intact',
    r2.refunds.map((f) => f.amount).join(',') === '120,60',
    r2.refunds.map((f) => f.amount).join(','));
}

// ── 3b. The cascade: a NARROW table used to lose every row after the first hit ─
// The old detector had a second arm, `row.length <= 5`, which did not require the
// word "grand". On a 5-column adjustments table any data row mentioning a total
// matched, and because the match also set state = "SUMMARY", the scanner never
// returned to the table: every row below it was consumed as a summary line, keyed
// by its first cell, overwriting the previous one.
console.log('\n=== 3b. Narrow (5-column) table must not truncate at a "total" cell ===');
{
  const csv = `Date,Guest Name,Room Number,Adjusted Amount,Username
01-Feb-26,Total Wine Group,101,-25.00,jdoe
02-Feb-26,"Doe, Jane",102,-11.00,jdoe
03-Feb-26,"Ng, Bo",103,-12.00,jdoe
`;
  const r = run(csv);
  console.log(`    adjustments=${r.adjustments.length} summary=${JSON.stringify(r.summary)}`);
  T('all three rows of the narrow table survive', r.adjustments.length === 3, `got ${r.adjustments.length}`);
  T('the guest name is kept as data, not read as a label',
    r.adjustments.some((a) => a.guestName === 'Total Wine Group'),
    JSON.stringify(r.adjustments.map((a) => a.guestName)));
  T('amounts intact and signed',
    r.adjustments.map((a) => a.adjustedAmount).join(',') === '-25,-11,-12',
    r.adjustments.map((a) => a.adjustedAmount).join(','));
  T('no row was diverted into summary', Object.keys(r.summary).length === 0, JSON.stringify(r.summary));

  // And the narrow table's own subtotal line is still recognised.
  const withTotal = run(csv + `Total,,,-48.00,\n`);
  T('a real Total line in a narrow table is still excluded from the data',
    withTotal.adjustments.length === 3, `got ${withTotal.adjustments.length}`);
  T('and is recorded in summary', Object.values(withTotal.summary).includes(-48),
    JSON.stringify(withTotal.summary));
}

// ── 4. Genuine totals rows must STILL be recognised ─────────────────────────
// The negative case for section 3: loosening the detector must not start counting
// a subtotal line as a real adjustment, which would double-count the money.
console.log('\n=== 4. Real subtotal / total rows are still excluded from the data ===');
{
  const csv = `Date,Time,Transaction Type,Charge Type,Guest Name,Transaction Number,Room Number,Adjustment Reason Code,Adjusted Amount,Adjusted Tax,Username,Remarks
01-Feb-26,09:15,ADJUSTMENT,ROOM,"Smith, John",T1001,101,RATE_ERROR,-25.00,-2.50,jdoe,ok
Sub-Total,,,,,,,,-25.00
Total,,,,,,,,-25.00

Grand Total,,,,,,,,-25.00
`;
  const r = run(csv);
  console.log(`    adjustments=${r.adjustments.length} summary=${JSON.stringify(r.summary)}`);
  T('only the real row is an adjustment', r.adjustments.length === 1, `got ${r.adjustments.length}`);
  T('the subtotal is recorded in summary, not in the data',
    Object.keys(r.summary).length >= 1, JSON.stringify(r.summary));
  T('a totals row never becomes an importable row',
    r.rowsToImport.every((x) => !/^(grand |sub[- ]?)?total/i.test(String(x.guestName || x.date || ''))),
    JSON.stringify(r.rowsToImport.map((x) => x.date)));
}

// ── 5. Hostile / malformed input must not throw or invent money ─────────────
console.log('\n=== 5. Malformed rows ===');
{
  const csv = `Date,Time,Transaction Type,Charge Type,Guest Name,Transaction Number,Room Number,Adjustment Reason Code,Adjusted Amount,Adjusted Tax,Username,Remarks
99-Zzz-26,,ADJUSTMENT,ROOM,,T9001,,,,,,
01-Feb-26,09:15,ADJUSTMENT,ROOM,"Smith, John",T9002,101,RATE_ERROR,not-a-number,,jdoe,
31-Feb-26,09:15,ADJUSTMENT,ROOM,"Bad, Date",T9003,102,X,-5.00,,jdoe,
`;
  let r = null;
  T('does not throw on malformed rows', () => { r = run(csv); return !!r; });
  if (r) {
    console.log(`    -> ${JSON.stringify(r.adjustments.map((a) => [a.transactionNumber, a.date, a.adjustedAmount]))}`);
    T('every malformed row is still surfaced, not dropped', r.adjustments.length === 3,
      `got ${r.adjustments.length}`);
    const byNum = Object.fromEntries(r.adjustments.map((a) => [a.transactionNumber, a]));
    T('an unparseable amount becomes 0, never NaN',
      byNum.T9002 && byNum.T9002.adjustedAmount === 0, `got ${byNum.T9002?.adjustedAmount}`);
    // convertDate returns "" for a date that does not exist on the calendar
    // (31 Feb). That empty string is the signal downstream code checks; a
    // fabricated "2026-02-31" would import revenue into a month no report totals.
    T('an impossible calendar date is refused, not fabricated',
      byNum.T9003 && byNum.T9003.date === '', `date=${JSON.stringify(byNum.T9003?.date)}`);
    T('amounts are finite numbers throughout',
      r.adjustments.every((a) => Number.isFinite(a.adjustedAmount) && Number.isFinite(a.adjustedTax)),
      JSON.stringify(r.adjustments.map((a) => a.adjustedAmount)));
  }
}

// ── 6. Empty input ──────────────────────────────────────────────────────────
console.log('\n=== 6. Empty and header-only input ===');
{
  const empty = run('');
  T('empty text yields zero rows and no throw', empty.totalRows === 0 && empty.rowsToImport.length === 0);
  const headerOnly = run('Date,Time,Transaction Type,Charge Type,Guest Name,Transaction Number,Room Number,Adjustment Reason Code,Adjusted Amount,Adjusted Tax,Username,Remarks\n');
  T('a header with no data rows yields zero adjustments', headerOnly.adjustments.length === 0,
    `got ${headerOnly.adjustments.length}`);
  T('meta is passed through', run('').meta?.source === 'probe');
}

console.log(`\n${fail === 0 ? 'PASSED' : 'FAILED'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
