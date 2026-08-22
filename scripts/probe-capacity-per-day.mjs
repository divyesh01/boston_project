// Probe: capacity is inventory per DAY, and the two live implementations agree.
//
// WHAT WENT WRONG, in plain terms.
//
// "Capacity" means how many room-nights were available to sell. A 50-room hotel
// open for 30 days has capacity 1500. Occupancy and RevPAR are both DIVIDED by
// capacity, so if capacity is wrong those two headline numbers are wrong by the
// same factor.
//
// This PMS legitimately emits SEVERAL occupancy rows for one (property, business
// date) — duplicate report sections are real data here, not corruption. The old
// code in src/lib/hotel.js added a whole property's inventory once PER ROW, so a
// month whose export carried two sections per date bought 60 days of inventory
// for a 30-day month. Measured before the fix:
//
//     TRUE      capacity 1500   occupancy 70.0%   RevPAR $70.00   days 30
//     REPORTED  capacity 3000   occupancy 35.0%   RevPAR $35.00   days 60
//
// Half. On a real month, silently, with no individual row looking wrong — and the
// MORE complete the import, the WORSE the understatement.
//
// It was also a SPLIT BRAIN, which is the part worth remembering. The same bug had
// already been fixed in src/lib/calculationService.js on 2026-08-20 (capacityCents
// there) and NOT in hotel.js. Two live read paths therefore disagreed about the
// same month: the Action Center and owner intelligence said 70%, while the Compare
// page, the Monthly Calendar, MTD Growth and the Room Board said 35%. Nothing
// compared them, so nothing complained.
//
// Section 4 is the part that keeps this closed: it runs BOTH implementations over
// the same rows and fails on any disagreement. Fixing one copy of a duplicated
// rule and leaving the other is the failure mode here, so the probe checks for
// agreement rather than for a particular number.
//
// SUMMED, NOT MAXED, within a day. When several rows for one date DO state a
// `total_rooms`, their values are added. That is deliberate: dailyAggregates.js
// has already collapsed those rows into one `occ_capacity_rooms` by summing, and a
// max cannot be recovered from a sum — so a max here would make the live ledger
// and the pre-aggregated cache disagree, which is the very thing section 4 exists
// to prevent. Section 3 pins it.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-capacity-per-day.mjs

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { REPO_ROOT } from './_repo-root.mjs';

register(pathToFileURL(path.join(REPO_ROOT, 'scripts/resolve-alias.mjs')));

const hotel = await import(pathToFileURL(path.join(REPO_ROOT, 'src/lib/hotel.js')).href);
const { CalculationService } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'src/lib/calculationService.js')).href
);

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const near = (a, b, eps = 0.0001) =>
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= eps;

function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n── ${title}`);
}

const PROPS = [{ id: 'A', name: 'Alpha', rooms: 50 }, { id: 'B', name: 'Bravo', rooms: 100 }];
const ROOM_MAP = { A: 50, B: 100 };

// ── 1. One date, several report sections ────────────────────────────────────
section('1. Several rows for ONE date buy ONE day of inventory');
{
  const rows = [
    { property_id: 'A', date: '2026-01-01', room_revenue: 1000, rooms_sold: 10 },
    { property_id: 'A', date: '2026-01-01', room_revenue: 500, rooms_sold: 5 },
    { property_id: 'A', date: '2026-01-01', room_revenue: 200, rooms_sold: 2 },
  ];
  eq('capacityRoomNights = 50, not 150', hotel.capacityRoomNights(rows, PROPS), 50);

  const s = hotel.occupancyStats(rows, PROPS);
  eq('occupancyStats capacity = 50', s.capacity, 50);
  eq('occupancyStats days = 1 distinct date, not 3 rows', s.days, 1);
  ok('occupancy = 17/50 = 34%', near(s.occupancy, 17 / 50), String(s.occupancy));
  ok('revpar = 1700/50 = $34', near(s.revpar, 1700 / 50), String(s.revpar));
  // ADR divides by rooms SOLD, not capacity, so it was never affected. Asserted so
  // a future "fix" cannot quietly change it.
  ok('adr = 1700/17 = $100 (unchanged by this fix)', near(s.adr, 100), String(s.adr));

  const ps = hotel.portfolioStats(rows, ROOM_MAP);
  eq('portfolioStats capacity = 50', ps.capacity, 50);
  ok('portfolioStats occupancy = 34%', near(ps.occupancy, 0.34), String(ps.occupancy));

  const per = hotel.perPropertyStats(rows, PROPS);
  eq('perPropertyStats reports 1 day', per[0].days, 1);
  ok('perPropertyStats occupancy = 34%', near(per[0].occupancy, 0.34), String(per[0].occupancy));
}

// ── 2. The full-month measurement from the bug report ───────────────────────
section('2. A 30-day month with two sections per date');
{
  const rows = [];
  for (let d = 1; d <= 30; d++) {
    const date = `2026-01-${String(d).padStart(2, '0')}`;
    rows.push({ property_id: 'A', date, room_revenue: 3000, rooms_sold: 30 });
    rows.push({ property_id: 'A', date, room_revenue: 500, rooms_sold: 5 });
  }
  const s = hotel.occupancyStats(rows, PROPS);
  eq('60 rows over 30 dates -> capacity 1500, not 3000', s.capacity, 1500);
  eq('days = 30, not 60', s.days, 30);
  ok('occupancy = 70.0%, not 35.0%', near(s.occupancy, 1050 / 1500), `${(s.occupancy * 100).toFixed(1)}%`);
  ok('revpar = $70.00, not $35.00', near(s.revpar, 70), `$${s.revpar.toFixed(2)}`);
  // The assertion that makes this non-vacuous: the WRONG answer is a clean 2x, so
  // a regression cannot hide inside rounding.
  ok('the old per-row answer (3000) is genuinely different', s.capacity !== 3000);
}

// ── 3. Explicit total_rooms: summed within a day, fallback only when absent ──
section('3. Explicit inventory is summed within a date; fallback is per-day');
{
  // Two sections that each state HALF the inventory: they must add to 50, matching
  // what dailyAggregates.js:177 stores as occ_capacity_rooms.
  const split = [
    { property_id: 'A', date: '2026-01-01', total_rooms: 30, room_revenue: 1000, rooms_sold: 10 },
    { property_id: 'A', date: '2026-01-01', total_rooms: 20, room_revenue: 500, rooms_sold: 5 },
  ];
  eq('explicit values SUM within a date (30+20=50)', hotel.capacityRoomNights(split, PROPS), 50);

  // A renovation day: inventory genuinely differs from the property default, and
  // the stated figure must win over the fallback.
  const renovation = [
    { property_id: 'A', date: '2026-01-01', total_rooms: 40, room_revenue: 1000, rooms_sold: 10 },
    { property_id: 'A', date: '2026-01-02', room_revenue: 1000, rooms_sold: 10 },
  ];
  eq('stated 40 for day 1 + fallback 50 for day 2 = 90',
    hotel.capacityRoomNights(renovation, PROPS), 90);

  // A mixed day: one section states inventory, another does not. The stated figure
  // is used and the fallback is NOT added on top, or a partially-populated export
  // would inflate capacity again.
  const mixed = [
    { property_id: 'A', date: '2026-01-01', total_rooms: 50, room_revenue: 1000, rooms_sold: 10 },
    { property_id: 'A', date: '2026-01-01', room_revenue: 500, rooms_sold: 5 },
  ];
  eq('a stated figure suppresses the fallback for that date',
    hotel.capacityRoomNights(mixed, PROPS), 50);
}

// ── 4. The two implementations must agree (split-brain guard) ───────────────
section('4. hotel.js and calculationService.js agree on the same rows');
{
  // The scenarios below are chosen to include every shape that used to diverge.
  const scenarios = [
    ['one date, three sections', [
      { property_id: 'A', date: '2026-01-01', room_revenue: 1000, rooms_sold: 10 },
      { property_id: 'A', date: '2026-01-01', room_revenue: 500, rooms_sold: 5 },
      { property_id: 'A', date: '2026-01-01', room_revenue: 200, rooms_sold: 2 },
    ]],
    ['two dates, one section each', [
      { property_id: 'A', date: '2026-01-01', room_revenue: 1000, rooms_sold: 10 },
      { property_id: 'A', date: '2026-01-02', room_revenue: 1200, rooms_sold: 12 },
    ]],
    ['explicit inventory split across sections', [
      { property_id: 'A', date: '2026-01-01', total_rooms: 30, room_revenue: 1000, rooms_sold: 10 },
      { property_id: 'A', date: '2026-01-01', total_rooms: 20, room_revenue: 500, rooms_sold: 5 },
    ]],
    ['a renovation day at reduced inventory', [
      { property_id: 'A', date: '2026-01-01', total_rooms: 40, room_revenue: 1000, rooms_sold: 10 },
      { property_id: 'A', date: '2026-01-02', room_revenue: 1000, rooms_sold: 10 },
    ]],
    ['a row with no date at all', [
      { property_id: 'A', room_revenue: 1000, rooms_sold: 10 },
      { property_id: 'A', date: '2026-01-01', room_revenue: 500, rooms_sold: 5 },
    ]],
    ['an empty row set', []],
  ];

  for (const [name, rows] of scenarios) {
    const mine = hotel.occupancyStats(rows, PROPS);
    const theirs = CalculationService.calculateOccupancyMetrics(rows, ROOM_MAP);
    ok(`${name}: capacity agrees`, near(mine.capacity, theirs.capacity),
      `hotel=${mine.capacity} calcService=${theirs.capacity}`);
    ok(`${name}: occupancy agrees`, near(mine.occupancy, theirs.occupancy, 0.0002),
      `hotel=${mine.occupancy} calcService=${theirs.occupancy}`);
    ok(`${name}: revpar agrees`, near(mine.revpar, theirs.revpar, 0.02),
      `hotel=${mine.revpar} calcService=${theirs.revpar}`);
    ok(`${name}: adr agrees`, near(mine.adr, theirs.adr, 0.02),
      `hotel=${mine.adr} calcService=${theirs.adr}`);

    // Per-property, both copies.
    const perMine = hotel.perPropertyStats(rows, PROPS);
    const perTheirs = CalculationService.calculatePerPropertyStats(rows, PROPS);
    ok(`${name}: per-property row count agrees`, perMine.length === perTheirs.length,
      `hotel=${perMine.length} calcService=${perTheirs.length}`);
    perMine.forEach((row) => {
      const other = perTheirs.find((p) => p.property_id === row.property_id);
      ok(`${name}: ${row.property_id} per-property occupancy agrees`,
        !!other && near(row.occupancy, other.occupancy, 0.0002),
        `hotel=${row.occupancy} calcService=${other?.occupancy}`);
      ok(`${name}: ${row.property_id} per-property days agrees`,
        !!other && row.days === other.days,
        `hotel=${row.days} calcService=${other?.days}`);
    });
  }
}

// ── 5. Multi-property portfolios stay weighted ──────────────────────────────
section('5. Portfolio totals weight by capacity, never average percentages');
{
  // A deliberately lopsided pair: averaging the two occupancy percentages gives a
  // different answer from the correct capacity-weighted fold, so this fixture can
  // tell the two apart.
  const rows = [
    // A: 50 rooms, 1 day, 45 sold -> 90%
    { property_id: 'A', date: '2026-01-01', room_revenue: 4500, rooms_sold: 45 },
    // B: 100 rooms, 1 day, 10 sold -> 10%
    { property_id: 'B', date: '2026-01-01', room_revenue: 1000, rooms_sold: 10 },
  ];
  const ps = hotel.portfolioStats(rows, ROOM_MAP);
  eq('capacity = 50 + 100', ps.capacity, 150);
  const weighted = 55 / 150; // 36.67%
  const naiveAverage = (0.9 + 0.1) / 2; // 50% — the wrong answer
  ok('occupancy is capacity-weighted (36.7%)', near(ps.occupancy, weighted, 0.0002),
    `${(ps.occupancy * 100).toFixed(1)}%`);
  ok('occupancy is NOT the average of the two percentages (50%)',
    !near(ps.occupancy, naiveAverage, 0.0002),
    'averaging property percentages is the classic error this function exists to avoid');

  // And duplicated sections on a multi-property portfolio still behave.
  const dup = [...rows, { property_id: 'B', date: '2026-01-01', room_revenue: 500, rooms_sold: 5 }];
  eq('a duplicate section for B does not add a second day of B', hotel.portfolioStats(dup, ROOM_MAP).capacity, 150);
}

// ── 6. Degenerate input does not divide by zero ─────────────────────────────
section('6. Empty and malformed input');
{
  const empty = hotel.occupancyStats([], PROPS);
  eq('empty: capacity 0', empty.capacity, 0);
  eq('empty: occupancy 0 (not NaN or Infinity)', empty.occupancy, 0);
  eq('empty: revpar 0', empty.revpar, 0);
  eq('empty: days 0', empty.days, 0);
  eq('null rows are tolerated', hotel.capacityRoomNights(null, PROPS), 0);
  // A property the room map has never heard of falls back to the default
  // inventory, once for its single date rather than once per row.
  const unknown = [
    { property_id: 'ZZZ', date: '2026-01-01', room_revenue: 100, rooms_sold: 1 },
    { property_id: 'ZZZ', date: '2026-01-01', room_revenue: 100, rooms_sold: 1 },
  ];
  eq('an unknown property uses the default inventory once per date',
    hotel.capacityRoomNights(unknown, PROPS), hotel.PROPERTY.rooms);
}

console.log(`\n─── RESULT: ${pass} passed, ${fail} failed ───`);
if (fail > 0) {
  console.log(`Failures:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('PASSED: capacity is per-day, and both implementations agree.');
process.exit(0);
