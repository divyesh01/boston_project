import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { DataScanner } from "@/lib/dataScanner";

const scanner = new DataScanner();

describe("detectConflicts", () => {
  it("returns [] when there are no conflicting values", () => {
    const a = [["2026-08-01", "100"]];
    const b = [["2026-08-01", "100"]];
    expect(scanner.detectConflicts(a, b, ["Date", "Amount"], ["Date", "Amount"])).toEqual([]);
  });

  it("compares every column at its real index when headers repeat", () => {
    // 'Amount' appears twice (e.g. two amount columns in a merged sheet).
    // Column 2 genuinely differs between the files (200 vs 900). The old
    // header.join used indexOf, which maps BOTH Amount occurrences to column
    // 1, so the real difference in column 2 was never reported.
    const rows1 = [["2026-08-01", "100", "200"]];
    const rows2 = [["2026-08-01", "100", "900"]];
    const headers = ["Date", "Amount", "Amount"];

    const issues = scanner.detectConflicts(rows1, rows2, headers, headers);
    expect(issues.length).toBe(1);

    const diffs = issues[0].conflicts[0].diffs;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].column).toBe("Amount");
    expect(diffs[0].value1).toBe("200");
    expect(diffs[0].value2).toBe("900");
  });

  it("matches duplicated headers to distinct counterpart columns", () => {
    const rows1 = [["2026-08-01", "A", "x"]];
    const rows2 = [["2026-08-01", "A", "y"]];
    const headers = ["Date", "Note", "Note"];
    const issues = scanner.detectConflicts(rows1, rows2, headers, headers);

    // Only the real difference (second Note: x vs y) is reported — not a
    // phantom conflict on the first Note, which is identical.
    const diffs = issues[0].conflicts[0].diffs;
    expect(diffs).toHaveLength(1);
    expect(diffs[0].value1).toBe("x");
    expect(diffs[0].value2).toBe("y");
  });
});