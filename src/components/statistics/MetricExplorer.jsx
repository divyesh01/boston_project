import React, { useMemo, useState } from "react";
import { Search, AlertTriangle } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { money2, num, C } from "@/lib/hotel";
import { sectionTable, PERIOD_LABEL } from "@/lib/statisticsAnalytics";

// Every metric in the snapshot, grouped by section, all five periods side by side.
//
// The point of this table is completeness: the headline cards above it show six
// numbers, and the file contains a hundred and six. Anything the parser could
// not categorise is shown with a marker rather than dropped, so an unrecognised
// metric is a visible question instead of a silent omission.

const COLUMNS = ["actual_today", "mtd", "ly_mtd", "ytd", "ly_ytd"];
const SHORT = { actual_today: "Today", mtd: "MTD", ly_mtd: "LY MTD", ytd: "YTD", ly_ytd: "LY YTD" };

// Values arrive already typed by the parser, so formatting keys off the unit it
// detected rather than guessing from the magnitude.
function formatValue(value, unit) {
  if (value === null || value === undefined) return <span className="text-slate-600">—</span>;
  if (unit === "currency") return money2(value);
  if (unit === "percentage") return `${Number(value).toFixed(2)}%`;
  return num(value);
}

export default function MetricExplorer({ rows = [] }) {
  const [query, setQuery] = useState("");
  const [openSection, setOpenSection] = useState(null);

  const sections = useMemo(() => sectionTable(rows), [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections
      .map((s) => ({ ...s, metrics: s.metrics.filter((m) => m.name.toLowerCase().includes(q)) }))
      .filter((s) => s.metrics.length > 0);
  }, [sections, query]);

  // Searching should reveal what it found rather than leave everything collapsed.
  const isOpen = (name) => (query.trim() ? true : openSection === name);

  const totalMetrics = sections.reduce((a, s) => a + s.metrics.length, 0);

  return (
    <Card
      title="Every metric in this snapshot"
      subtitle={`${num(totalMetrics)} metrics across ${sections.length} sections — nothing filtered out`}
      right={
        <label className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a metric"
            className="h-9 w-44 rounded-lg border border-white/10 bg-[#0A1628] pl-8 pr-3 text-sm text-slate-200 outline-none transition-colors placeholder:text-slate-600 focus:border-[#6C63FF] sm:w-56"
          />
        </label>
      }
    >
      {filtered.length === 0 && (
        <p className="text-sm text-slate-500">No metric matches “{query}”.</p>
      )}

      <div className="space-y-2">
        {filtered.map((section) => (
          <div key={section.name} className="overflow-hidden rounded-xl border border-white/5">
            <button
              onClick={() => setOpenSection(openSection === section.name ? null : section.name)}
              className="flex w-full items-center justify-between gap-3 bg-[#0A1628]/60 px-4 py-2.5 text-left transition-colors hover:bg-[#0A1628]"
            >
              <span className="text-sm font-medium text-slate-200">{section.name}</span>
              <span className="text-xs text-slate-500">
                {num(section.metrics.length)} metric{section.metrics.length === 1 ? "" : "s"}
              </span>
            </button>

            {isOpen(section.name) && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-sm">
                  <thead>
                    <tr className="border-y border-white/5 bg-[#0A1628]/30 text-left">
                      <th className="px-4 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">
                        Metric
                      </th>
                      {COLUMNS.map((p) => (
                        <th
                          key={p}
                          title={PERIOD_LABEL[p]}
                          className="px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500"
                        >
                          {SHORT[p]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {section.metrics.map((m) => (
                      <tr key={m.name} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
                        <td className="px-4 py-2 text-slate-300">
                          <span className="flex items-center gap-1.5">
                            {m.name}
                            {m.isUnknown && (
                              <AlertTriangle
                                className="h-3 w-3 shrink-0"
                                style={{ color: C.amber }}
                                aria-label="Not in the known metric list — imported and shown as-is"
                              />
                            )}
                            {m.isTotal && (
                              <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-500">
                                section total
                              </span>
                            )}
                          </span>
                        </td>
                        {COLUMNS.map((p) => (
                          <td key={p} className="px-3 py-2 text-right tabular-nums text-slate-300">
                            {formatValue(m.values[p], m.unit)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
