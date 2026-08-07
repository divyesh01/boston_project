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
