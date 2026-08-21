// Shared expense category definitions used by the Expenses page, the Estimated
// Money Kept widget, forecasting, and any future expense-aware surfaces.
// Categories are stored as stable slug keys on the Expense entity; unknown or
// user-created (custom) categories are also supported and get a readable label.

export const EXPENSE_CATEGORIES = [
  { key: "payroll", label: "Payroll" },
  { key: "housekeeping", label: "Housekeeping" },
  { key: "breakfast_inventory", label: "Breakfast Inventory" },
  { key: "supplies", label: "Supplies" },
  { key: "maintenance", label: "Maintenance" },
  { key: "repairs", label: "Repairs" },
  { key: "utilities", label: "Utilities" },
  { key: "electric_bill", label: "Electric Bill" },
  { key: "water_bill", label: "Water Bill" },
  { key: "gas_bill", label: "Gas Bill" },
  { key: "internet", label: "Internet" },
  { key: "solar_payments", label: "Solar Panel Payments" },
  { key: "equipment", label: "Equipment Purchases" },
  { key: "insurance", label: "Insurance" },
  { key: "taxes", label: "Taxes" },
  { key: "state_taxes", label: "State Taxes" },
  { key: "city_taxes", label: "City Taxes" },
  { key: "marketing", label: "Marketing" },
  { key: "software", label: "Software" },
  { key: "ota_commission", label: "OTA Commissions" },
  { key: "credit_card_fees", label: "Credit Card Processing Fees" },
  { key: "loan_payments", label: "Loan Payments" },
  { key: "property_improvements", label: "Property Improvements" },
  { key: "furniture", label: "Furniture" },
  { key: "landscaping", label: "Landscaping" },
  { key: "pest_control", label: "Pest Control" },
  { key: "laundry", label: "Laundry" },
  { key: "rent", label: "Rent / Lease" },
  { key: "other", label: "Other Expenses" },
];

export const EXPENSE_FREQUENCIES = [
  { key: "one_time", label: "One-time" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "quarterly", label: "Quarterly" },
  { key: "yearly", label: "Yearly" },
];

export const EXPENSE_STATUSES = [
  { key: "unpaid", label: "Unpaid" },
  { key: "scheduled", label: "Scheduled" },
  { key: "paid", label: "Paid" },
  { key: "overdue", label: "Overdue" },
];

export const STANDARD_CATEGORY_KEYS = EXPENSE_CATEGORIES.map((c) => c.key);

export function isStandardCategory(cat) {
  return STANDARD_CATEGORY_KEYS.includes(cat);
}

// Turn a free-text category name into a stable slug key ("Electric Bill" -> "electric_bill")
export function slugifyCategory(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "other";
}

// Readable label for a stored category key; falls back to prettifying the slug
// so custom categories like "snow_removal" display as "Snow Removal".
export function expenseLabel(cat) {
  const key = String(cat || "other");
  const known = EXPENSE_CATEGORIES.find((c) => c.key === key);
  if (known) return known.label;
  const pretty = key
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
  return pretty || "Other";
}

export function frequencyLabel(key) {
  return EXPENSE_FREQUENCIES.find((f) => f.key === key)?.label || key;
}

export function statusLabel(key) {
  return EXPENSE_STATUSES.find((s) => s.key === key)?.label || key;
}

// ─── Deduction buckets: which expense rows have a DERIVED twin ───────────────
//
// Three costs can reach the owner's "money kept" figure by two different routes.
// OTA commission, card processing fees and business taxes are each *derived* from
// imported data at configured rates, and can *also* be entered by the owner as a
// real Expense row — the invoice, the merchant statement, the tax payment.
// Deducting both charges the owner twice for one cost.
//
// The rule is ACTUAL BEATS ESTIMATE: when actual expense rows exist in the
// period they ARE the deduction and the estimate is discarded. Payroll is a
// fourth special bucket for a related reason — a payroll-category expense row
// belongs on the payroll line beside the committed PayrollRun records, not in the
// generic operating-expense sweep, and not nowhere.
//
// WHY THIS VOCABULARY LIVES HERE (2026-08-20). It was previously copied into
// src/components/dashboard/MoneyKept.jsx and src/lib/calculationService.js, and
// the two disagreed. The service excluded only 'payroll' from its generic sweep,
// so every owner-entered OTA invoice, merchant statement and tax payment was
// deducted twice: once as the estimate it was supposed to replace, once as an
// operating expense. Both files now import from here, so the rule cannot drift
// without deleting an import.
//
// NOTE on src/lib/actionCenter.js, which keeps a fourth and SMALLER exclusion set
// ('ota_commission', 'credit_card_fees', 'payroll') and is deliberately left
// alone: that module has no tax leg at all, so a tax expense row there has no
// derived twin to duplicate and correctly belongs in operating expenses. Do not
// "unify" it onto DERIVED_COST_BUCKETS without first giving it a tax estimate —
// doing so would silently drop the owner's tax payments from its totals.

/**
 * Expense categories that represent a business tax payment. All three land in
 * the single "taxes" bucket; the generic `taxes` key reaches it by falling
 * through `expenseBucket` to its own name, which is why it is listed explicitly
 * rather than left implicit.
 */
export const TAX_EXPENSE_CATEGORIES = ["state_taxes", "city_taxes", "taxes"];

/**
 * Buckets that are deducted by their own rule and must therefore be EXCLUDED
 * from any generic "sum the remaining expenses" pass.
 */
export const DERIVED_COST_BUCKETS = ["ota", "credit_card_fees", "taxes", "payroll"];

/**
 * Map a stored expense category key to its deduction bucket.
 *
 * Input is normalised (trimmed, lower-cased) so that a category which escaped
 * `slugifyCategory` — imported data, a hand-edited record — buckets the same way
 * as a well-formed one. Doing it here rather than at each call site is the point:
 * two callers normalising differently is how the rule diverged in the first
 * place.
 *
 * @param {string} cat stored category key
 * @returns {string} bucket key
 */
export function expenseBucket(cat) {
  const key = String(cat ?? "").trim().toLowerCase();
  if (!key) return "other";
  if (key === "ota_commission") return "ota";
  if (key === "payroll") return "payroll";
  if (TAX_EXPENSE_CATEGORIES.includes(key)) return "taxes";
  return key;
}

/**
 * Apply ACTUAL BEATS ESTIMATE to one deduction leg, in integer cents.
 *
 * Returns the basis alongside the figure so the caller can label the line
 * honestly — "(actual)" versus "(estimated)" — instead of presenting two
 * different quantities as though they were the same one. That is the same reason
 * hotel.js#grossRevenueForPeriod returns its basis.
 *
 * `estimateApplies` exists for the OTA leg: with no SourceDay rows there is no
 * rate-card estimate to fall back on, and inventing a $0 "estimated" line would
 * claim a measurement that was never made.
 *
 * @param {{actualCents?: number, estimateCents?: number, estimateApplies?: boolean}} params
 * @returns {{cents: number, basis: "actual"|"estimated"|"none"}}
 */
export function chooseActualOrEstimate({ actualCents = 0, estimateCents = 0, estimateApplies = true } = {}) {
  if (actualCents > 0) return { cents: actualCents, basis: "actual" };
  if (estimateApplies) return { cents: estimateCents, basis: "estimated" };
  return { cents: 0, basis: "none" };
}
