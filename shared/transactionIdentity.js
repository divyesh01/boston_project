// shared/transactionIdentity.js
//
// One vocabulary for transaction identity across browser and Worker runtimes.
//
// There are intentionally TWO encodings today:
//   v1 / legacy-client — historical pipe-joined keys already stored in Dexie.
//   v2 / server         — injective length-prefixed keys used by D1.
//
// Keeping both codecs here prevents the field tuple from drifting while preserving
// backward compatibility. A future v1 -> v2 client migration must handle already-
// persisted legacy keys explicitly; changing the browser format in place would make
// a re-import look new and double-count historical transactions.

export const TRANSACTION_IDENTITY_VERSION = Object.freeze({
  LEGACY_CLIENT: "v1",
  SERVER_INJECTIVE: "v2",
});

export const TRANSACTION_IDENTITY_FIELDS = Object.freeze([
  "property",
  "date",
  "time",
  "folio_number",
  "transaction_code",
  "amount",
  "occurrence",
]);

export function legacyClientTransactionDedupeKey(row, occurrence = 0) {
  return [
    row?.property_id ?? "",
    row?.date ?? "",
    row?.time ?? "",
    row?.folio_number ?? "",
    row?.transaction_code ?? "",
    row?.amount ?? 0,
    occurrence,
  ].join("|");
}

export function encodeTransactionIdentityComponent(value) {
  if (value === null) return "n:0:";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("numeric identity component must be finite");
    const text = String(value);
    return `d:${text.length}:${text}`;
  }
  const text = String(value);
  return `s:${text.length}:${text}`;
}

export function serverTransactionDedupeKey(components) {
  if (!components || typeof components !== "object" || Array.isArray(components)) {
    throw new TypeError("dedupe components are required");
  }
  const {
    serverPropertyId,
    date,
    time,
    folio_number,
    transaction_code,
    amount,
    occurrence,
  } = components;

  if (typeof serverPropertyId !== "string" || serverPropertyId.length === 0) {
    throw new TypeError("serverPropertyId is required");
  }
  if (!Number.isInteger(occurrence) || occurrence < 0) {
    throw new TypeError("occurrence is invalid");
  }
  if (amount !== null && (typeof amount !== "number" || !Number.isFinite(amount))) {
    throw new TypeError("amount must already be normalized");
  }

  return [
    serverPropertyId,
    date,
    time,
    folio_number,
    transaction_code,
    amount,
    occurrence,
  ].map(encodeTransactionIdentityComponent).join("|");
}
