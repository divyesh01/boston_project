// Transaction ledger normalization — the single definition of what a PMS
// transaction row is once it enters this app.
//
// SHAPE OF THE SOURCE FILE (HotelKey "All Transactions" export)
// The export stacks five sections in one CSV:
//   section 1 — 19 columns, the guest transaction grid
//   sections 2-4 — Group / House Account / Company Code grids, always 0 rows
//   section 5 — 34 columns, THE SAME transactions plus 15 extra columns
// Sections 1 and 5 have identical row counts and identical amount sums, so
// ingesting both would double every revenue figure. We take section 5 because
// it is a strict superset (adds First/Last Name, Group, House Account, Refund
// Reason, Quantity, Adults) — per "unknown data is not silently deleted".
//
// Each section ends with a trailer row that has no date and carries the section
// total. It is a checksum, not a transaction: never ingest it, always verify
// against it.
//
// MEANING OF THE COLUMNS (verified against the Hotel Statistics export)
// The PMS reports folio-balance direction, not P&L sign. A row whose
// Transaction Type is CHARGE raises the folio balance — that is revenue.
// A row whose Transaction Type is REFUND LOWERS the folio balance — in this
// data every one of those rows is a PAYMENT or SETTLEMENT (FPCC/card, CASH,
// WIRE, LDB/direct bill), all positive, all with an empty charge category.
// Summing both sides double-counts revenue: across the three 2026 files
// sum(all rows) is $1,338,080.48, 31.1% above the true revenue figure of
// $1,020,598.17, which matches the Hotel Statistics file's revenue total to
// the cent. Revenue KPIs therefore use the CHARGE side only; payment KPIs use
// the REFUND side. This table stores the ledger side explicitly and stores
// amounts with the sign the PMS emitted, so a future reader cannot re-derive
// this incorrectly.
import { convertDate, parseAmount } from "@/lib/csvParser";

// Ledger sides — the two roles a row can play, expressed in P&L terms.
export const LEDGER_SIDE_CHARGE = "charge";       // revenue (raises folio balance)
export const LEDGER_SIDE_PAYMENT = "payment";     // settlement/refund (lowers it)

// Header -> canonical field. Names are identical in the 19- and 34-column
// sections, so one map serves both.
export const TXN_COLUMN_MAP = {
  "Date": "date",
  "Time": "time",
  "Confirmation Number": "confirmation_number",
  "Guest Name": "guest_name",
  "First Name": "guest_first_name",
  "Last Name": "guest_last_name",
  "Room Number": "room_number",
  "Folio Number": "folio_number",
  "Transaction Code": "transaction_code",
  "Transaction Description": "transaction_description",
  "Last 4 Digits": "card_last4",
  "Transaction Type": "transaction_type",
  "Charge Type Category": "charge_category",
  "Sub Charge Type name": "sub_charge_type",
  "Outlet Name": "outlet_name",
  "Amount": "amount",
  "Username": "username",
  "Remarks": "remarks",
  "POS Check Number": "pos_check_number",
  "Tax Invoice Number": "tax_invoice_number",
  "Company Name": "company_name",
  "Group Code": "group_code",
  "Group Number": "group_number",
  "Group Name": "group_name",
  "House Account Code": "house_account_code",
  "House Account Name": "house_account_name",
  "Account Type": "account_type",
  "Charge Remarks": "charge_remarks",
  "Transferred Transactions": "transferred_transactions",
  "Fiscal Invoice Number": "fiscal_invoice_number",
  "Reference External Bill Number": "reference_external_bill_number",
  "Refund Reason": "refund_reason",
  "Quantity": "quantity",
  "Adults": "adults",
};

// Header signature used to recognise this report among all others.
export const TXN_SIGNATURE = [
  "transaction code",
  "transaction type",
  "folio number",
  "amount",
];

// Transaction codes whose description is the payment instrument: code -> method.
export const PAYMENT_METHOD_BY_CODE = {
  FPCC: "Card",
  CASH: "Cash",
  WIRE: "Wire transfer",
  LDB: "Direct bill",
};

// ---------------------------------------------------------------------------
// Account classification
//
// `Username` is the only employee dimension in the file, but the 95 distinct
// values are not all people. Mixing them makes "compare two employees"
// meaningless — the two biggest "employees" are unattended integrations.
// Classes:
//   system    — PMS/channel automation (hkcrsuser, hkiotuser). Real revenue,
//               but no human wrote it. Excluded from staff comparison by
//               default; NEVER excluded from revenue totals.
//   staff     — on-property users (hotel domains / personal mail)
//   agency    — outsourced contact-centre agents (BPO domain)
//   brand     — corporate/franchise users
// Everything else falls back to `staff` so a new human is never hidden.
// ---------------------------------------------------------------------------
const SYSTEM_USERNAMES = new Set(["hkcrsuser", "hkiotuser"]);
const AGENCY_DOMAINS = ["corp.ibexglobal.com"];
const BRAND_DOMAINS = ["redroof.com"];

export const ACCOUNT_CLASSES = {
  staff: { key: "staff", label: "On-property staff" },
  agency: { key: "agency", label: "Contact-centre agent" },
  brand: { key: "brand", label: "Brand / corporate" },
  system: { key: "system", label: "System / automation" },
};

export function classifyAccount(username) {
  const u = String(username || "").trim().toLowerCase();
  if (!u) return "system";
  if (SYSTEM_USERNAMES.has(u)) return "system";
  // A username with no domain at all is a service account, not a person.
  if (!u.includes("@")) return "system";
  const domain = u.split("@")[1] || "";
  if (AGENCY_DOMAINS.some((d) => domain.endsWith(d))) return "agency";
  if (BRAND_DOMAINS.some((d) => domain.endsWith(d))) return "brand";
  return "staff";
}

export function isHumanAccount(username) {
  return classifyAccount(username) !== "system";
}

// Readable label for a username: "sanaullah.shoaib86@gmail.com" -> "Sanaullah Shoaib86".
export function displayEmployee(username) {
  const u = String(username || "").trim();
  if (!u) return "Unknown";
  if (!u.includes("@")) return u;
  const local = u.split("@")[0];
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ") || u;
}

// ---------------------------------------------------------------------------
// Natural key
//
// Byte-identical rows in this export are REAL, not import artifacts: a single
// posting action against a multi-night stay writes one line per night, all with
// the same timestamp. Across the three supplied files that is 739 such rows,
// and they skew negative — deduping them would have OVERSTATED revenue by
// $6,943.82 and broken agreement with the file's own trailer total.
//
// So the key includes an occurrence index: the Nth identical row is a distinct
// record. That keeps every legitimate row while still making a re-import of the
// same file idempotent, because the same file replays the same occurrences in
// the same order.
// ---------------------------------------------------------------------------
export function transactionDedupeKey(row, occurrence = 0) {
  return [
    row.property_id ?? "",
    row.date ?? "",
    row.time ?? "",
    row.folio_number ?? "",
    row.transaction_code ?? "",
    row.amount ?? 0,
    occurrence,
  ].join("|");
}

// Assigns occurrence indexes across a batch, then stamps each row's key.
export function assignDedupeKeys(rows) {
  const seen = new Map();
  return rows.map((row) => {
    const base = transactionDedupeKey(row, 0);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...row, dedupe_key: transactionDedupeKey(row, n) };
  });
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------
const NUMERIC_FIELDS = new Set(["amount", "quantity", "adults"]);

// A trailer row carries a total but no date — that is how we tell it from data.
export function isTrailerRow(mapped) {
  return !mapped.date && mapped.amount != null;
}

export function mapTransactionRow(headers, cells) {
  const out = {};
  headers.forEach((h, i) => {
    const field = TXN_COLUMN_MAP[String(h || "").trim()];
    if (!field) return;                       // unmapped column: ignored, not fatal
    const raw = cells[i] == null ? "" : String(cells[i]).trim();
    if (NUMERIC_FIELDS.has(field)) {
      out[field] = parseAmount(raw);
    } else if (field === "date") {
      out[field] = raw ? convertDate(raw) : "";
    } else {
      out[field] = raw;
    }
  });
  if (out.amount == null) out.amount = 0;
  out.account_class = classifyAccount(out.username);
  out.employee_label = displayEmployee(out.username);

  // Derive the ledger side from the type as emitted by the PMS.
  const type = String(out.transaction_type || "").toUpperCase();
  out.ledger_side = type === "REFUND" ? LEDGER_SIDE_PAYMENT : LEDGER_SIDE_CHARGE;
  out.payment_method = PAYMENT_METHOD_BY_CODE[String(out.transaction_code || "").toUpperCase()] || "";
  return out;
}
