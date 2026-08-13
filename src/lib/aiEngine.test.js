import { describe, expect, it } from "vitest";
import { resolveRange } from "@/lib/aiEngine";

const iso = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

describe("resolveRange — next week", () => {
  it("spans a full 7 days starting tomorrow", () => {
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() + 1);
    const to = new Date(from);
    to.setDate(to.getDate() + 6);

    const r = resolveRange("next week", {});
    expect(r.from).toBe(iso(from));
    expect(r.to).toBe(iso(to));
    expect(r.single).toBe(false);
  });

  it("crosses the month boundary instead of clamping to day 31", () => {
    const r = resolveRange("next week", { latestDate: "2026-08-28" });
    expect(r.from).toBe("2026-08-29");
    expect(r.to).toBe("2026-09-04");
  });

  it("crosses the year boundary instead of clamping to Dec 31", () => {
    const r = resolveRange("next week", { latestDate: "2026-12-30" });
    expect(r.from).toBe("2026-12-31");
    expect(r.to).toBe("2027-01-06");
  });

  it("still computes this week via the same-day Sunday range", () => {
    const r = resolveRange("this week", { latestDate: "2026-08-28" });
    expect(r.to >= r.from).toBe(true);
  });
});
