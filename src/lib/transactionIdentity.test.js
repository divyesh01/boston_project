import { describe, expect, it } from "vitest";
import {
  TRANSACTION_IDENTITY_FIELDS,
  TRANSACTION_IDENTITY_VERSION,
  legacyClientTransactionDedupeKey,
  serverTransactionDedupeKey,
} from "../../shared/transactionIdentity.js";
import { transactionDedupeKey as clientKey } from "@/lib/transactionNorm";
import { transactionDedupeKey as workerKey } from "../../worker/import.js";

const row = {
  property_id: "7",
  date: "2026-01-05",
  time: "08:14",
  folio_number: "F1001",
  transaction_code: "RM",
  amount: 129,
};

describe("transaction identity codec", () => {
  it("pins the shared identity field vocabulary and versions", () => {
    expect(TRANSACTION_IDENTITY_FIELDS).toEqual([
      "property", "date", "time", "folio_number", "transaction_code", "amount", "occurrence",
    ]);
    expect(TRANSACTION_IDENTITY_VERSION).toEqual({
      LEGACY_CLIENT: "v1",
      SERVER_INJECTIVE: "v2",
    });
  });

  it("preserves the historical browser key byte-for-byte", () => {
    const expected = "7|2026-01-05|08:14|F1001|RM|129|0";
    expect(legacyClientTransactionDedupeKey(row, 0)).toBe(expected);
    expect(clientKey(row, 0)).toBe(expected);
  });

  it("preserves the Worker injective key byte-for-byte", () => {
    const input = {
      serverPropertyId: "P_A",
      date: row.date,
      time: row.time,
      folio_number: row.folio_number,
      transaction_code: row.transaction_code,
      amount: row.amount,
      occurrence: 0,
    };
    const expected = "s:3:P_A|s:10:2026-01-05|s:5:08:14|s:5:F1001|s:2:RM|d:3:129|d:1:0";
    expect(serverTransactionDedupeKey(input)).toBe(expected);
    expect(workerKey(input)).toBe(expected);
  });

  it("documents why v2 is required: delimiter-bearing values collide under v1 but not v2", () => {
    const a = { ...row, property_id: "P", folio_number: "A|B", transaction_code: "C" };
    const b = { ...row, property_id: "P", folio_number: "A", transaction_code: "B|C" };
    expect(legacyClientTransactionDedupeKey(a, 0)).toBe(legacyClientTransactionDedupeKey(b, 0));

    const toServer = (r) => ({
      serverPropertyId: "P",
      date: r.date,
      time: r.time,
      folio_number: r.folio_number,
      transaction_code: r.transaction_code,
      amount: r.amount,
      occurrence: 0,
    });
    expect(serverTransactionDedupeKey(toServer(a))).not.toBe(serverTransactionDedupeKey(toServer(b)));
  });

  it("keeps null money distinct from a real zero in the server identity", () => {
    const base = {
      serverPropertyId: "P_A",
      date: "2026-01-05",
      time: null,
      folio_number: null,
      transaction_code: "RM",
      occurrence: 0,
    };
    expect(serverTransactionDedupeKey({ ...base, amount: null }))
      .not.toBe(serverTransactionDedupeKey({ ...base, amount: 0 }));
  });

  it("rejects invalid server identity inputs instead of silently coercing them", () => {
    expect(() => serverTransactionDedupeKey({ serverPropertyId: "", occurrence: 0, amount: 0 }))
      .toThrow(/serverPropertyId/);
    expect(() => serverTransactionDedupeKey({ serverPropertyId: "P", occurrence: -1, amount: 0 }))
      .toThrow(/occurrence/);
    expect(() => serverTransactionDedupeKey({ serverPropertyId: "P", occurrence: 0, amount: Number.NaN }))
      .toThrow(/amount/);
  });
});
