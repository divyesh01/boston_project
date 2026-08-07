import localDb from "@/api/localDb";

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const MONTH_SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEK_ORDINALS = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4 };
const STOPWORDS = new Set(["the", "and", "for", "inn", "hotel", "suites", "property", "at", "on", "red", "roof", "of", "vs", "to", "in", "a", "an"]);

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function money(v, digits = 0) {
  const n = Number(v) || 0;
  return `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
function signedMoney(v, digits = 0) {
  const n = Number(v) || 0;
  return `${n >= 0 ? "+" : "-"}${money(Math.abs(n), digits)}`;
}
function pct(v, digits = 1) {
  return `${(Number(v || 0) * 100).toFixed(digits)}%`;
}
function num(v) {
  return Number(v || 0).toLocaleString("en-US");
}
function sum(rows, key) {
  return rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);
}

function monthIndex(token) {
  const t = String(token || "").toLowerCase().replace(/[^a-z]/g, "");
  let i = MONTH_NAMES.indexOf(t);
  if (i >= 0) return i;
  i = MONTH_SHORT.indexOf(t.slice(0, 3));
  return i;
}

function parseDate(s) {
  if (!s) return null;
  s = String(s).trim();
  const isoM = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoM) return `${isoM[1]}-${pad(+isoM[2])}-${pad(+isoM[3])}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    const y = us[3].length === 2 ? "20" + us[3] : us[3];
    return `${y}-${pad(+us[1])}-${pad(+us[2])}`;
  }
  const named = s.match(/^([a-zA-Z]{3,})\s+(\d{1,2})(?:st|nd|rd|th)?,\s+(\d{4})$/i);
  if (named) {
    const m = monthIndex(named[1]);
    if (m >= 0) return `${named[3]}-${pad(m + 1)}-${pad(+named[2])}`;
  }
  return null;
}

function findMonthTokens(question) {
  const tokens = String(question).toLowerCase().match(/[a-z]+/g) || [];
  const out = [];
  for (const tok of tokens) {
    if (tok.length < 3) continue;
    const idx = monthIndex(tok);
    if (idx >= 0 && !out.some((o) => o.idx === idx)) out.push({ idx, token: tok });
  }
  return out;
}

function lastDayOfMonth(year, m) {
  return new Date(year, m + 1, 0).getDate();
}

function monthRange(year, m, latest) {
  const from = `${year}-${pad(m + 1)}-01`;
  let to = `${year}-${pad(m + 1)}-${pad(lastDayOfMonth(year, m))}`;
  const now = new Date();
  if (year >= now.getFullYear() && m >= now.getMonth() && latest && latest < to) to = latest;
  return { from, to, single: false };
}

function dateToWeekRange(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const day = d.getDay();
  const start = new Date(d);
  start.setDate(d.getDate() - day);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { from: iso(start), to: iso(end) };
}

const MONTH_RE = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;
const CODE_RE = /\b([a-z]{1,4}\d{3,5})\b/i;
const ORDINAL_WEEK_RE = /\b(first|1st|second|2nd|third|3rd|fourth|4th)\s+week\s+of\s+([a-z]+)(?:\s*,?\s*(\d{4}))?\b/i;

function resolveRange(question, defaults = {}) {
  const q = String(question);
  const now = new Date();
  const curYear = new Date().getFullYear();
  const latest = defaults.latestDate || "";

  const custom = q.match(/\b(?:between|from)\s+([^,\n]+?)\s+(?:and|to)\s+(.+?)\s*(?:[.,]|$|\?)/i);
  if (custom) {
    const a = parseDate(custom[1]);
    const b = parseDate(custom[2]);
    if (a && b) {
      const [from, to] = a < b ? [a, b] : [b, a];
      return { from, to, single: false, label: `${from} → ${to}`, specified: true };
    }
  }

  const dateMatch = parseDate(q);
  if (dateMatch && (/\bon\b|\bshow\b|\bshow\b.*\d|date/i.test(q))) {
    return { from: dateMatch, to: dateMatch, single: true, label: dateMatch, specified: true };
  }

  if (/\byesterday\b/i.test(q)) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return { from: iso(d), to: iso(d), single: true, label: iso(d), specified: true };
  }
  if (/\b(?:today|tonight|this\s+day)\b/i.test(q)) {
    const f = latest || iso(now);
    return { from: f, to: f, single: true, label: f, specified: true };
  }

  const ordWeek = q.match(ORDINAL_WEEK_RE);
  if (ordWeek) {
    const n = WEEK_ORDINALS[ordWeek[1].toLowerCase()];
    const m = monthIndex(ordWeek[2]);
    const y = ordWeek[3] ? +ordWeek[3] : curYear;
    if (m >= 0) {
      const from = `${y}-${pad(m + 1)}-${pad((n - 1) * 7 + 1)}`;
      const maxDay = lastDayOfMonth(y, m);
      const to = `${y}-${pad(m + 1)}-${pad(Math.min(n * 7, maxDay))}`;
      return { from, to, single: false, label: `${WEEK_ORDINALS[n] || n} week of ${MONTH_LONG[m]} ${y}`, specified: true };
    }
  }

  if (/\bthis\s+week\b/i.test(q)) {
    const f = latest || iso(now);
    return { ...dateToWeekRange(f), single: false, label: "This week", specified: true };
  }
  if (/\blast\s+week\b/i.test(q)) {
    const f = latest || iso(now);
    const prev = new Date(`${f}T00:00:00`);
    prev.setDate(prev.getDate() - 7);
    return { ...dateToWeekRange(iso(prev)), single: false, label: "Last week", specified: true };
  }

  if (/\b(?:next|coming|upcoming)\s+(?:week|7\s*days)\b/i.test(q)) {
    const f = latest || iso(now);
    const d = new Date(`${f}T00:00:00`);
    d.setDate(d.getDate() + 1);
    return { from: iso(d), to: iso(d).slice(0, 8) + pad(Math.min(31, d.getDate() + 6)), single: false, label: "Next week", specified: true };
  }

  if (/\b(?:this|current)\s+month\b/i.test(q)) {
    const m = now.getMonth();
    return { ...monthRange(curYear, m, latest), label: `This month (${MONTH_LONG[m]})`, specified: true };
  }
  if (/\blast\s+month\b/i.test(q)) {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return { ...monthRange(d.getFullYear(), d.getMonth(), latest), label: `Last month (${MONTH_LONG[d.getMonth()]})`, specified: true };
  }

  if (/\b(?:this|current)\s+year\b/i.test(q)) {
    return { from: `${curYear}-01-01`, to: latest || iso(now), single: false, label: `This year (${curYear})`, specified: true };
  }
  if (/\blast\s+year\b/i.test(q)) {
    return { from: `${curYear - 1}-01-01`, to: `${curYear - 1}-12-31`, single: false, label: `Last year (${curYear - 1})`, specified: true };
  }

  const qtr = q.match(/\b(q|quarter)\s*([1-4])\b/i) || q.match(/\b([1-4])(?:st|nd|rd|th)?\s+quarter\b/i);
  if (qtr) {
    const qn = +(qtr[2] || qtr[1]);
    const yMatch = q.match(/\b(20\d{2})\b/);
    const y = yMatch ? +yMatch[1] : curYear;
    const fromM = (qn - 1) * 3;
    return { from: `${y}-${pad(fromM + 1)}-01`, to: `${y}-${pad(fromM + 3)}-${pad(lastDayOfMonth(y, fromM + 2))}`, single: false, label: `Q${qn} ${y}`, specified: true };
  }

  if (/\bytd|\byear-to-date\b/i.test(q)) {
    const yMatch = q.match(/\b(20\d{2})\b/);
    const y = yMatch ? +yMatch[1] : curYear;
    return { from: `${y}-01-01`, to: latest || iso(now), single: false, label: `Year to date (${y})`, specified: true };
  }

  const yearMatch = q.match(/\b(20\d{2})\b/);
  if (yearMatch) {
    const y = +yearMatch[1];
    return { from: `${y}-01-01`, to: `${y}-12-31`, single: false, label: String(y), specified: true };
  }

  const months = findMonthTokens(q);
  if (months.length > 0) {
    const yMatch = q.match(/\b(20\d{2})\b/);
    const y = yMatch ? +yMatch[1] : (/(\b|^)last\b/i.test(q) ? curYear - 1 : curYear);
    const res = months.map(({ idx }) => monthRange(y, idx, latest));
    if (res.length === 1) {
      return { ...res[0], label: `${MONTH_LONG[months[0].idx]} ${y}`, specified: true };
    }
    return { from: res[0].from, to: res[res.length - 1].to, single: false, label: `${months.map(({ idx }) => `${MONTH_LONG[idx]} ${y}`).join(" + ")}`, specified: true };
  }

  if (defaults.from && defaults.to) {
    return { from: defaults.from, to: defaults.to, single: defaults.from === defaults.to, label: `${defaults.from} → ${defaults.to}`, specified: false };
  }
  return { from: "", to: "", single: false, label: "All imported data", specified: false };
}

function propertyTokens(p) {
  const words = String(p.name || "").toLowerCase().split(/[\s\-&,.'()]+/).filter(Boolean);
  const code = String(p.code || "").toLowerCase();
  return { words, code, long: String(p.name || "").toLowerCase() };
}

async function resolveProperty(question, defaultFilter) {
  const props = await localDb.Property.toArray();
  const q = String(question).toLowerCase();

  if (/\b(all properties|all\b.*portfolio|portfolio|everywhere)\b/i.test(q) && /all/i.test(q)) {
    return { ids: null, label: "All Properties", isAll: true };
  }
  if (/\ball\b/i.test(q)) {
    return { ids: null, label: "All Properties", isAll: true };
  }

  const codeMatch = q.match(CODE_RE);
  if (codeMatch) {
    const target = codeMatch[1].toUpperCase();
    const hit = props.find((p) => String(p.code || "").toUpperCase() === target);
    if (hit) return { ids: new Set([String(hit.id)]), label: hit.name, isAll: false, code: hit.code };
  }

  let best = null;
  let bestLen = 0;
  for (const p of props) {
    const { words, long } = propertyTokens(p);
    const meaningful = words.filter((w) => w.length >= 4 && !STOPWORDS.has(w));
    for (const w of meaningful) {
      if (q.includes(w) && w.length > bestLen) {
        best = p;
        bestLen = w.length;
      }
    }
    if (bestLen === 0 && long && q.includes(long)) {
      best = p;
      bestLen = long.length;
    }
  }
  if (best) return { ids: new Set([String(best.id)]), label: best.name, isAll: false, code: best.code };

  if (defaultFilter && defaultFilter !== "all") {
    const ids = Array.isArray(defaultFilter) ? defaultFilter : [defaultFilter];
    const picked = props.filter((p) => ids.includes(String(p.id)));
    return { ids: new Set(ids.map(String)), label: picked.length ? picked.map((p) => p.name).join(" + ") : `${ids.length} selected`, isAll: false };
  }
  return { ids: null, label: "All Properties", isAll: true };
}

async function load(table, prop, from, to, dateField = "date") {
  const all = await localDb[table].toArray();
  return all.filter((r) => {
    if (prop.ids && !prop.ids.has(String(r.property_id || ""))) return false;
    const d = String(r[dateField] || r.date || "").slice(0, 10);
    if (!d) return true;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}

async function latestDate() {
  const rows = await localDb.OccupancyDay.toArray();
  let max = "";
  rows.forEach((r) => {
    const d = String(r.date || "").slice(0, 10);
    if (d > max) max = d;
  });
  return max;
}

function occTotals(rows) {
  const revenue = sum(rows, "total_revenue");
  const roomsSold = sum(rows, "rooms_sold");
  const capacity = sum(rows, "total_rooms") || 0;
  const vacant = sum(rows, "vacant_rooms");
  const uniqueDays = new Set(rows.map((r) => String(r.date || "").slice(0, 10))).size;
  const occupancy = capacity ? roomsSold / capacity : 0;
  const adr = roomsSold ? revenue / roomsSold : 0;
  const revpar = capacity ? revenue / capacity : 0;
  return {
    revenue,
    roomsSold,
    capacity: capacity || uniqueDays * 100,
    vacant: vacant || (capacity ? capacity - roomsSold : 0),
    occupancy,
    adr,
    revpar,
    days: uniqueDays,
    rows,
  };
}

function payTotals(rows) {
  const tenderFields = [
    "cash", "check", "amex", "master", "visa", "discover", "direct_bill",
    "corpay", "wire_transfer", "loyalty_certificate", "vip_pass", "other",
  ];
  let payments = 0;
  rows.forEach((r) => {
    for (const f of tenderFields) payments += Number(r[f]) || 0;
  });
  const refunds = Math.abs(sum(rows, "closed_balance_folio")) + Math.abs(sum(rows, "loyalty_discount"));
  const net = sum(rows, "total");
  const breakdown = tenderFields
    .map((f) => ({ field: f, value: sum(rows, f) }))
    .filter((x) => Math.abs(x.value) > 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return { payments: payments || net, refunds, breakdown };
}

function channelTotals(rows) {
  const map = new Map();
  rows.forEach((r) => {
    const key = r.source || r.code || "UNKNOWN";
    const cur = map.get(key) || { name: key, gross: 0, stays: 0 };
    cur.gross += Number(r.net_revenue) || 0;
    cur.stays += Number(r.stays) || 0;
    map.set(key, cur);
  });
  return [...map.values()].filter((c) => c.gross > 0 || c.stays > 0).sort((a, b) => b.gross - a.gross);
}

function costTotals(expenses, payroll) {
  const payrollTotal = sum(payroll, "total_pay");
  const operating = expenses.filter((e) => e.category !== "payroll").reduce((a, e) => a + (Number(e.amount) || 0), 0);
  return { payrollTotal, operating, total: payrollTotal + operating };
}

function clerkVariance(records) {
  const drops = records.filter((r) => r.record_type === "drop");
  const clerkPay = records.filter((r) => r.record_type === "clerk_payment");
  const byClerk = new Map();
  drops.forEach((d) => {
    const k = d.clerk_name || "Unknown";
    const cur = byClerk.get(k) || { clerk: k, drops: 0, count: 0, expected: 0 };
    cur.drops += Number(d.amount) || 0;
    cur.count += 1;
    byClerk.set(k, cur);
  });
  clerkPay.forEach((r) => {
    if ((r.payment_type || "").toUpperCase() === "CASH") {
      const k = r.clerk_name || "Unknown";
      if (!byClerk.has(k)) byClerk.set(k, { clerk: k, drops: 0, count: 0, expected: 0 });
      byClerk.get(k).expected += Number(r.amount) || 0;
    }
  });
  const all = [...byClerk.values()].map((c) => ({ ...c, variance: c.expected - c.drops }));
  all.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
  return all;
}

function buildAlerts(occRows, occThreshold = 0.6) {
  const low = occRows
    .filter((r) => (Number(r.occupancy) || 0) < occThreshold)
    .sort((a, b) => (Number(a.occupancy) || 0) - (Number(b.occupancy) || 0))
    .slice(0, 3);
  return low.map((r) => ({
    date: String(r.date || "").slice(0, 10),
    occ: Number(r.occupancy) || 0,
    prop: r.property_name || r.property_id || "",
  }));
}

function fmtRange(range) {
  return range.label || `${range.from || "—"} → ${range.to || "—"}`;
}

function summarySection(range, occ, pay, channels, expenses, payroll, propLabel) {
  const costs = costTotals(expenses, payroll);
  const netRevenue = occ.revenue - pay.refunds;
  const profit = netRevenue - costs.total;
  const lines = [];
  const isSingle = range.single;
  const scope = `${propLabel} · ${fmtRange(range)}${occ.days ? ` · ${occ.days} day${occ.days === 1 ? "" : "s"}` : ""}`;
  lines.push(`**${propLabel}** — ${fmtRange(range)}`);
  lines.push(`- **Revenue:** ${money(occ.revenue)}${isSingle ? "" : ` (${money(occ.revenue / (occ.days || 1))}/day)`}`);
  lines.push(`- **Occupancy:** ${pct(occ.occupancy)} (${num(occ.roomsSold)} rooms sold of ${num(occ.capacity)})`);
  lines.push(`- **Vacant rooms:** ${num(occ.vacant)}`);
  lines.push(`- **ADR:** ${money(occ.adr, 2)} · **RevPAR:** ${money(occ.revpar, 2)}`);
  lines.push(`- **Payments:** ${money(pay.payments)} · **Refunds:** -${money(pay.refunds)}`);
  lines.push(`- **Expenses:** ${money(costs.total)} (payroll ${money(costs.payrollTotal)} + operating ${money(costs.operating)})`);
  lines.push(`- **Net profit:** ${signedMoney(profit)}`);
  if (channels.length) {
    const top3 = channels.slice(0, 3).map((c) => `${c.name} ${money(c.gross)}`).join(", ");
    lines.push(`- **Top channels:** ${top3}`);
  }
  return { lines, scope };
}

async function intentSummary({ prop, range }) {
  const occRows = await load("OccupancyDay", prop, range.from, range.to);
  if (!occRows.length) return { heading: "", lines: [], noData: "occupancy" };
  const occ = occTotals(occRows);
  const payRows = await load("PaymentDay", prop, range.from, range.to);
  const pay = payTotals(payRows);
  const srcRows = await load("SourceDay", prop, range.from, range.to);
  const channels = channelTotals(srcRows);
  const expenses = await load("Expense", prop, range.from, range.to, "expense_date");
  const payroll = await load("PayrollRun", prop, range.from, range.to, "pay_period_start");
  const alerts = buildAlerts(occRows);
  const s = summarySection(range, occ, pay, channels, expenses, payroll, prop.label);
  const lines = [...s.lines];
  if (alerts.length) {
    lines.push(`- **Alerts:** low occupancy on ${alerts.map((a) => `${a.date} (${pct(a.occ)})`).join(", ")}`);
  }
  return { heading: "", lines, noData: null };
}

async function intentMetric({ prop, range, metric, question }) {
  const occRows = await load("OccupancyDay", prop, range.from, range.to);
  const occ = occRows.length ? occTotals(occRows) : null;
  const labels = {
    revenue: ["Revenue", () => (occ ? `${money(occ.revenue)}` : null)],
    occupancy: ["Occupancy", () => (occ ? pct(occ.occupancy) : null)],
    rooms: ["Rooms sold", () => (occ ? num(occ.roomsSold) : null)],
    vacant: ["Vacant rooms", () => (occ ? num(occ.vacant) : null)],
    adr: ["ADR", () => (occ ? money(occ.adr, 2) : null)],
    revpar: ["RevPAR", () => (occ ? money(occ.revpar, 2) : null)],
  };
  const [label, val] = labels[metric] || [];
  if (!val) return { heading: "", lines: [], noData: null };
  const v = val();
  if (v == null || occ == null) return { heading: "", lines: [], noData: "occupancy" };
  const out = [`**${label}** for **${prop.label}** — ${fmtRange(range)}: **${v}**`];
  if (range.single && metric === "revenue") out.push(`Based on ${occ.days} day of imported occupancy data.`);
  return { heading: "", lines: out, noData: null };
}

async function intentRooms({ prop, range }) {
  const occRows = await load("OccupancyDay", prop, range.from, range.to);
  if (!occRows.length) return { heading: "", lines: [], noData: "occupancy" };
  const occ = occTotals(occRows);
  return {
    heading: "",
    lines: [
      `**Rooms sold & vacant — ${prop.label} · ${fmtRange(range)}**`,
      `- Rooms sold: **${num(occ.roomsSold)}**`,
      `- Vacant rooms: **${num(occ.vacant)}**`,
      `- Total available: ${num(occ.capacity)}`,
    ],
    noData: null,
  };
}

async function intentExpenses({ prop, range }) {
  const expenses = await load("Expense", prop, range.from, range.to, "expense_date");
  const payroll = await load("PayrollRun", prop, range.from, range.to, "pay_period_start");
  const costs = costTotals(expenses, payroll);
  const byCat = new Map();
  expenses.forEach((e) => {
    const k = e.category || "other";
    byCat.set(k, (byCat.get(k) || 0) + (Number(e.amount) || 0));
  });
  const sorted = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const lines = [
    `**Expenses — ${prop.label} · ${fmtRange(range)}**`,
    `- Total expenses: **${money(costs.total)}**`,
    `- Payroll: ${money(costs.payrollTotal)} (${payroll.length} records)`,
    `- Operating expenses: ${money(costs.operating)} (${expenses.length} entries)`,
  ];
  if (sorted.length) lines.push(`- Top categories: ${sorted.map(([k, v]) => `${k} ${money(v)}`).join(", ")}`);
  return { heading: "", lines, noData: null };
}

async function intentProfit({ prop, range }) {
  const occRows = await load("OccupancyDay", prop, range.from, range.to);
  if (!occRows.length) return { heading: "", lines: [], noData: "occupancy" };
  const occ = occTotals(occRows);
  const payRows = await load("PaymentDay", prop, range.from, range.to);
  const pay = payTotals(payRows);
  const expenses = await load("Expense", prop, range.from, range.to, "expense_date");
  const payroll = await load("PayrollRun", prop, range.from, range.to, "pay_period_start");
  const costs = costTotals(expenses, payroll);
  const netRev = occ.revenue - pay.refunds;
  const profit = netRev - costs.total;
  const margin = netRev ? profit / netRev : 0;
  return {
    heading: "",
    lines: [
      `**Net profit — ${prop.label} · ${fmtRange(range)}**`,
      `- Net revenue: ${money(netRev)} (gross ${money(occ.revenue)} − refunds ${money(pay.refunds)})`,
      `- Total costs: ${money(costs.total)} (payroll ${money(costs.payrollTotal)} + operating ${money(costs.operating)})`,
      `- **Net profit: ${signedMoney(profit)}** (margin ${pct(margin)})`,
    ],
    noData: null,
  };
}

async function intentPayments({ prop, range }) {
  const rows = await load("PaymentDay", prop, range.from, range.to);
  if (!rows.length) return { heading: "", lines: [], noData: "payments" };
  const pay = payTotals(rows);
  const lines = [`**Payments & refunds — ${prop.label} · ${fmtRange(range)}**`];
  lines.push(`- Payments: **${money(pay.payments)}**`);
  lines.push(`- Refunds & adjustments: **-${money(pay.refunds)}**`);
  if (pay.breakdown.length) {
    lines.push(`- By method: ${pay.breakdown.map((b) => `${b.field.replace(/_/g, " ")} ${money(b.value)}`).join(", ")}`);
  }
  return { heading: "", lines, noData: null };
}

async function intentOta({ prop, range }) {
  const rows = await load("SourceDay", prop, range.from, range.to);
  const channels = channelTotals(rows);
  if (!channels.length) return { heading: "", lines: [], noData: "sources" };
  const total = channels.reduce((a, c) => a + c.gross, 0);
  const lines = [`**Channel revenue — ${prop.label} · ${fmtRange(range)}**`];
  channels.forEach((c, i) => {
    const share = total ? (c.gross / total) * 100 : 0;
    lines.push(`${i + 1}. ${c.name}: **${money(c.gross)}** (${c.stays} stays · ${share.toFixed(1)}%)`);
  });
  return { heading: "", lines, noData: null };
}

async function intentTopOta({ prop, range, question }) {
  const rows = await load("SourceDay", prop, range.from, range.to);
  const channels = channelTotals(rows);
  if (!channels.length) return { heading: "", lines: [], noData: "sources" };
  const top = channels[0];
  const total = channels.reduce((a, c) => a + c.gross, 0);
  return {
    heading: "",
    lines: [
      `**${top.name}** generated the most revenue at **${money(top.gross)}** (${top.stays} stays, ${total ? ((top.gross / total) * 100).toFixed(1) : 0}% of channel revenue) for **${prop.label}** — ${fmtRange(range)}.`,
    ],
    noData: null,
  };
}

async function intentClerk({ prop, range }) {
  const records = await load("ClerkShiftRecord", prop, range.from, range.to, "shift_date");
  const clerks = clerkVariance(records);
  if (!clerks.length) return { heading: "", lines: [], noData: "clerk" };
  const worst = clerks[0];
  const lines = [`**Clerk cash audit — ${prop.label} · ${fmtRange(range)}**`];
  lines.push(`- Largest variance: **${worst.clerk}** ${worst.variance >= 0 ? "short by" : "over by"} ${money(Math.abs(worst.variance), 2)} (expected ${money(worst.expected, 2)}, dropped ${money(worst.drops, 2)})`);
  if (clerks.length > 1) {
    lines.push(`- All clerks: ${clerks.slice(0, 5).map((c) => `${c.clerk} ${signedMoney(c.variance, 2)}`).join(" · ")}`);
  }
  return { heading: "", lines, noData: null };
}

async function intentForecast({ prop, range, question }) {
  const occRows = await load("OccupancyDay", prop, range.from, range.to);
  if (!occRows.length) return { heading: "", lines: [], noData: "occupancy" };
  const occ = occTotals(occRows);
  const days = occ.days || 1;
  const dailyRevenue = occ.revenue / days;
  const dailyRooms = occ.roomsSold / days;
  const horizon = /(week|7\s*days)/i.test(question) ? 7 : /quarter/i.test(question) ? 90 : 30;
  const projectedRevenue = dailyRevenue * horizon;
  const projectedRooms = Math.round(dailyRooms * horizon);
  const baseExpenses = dailyRevenue * horizon * 0.65;
  const net = projectedRevenue - baseExpenses;
  return {
    heading: "",
    lines: [
      `**Forecast (next ${horizon} days) — ${prop.label}**`,
      `- Projected rooms sold: **${num(projectedRooms)}**`,
      `- Projected revenue: **${money(projectedRevenue)}**`,
      `- Projected occupancy: ${pct(occ.occupancy)} · ADR: ${money(occ.adr, 2)}`,
      `- Projected expenses: ${money(baseExpenses)} · Net: ${signedMoney(net)}`,
      `- Based on ${days} days of historical data (${fmtRange(range)}). This is a projection — it does not overwrite imported data.`,
    ],
    noData: null,
  };
}

async function intentCompare({ prop, range, q, question }) {
  const monthTok = findMonthTokens(q);
  if (monthTok.length >= 2) {
    const yMatch = q.match(/\b(20\d{2})\b/);
    const y = yMatch ? +yMatch[1] : new Date().getFullYear();
    const ranges = monthTok.slice(0, 2).map(({ idx }) => monthRange(y, idx, await latestDate()));
    const aRows = await load("OccupancyDay", prop, ranges[0].from, ranges[0].to);
    const bRows = await load("OccupancyDay", prop, ranges[1].from, ranges[1].to);
    if (!aRows.length && !bRows.length) return { heading: "", lines: [], noData: "occupancy" };
    const a = aRows.length ? occTotals(aRows) : null;
    const b = bRows.length ? occTotals(bRows) : null;
    const aLabel = `${MONTH_LONG[monthTok[0].idx]} ${y}`;
    const bLabel = `${MONTH_LONG[monthTok[1].idx]} ${y}`;
    const row = (name, af, bf, delta) => {
      const av = a && af(a) != null ? af(a) : "—";
      const bv = b && bf(b) != null ? bf(b) : "—";
      let d = "";
      if (a && b && delta != null) d = ` · ${delta}`;
      return `- ${name}: ${av} vs ${bv}${d}`;
    };
    const pctChange = (x, y) => (y ? `${(((x - y) / y) * 100).toFixed(1)}%` : "");
    const lines = [
      `**Compare ${aLabel} vs ${bLabel} — ${prop.label}**`,
      row("Revenue", (o) => money(o.revenue), (o) => money(o.revenue), a && b ? pctChange(a.revenue, b.revenue) : ""),
      row("Rooms sold", (o) => num(o.roomsSold), (o) => num(o.roomsSold), a && b ? pctChange(a.roomsSold, b.roomsSold) : ""),
      row("Occupancy", (o) => pct(o.occupancy), (o) => pct(o.occupancy), a && b ? `${(((a.occupancy - b.occupancy) * 100)).toFixed(1)} pts` : ""),
      row("ADR", (o) => money(o.adr, 2), (o) => money(o.adr, 2), a && b ? pctChange(a.adr, b.adr) : ""),
      row("RevPAR", (o) => money(o.revpar, 2), (o) => money(o.revpar, 2), a && b ? pctChange(a.revpar, b.revpar) : ""),
    ];
    return { heading: "", lines, noData: null };
  }
  return null;
}

async function answerQuestion({ question, propertyId, from, to }) {
  const q = String(question || "").trim();
  if (!q) return { answer: "Please ask a question about your hotel data.", summary: null };

  const latest = await latestDate();
  const defaultFilter = propertyId && propertyId !== "all" ? propertyId : null;

  const prop = await resolveProperty(q, defaultFilter);
  const range = resolveRange(q, { from, to, latestDate: latest, year: new Date().getFullYear() });

  const ctx = { prop, range, q, question: q };

  let result = null;

  if (/\b(compare|versus|vs\.?|vs)\b/i.test(q)) {
    result = await intentCompare(ctx);
  }

  if (!result) {
    const has = (re) => re.test(q);
    if (has(/vacant|available/i)) result = await intentRooms(ctx);
    if (!result && has(/expense|spend|cost/i)) result = await intentExpenses(ctx);
    if (!result && has(/profit/i)) result = await intentProfit(ctx);
    if (!result && has(/payment|refund|paid|received|tender/i)) result = await intentPayments(ctx);
    if (!result && has(/clerk|variance|short|over|audit/i)) result = await intentClerk(ctx);
    if (!result && has(/forecast|project|predict|next\s+week|next\s+month/i)) result = await intentForecast(ctx);
    if (!result && has(/most|top|biggest|best|which\b.*(ota|channel)/i)) result = await intentTopOta(ctx);
    if (!result && has(/(^|\b)ota|channel|expedia|booking\.com|airbnb|direct/i)) result = await intentOta(ctx);
    if (!result && has(/adr\b/i)) result = await intentMetric({ prop, range, metric: "adr", question: q });
    if (!result && has(/revpar|rev\s*par/i)) result = await intentMetric({ prop, range, metric: "revpar", question: q });
    if (!result && has(/occupanc/i)) result = await intentMetric({ prop, range, metric: "occupancy", question: q });
    if (!result && has(/revenue|sold|gross|income|rooms\b/i)) result = await intentMetric({ prop, range, metric: "revenue", question: q });
  }

  if (!result) result = await intentSummary(ctx);

  if (result.noData) {
    const missing = {
      occupancy: "Occupancy report (Occupancy Summary)",
      payments: "Payments report (Payments Summary)",
      sources: "Source Summary report",
      clerk: "Clerk Shift & Cash Audit report",
      expenses: "Expense or Payroll records",
    }[result.noData];
    return {
      answer: `I couldn't find imported data to answer that.\n\nMissing: **${missing}** for ${prop.label} · ${fmtRange(range)}.\nImport the report from the **Upload** page, then ask again.`,
      summary: { intent: "missing", missing: result.noData, property: prop.label, range: range.label || `${range.from}→${range.to}` },
    };
  }

  let answer = (result.lines || []).filter(Boolean).join("\n");
  if (!answer) {
    answer = `I understand you're asking about **${prop.label}** for ${fmtRange(range)}.\n\nI can answer questions about revenue, occupancy, ADR, RevPAR, rooms sold, vacant rooms, expenses, net profit, payments, refunds, OTA/channel revenue, clerk audits, and forecasts. Try rephrasing your question.`;
  }

  return {
    answer,
    summary: {
      intent: "answer",
      property: prop.label,
      range: range.label || `${range.from}→${range.to}`,
      single: range.single,
    },
  };
}

export { answerQuestion, resolveRange, resolveProperty };
export default answerQuestion;
