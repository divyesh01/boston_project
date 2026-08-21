import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { RefreshCw, Search, ShieldCheck, ShieldAlert, Download, X, ArrowUp, ArrowDown } from "lucide-react";
import { db } from "@/api/base44Client";
import { verifyAuditChain as verifyAuditChainLocal } from "@/lib/securityUtils";
import { AUDIT_CATEGORIES, filterAuditLogs, auditActionSeverity } from "@/lib/auditFilter";
import { readAuditFailures, clearAuditFailures, auditFailuresMayBeIncomplete } from "@/lib/auditFailureLog";
import {
  NO_PROPERTY,
  groupPropertyCounts,
  filterByProperty,
  filterByResult,
  sortAuditLogs,
  AUDIT_EXPORT_COLUMNS,
} from "@/lib/auditView";
import {
  QUICK_RANGES,
  resolveQuickRange,
  withinRange,
  countUndated,
  describeRange,
  downloadCsv,
  stampFilename,
  readStoredFilters,
  writeStoredFilters,
  clearStoredFilters,
} from "@/lib/exportData";

// Colour comes from auditActionSeverity, not from an ordered chain of substring tests
// in this file. The old chain asked `includes("Login")` before `includes("Failed")`, so
// 'Failed Login' matched the friendlier word first and a brute-force attempt was painted
// the same blue as a normal sign-in. A lookup table cannot have that ordering bug.
const SEVERITY_BADGE = {
  danger: "bg-red-500/20 text-red-300 border-red-500/40",
  warn: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  success: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  info: "bg-blue-500/20 text-blue-300 border-blue-500/40",
  neutral: "bg-slate-500/20 text-slate-300 border-slate-500/40",
};

// Result is written as 'success', 'failed' or 'pending'.
const RESULT_BADGE = {
  success: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  failed: "bg-red-500/20 text-red-300 border-red-500/40",
  pending: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  unknown: "bg-slate-500/20 text-slate-300 border-slate-500/40",
};

const ACTION_BADGE = (action) => {
  // A row written without an action still has to render; it must not blank the table.
  const label = action ? String(action) : "Unknown Action";
  const severity = auditActionSeverity(action);
  return (
    <Badge className={`border ${SEVERITY_BADGE[severity] || SEVERITY_BADGE.neutral}`}>
      {label}
    </Badge>
  );
};

// Chip styling goes through the token layer rather than the legacy accents this
// page used (#6C63FF for Result, #00D4FF for Category). src/index.css gives
// chrome exactly one accent for a measured reason: indigo scores 4.28:1 on the
// card surface and fails body-text contrast, and five accents at equal weight is
// what made the old dashboard read as noise. Emerald --brand measures 10.64:1.
const CHIP = "rounded-md px-3 py-1.5 text-xs transition-colors duration-150";
const CHIP_ON = `${CHIP} bg-[var(--brand-quiet)] text-[var(--t-primary)] ring-1 ring-[var(--brand-line)]`;
const CHIP_OFF = `${CHIP} bg-white/5 text-[var(--t-tertiary)] hover:bg-white/10 hover:text-[var(--t-secondary)]`;
const chip = (active) => (active ? CHIP_ON : CHIP_OFF);

// The read limit. base44Client's db.audit.list returns only res.logs, dropping
// the server's `truncated` flag (it is a PROTECTED file — see PROTECTED_FILES.md
// — so the flag cannot be surfaced from here). Comparing the row count against
// the requested limit detects the boundary without touching it: if the server
// returned exactly as many rows as we asked for, there are probably more, and an
// audit view must say so rather than present a silent subset as the whole log.
const READ_LIMIT = 100000;

const FILTER_DEFAULTS = { range: "30d", from: "", to: "", result: "all", category: "ALL", property: "all" };
const SORT_DEFAULT = { key: "created_date", dir: "desc" };



export default function AuditLog() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [maybeTruncated, setMaybeTruncated] = useState(false);

  const [search, setSearch] = useState("");
  // Restored from the last visit. A dashboard that forgets its filters is one
  // the owner re-configures every morning.
  const [stored] = useState(() => readStoredFilters("audit", FILTER_DEFAULTS));
  const [range, setRange] = useState(stored.range);
  const [customFrom, setCustomFrom] = useState(stored.from);
  const [customTo, setCustomTo] = useState(stored.to);
  const [result, setResult] = useState(stored.result);
  const [category, setCategory] = useState(stored.category);
  const [property, setProperty] = useState(stored.property);
  const [sort, setSort] = useState(SORT_DEFAULT);

  const [chain, setChain] = useState(null);
  const [verifying, setVerifying] = useState(false);

  // Audit events that could not be written at all. These are NOT rows in the
  // table — that is the point: the table cannot show an event that was never
  // recorded, and the chain verifies green regardless, because audit_verify can
  // only check the rows it is given. Without this the loss is invisible.
  const [writeFailures, setWriteFailures] = useState(() => readAuditFailures());

  useEffect(() => {
    writeStoredFilters("audit", { range, from: customFrom, to: customTo, result, category, property });
  }, [range, customFrom, customTo, result, category, property]);

  // Authoritative chain verification goes through db.audit.verifyChain(), which
  // delegates to the serverless audit_verify function (signed with the
  // server-held AUDIT_CHAIN_SECRET) in production and falls back to the
  // client-side verifyAuditChain() guard over localDb in dev. If the remote
  // call throws (network / auth failure), we surface the local result so the
  // page still tells the user SOMETHING rather than silently hanging on a
  // rejected promise.
  const verify = async () => {
    setVerifying(true);
    try {
      const res = await db.audit.verifyChain();
      setChain(res);
    } catch (e) {
      try {
        const local = await verifyAuditChainLocal();
        setChain({ ...local, source: "local", fallbackReason: e?.message || "remote verify failed" });
      } catch (e2) {
        setChain({ valid: false, error: e2?.message || String(e2), source: "local" });
      }
    } finally {
      setVerifying(false);
    }
  };

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    setWriteFailures(readAuditFailures());
    try {
      const list = await db.audit.list({}, READ_LIMIT);
      setLogs(list);
      setMaybeTruncated(Array.isArray(list) && list.length >= READ_LIMIT);
      await verify();
    } catch (e) {
      // A toast disappears after a few seconds. Without a persistent error state the
      // table falls back to "No matching events", which tells the operator there are no
      // security events when in fact we could not read them — the one thing an audit
      // view must never claim falsely.
      setLoadError(e?.message || String(e));
      setLogs([]);
      toast({ variant: "destructive", title: "Error", description: e.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Resolved once per render pass rather than per row: resolveQuickRange builds
  // Dates, and calling it inside a filter over 100k rows is 100k allocations.
  const { from, to } = useMemo(
    () => (range === "custom"
      ? { from: customFrom || null, to: customTo || null }
      : resolveQuickRange(range)),
    [range, customFrom, customTo],
  );

  // Properties present in the data, so the filter offers what exists instead of
  // a hard-coded list that can drift from the portfolio. The bucketing itself
  // lives in src/lib/auditView.js so it can be asserted by
  // scripts/probe-audit-export.mjs — see that file's header for why.
  const properties = useMemo(() => groupPropertyCounts(logs), [logs]);

  const dateFiltered = useMemo(
    () => (from || to ? logs.filter((l) => withinRange(l.created_date, from, to)) : logs),
    [logs, from, to],
  );

  // Rows a date filter had to exclude because they carry no readable timestamp.
  // Reported rather than swallowed: an audit row with no date is itself a defect,
  // and hiding it inside a filter is how it stays unnoticed.
  const undated = useMemo(
    () => ((from || to) ? countUndated(logs) : 0),
    [logs, from, to],
  );

  // Property and result are filtered here rather than passed to filterAuditLogs.
  //
  // WHY, recorded because the two implementations deliberately disagree:
  // filterAuditLogs' property test is `if (propertyId && propertyId !== 'all' &&
  // log.property_id && log.property_id !== propertyId) return false`
  // (src/lib/auditFilter.js:105). The `log.property_id &&` clause means a row with
  // NO property_id passes EVERY property filter. That is a defensible product
  // choice for a page that treats global events as belonging to all properties,
  // but it cannot be combined with per-chip counts: those rows are counted by no
  // chip, so "prop_2 (41)" would display 41 and then render more than 41 rows.
  // Here the selection is exact — including the explicit unscoped bucket above —
  // so the number on the chip is the number of rows you get. auditFilter.js is
  // left alone; it is shared with other callers and changing its semantics is a
  // separate blast radius (ARCHITECT.md).
  const scoped = useMemo(
    () => filterByResult(filterByProperty(dateFiltered, property), result),
    [dateFiltered, property, result],
  );

  const filtered = useMemo(
    () => filterAuditLogs(scoped, { category, searchQuery: search }),
    [scoped, category, search],
  );

  const sorted = useMemo(() => sortAuditLogs(filtered, sort), [filtered, sort]);

  const toggleSort = useCallback((key) => {
    setSort((s) => (s.key === key
      ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
      // A new column starts descending for dates (newest first is what you want)
      // and ascending for text (A-Z is what you want).
      : { key, dir: key === "created_date" ? "desc" : "asc" }));
  }, []);

  const filtersActive =
    range !== "all" || result !== "all" || category !== "ALL" || property !== "all" || search.trim() !== "";

  const clearFilters = () => {
    setRange("all");
    setCustomFrom("");
    setCustomTo("");
    setResult("all");
    setCategory("ALL");
    setProperty("all");
    setSearch("");
    clearStoredFilters("audit");
  };

  // Named with the property's NAME, not its id, for the same reason the chips are:
  // "property prop_2" tells the owner nothing about which hotel they are looking at.
  const propertyLabel = properties.find((p) => p.id === property)?.label || property;

  const activeSummary = [
    describeRange(from, to),
    property !== "all" ? (property === NO_PROPERTY ? "no property set" : `property ${propertyLabel}`) : null,
    result !== "all" ? `${result} only` : null,
    category !== "ALL" ? String(category).toLowerCase() : null,
    search.trim() ? `“${search.trim()}”` : null,
  ].filter(Boolean);

  const exportCsv = () => {
    try {
      // Exports exactly what is on screen, in the order it is on screen. An
      // export that silently ignores the active filters or the chosen sort makes
      // the file impossible to reconcile against the view it came from.
      const n = downloadCsv(sorted, {
        filename: stampFilename("audit-log"),
        columns: AUDIT_EXPORT_COLUMNS,
      });
      toast({
        title: `Exported ${n.toLocaleString()} event${n === 1 ? "" : "s"}`,
        description: activeSummary.length
          ? `Filters applied: ${activeSummary.join(" · ")}`
          : "No filters applied — the full log as loaded.",
      });
    } catch (e) {
      toast({ variant: "destructive", title: "Nothing exported", description: e?.message || String(e) });
    }
  };

  const parentRef = useRef();

  const rowVirtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 10,
  });

  const SortHead = ({ column, children, className = "" }) => (
    <TableHead className={className} aria-sort={sort.key === column ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={() => toggleSort(column)}
        className="inline-flex items-center gap-1 hover:text-[var(--t-primary)]"
        title={`Sort by ${typeof children === "string" ? children : column}`}
      >
        {children}
        {sort.key === column
          ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
          : <ArrowDown className="h-3 w-3 opacity-20" />}
      </button>
    </TableHead>
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-xl">Audit Log</CardTitle>
            <CardDescription>All security-related events: logins, password changes, user management.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={exportCsv}
              disabled={loading || sorted.length === 0}
              title={sorted.length ? `Export ${sorted.length} events to CSV` : "Nothing to export"}
            >
              <Download className="mr-2 h-4 w-4" />
              Export CSV
            </Button>
            <Button variant="outline" size="icon" onClick={verify} title="Re-verify chain" aria-label="Re-verify chain" disabled={verifying}>
              {verifying
                ? <ShieldCheck className="h-4 w-4 animate-pulse" />
                : <ShieldCheck className="h-4 w-4" />}
            </Button>
            <Button variant="outline" size="icon" onClick={load} title="Refresh" aria-label="Refresh">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Deliberately ABOVE the chain banner. A green "chain verified" line is
              reassuring and would be read first, but it says nothing about events
              that never reached the table — audit_verify only links the rows it can
              see. The gap has to be read before the reassurance. */}
          {writeFailures.length > 0 && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
              <div className="flex items-start gap-3">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium">
                    {writeFailures.length} audit event{writeFailures.length === 1 ? "" : "s"} could not be recorded
                    {auditFailuresMayBeIncomplete() ? " (at least — this device could not store the full list)" : ""}.
                  </p>
                  <p className="mt-1 opacity-90">
                    The actions themselves went ahead; only the record of them was lost, so they are
                    absent from the table below and no integrity check can recover them.
                  </p>
                  <ul className="mt-2 space-y-1">
                    {writeFailures.slice(0, 5).map((f, i) => (
                      <li key={`${f.at}-${i}`} className="truncate font-mono text-xs opacity-80">
                        {f.at} · {f.action}
                        {f.username ? ` · ${f.username}` : ""}
                        {f.reason ? ` — ${f.reason}` : ""}
                      </li>
                    ))}
                  </ul>
                  {writeFailures.length > 5 && (
                    <p className="mt-1 text-xs opacity-70">…and {writeFailures.length - 5} more.</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => { clearAuditFailures(); setWriteFailures([]); }}
                  className="ml-auto shrink-0 text-xs opacity-60 hover:opacity-100"
                  title="Acknowledge — this dismisses the notice, it does not recover the events"
                >
                  Acknowledge
                </button>
              </div>
            </div>
          )}

          {chain && (
            <div className={`flex items-center gap-3 rounded-xl border p-3 text-sm ${chain.valid ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-red-500/30 bg-red-500/10 text-red-300"}`}>
              {chain.valid ? <ShieldCheck className="h-4 w-4 shrink-0" /> : <ShieldAlert className="h-4 w-4 shrink-0" />}
              <div>
                {chain.valid ? (
                  <p className="font-medium">
                    Audit chain verified — {chain.count} log{chain.count === 1 ? "" : "s"} hash-linked and untampered.
                    {chain.source === "server"
                      ? " (Server-authoritative: signed with AUDIT_CHAIN_SECRET.)"
                      : " (Local integrity check over cached rows.)"}
                  </p>
                ) : (
                  <p className="font-medium">
                    Audit chain verification failed
                    {chain.tamperedAt ? ` — tampering detected at log #${chain.tamperedAt}${typeof chain.index === "number" ? ` (row ${chain.index})` : ""}`
                      : chain.brokenAt ? ` — chain break at log #${chain.brokenAt}${typeof chain.index === "number" ? ` (row ${chain.index})` : ""} (a row was inserted, removed, or reordered)`
                      : chain.reason === "hash_mismatch" ? " — hash mismatch"
                      : chain.reason === "chain_break" ? " — chain break"
                      : chain.error ? ` — ${chain.error}`
                      : chain.reason ? ` — ${chain.reason}`
                      : "."}
                    {chain.source === "server" ? " (Server-authoritative recheck.)" : " (Local integrity check.)"}
                    {chain.fallbackReason ? ` Local fallback engaged after remote verify failed: ${chain.fallbackReason}` : ""}
                  </p>
                )}
              </div>
              <button onClick={() => setChain(null)} className="ml-auto text-xs opacity-60 hover:opacity-100" aria-label="Close">×</button>
            </div>
          )}

          {maybeTruncated && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
              This view is showing the most recent {READ_LIMIT.toLocaleString()} events, which is the read limit —
              older events exist and are not on screen. Narrow the date range to reach them.
            </div>
          )}

          {/* ── Date range: the filter an owner reaches for first ─────────────
              Presets are computed from LOCAL calendar parts. Deriving them from
              toISOString() puts anything after 8pm Eastern on tomorrow's date,
              so "Today" would hide the evening shift's own events — exactly when
              a night-audit clerk is looking at them. */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-[var(--t-tertiary)]">When:</span>
            {QUICK_RANGES.map((q) => (
              <button
                key={q.id}
                type="button"
                onClick={() => setRange(q.id)}
                aria-pressed={range === q.id}
                className={chip(range === q.id)}
              >
                {q.label}
              </button>
            ))}
            {range === "custom" && (
              <span className="flex flex-wrap items-center gap-2">
                <input
                  type="date"
                  aria-label="From date"
                  value={customFrom}
                  max={customTo || undefined}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="rounded-lg border border-[var(--line)] bg-[var(--s-overlay)] px-3 py-1.5 text-xs text-[var(--t-primary)] outline-none"
                />
                <span className="text-[var(--t-tertiary)]">→</span>
                <input
                  type="date"
                  aria-label="To date"
                  value={customTo}
                  min={customFrom || undefined}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="rounded-lg border border-[var(--line)] bg-[var(--s-overlay)] px-3 py-1.5 text-xs text-[var(--t-primary)] outline-none"
                />
              </span>
            )}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative max-w-sm flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by user, action, detail..." className="pl-9" />
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-[var(--t-tertiary)]">Result:</span>
              {["all", "success", "failed", "pending"].map((r) => (
                <button key={r} type="button" onClick={() => setResult(r)} aria-pressed={result === r} className={`${chip(result === r)} capitalize`}>
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-[var(--t-tertiary)]">Category:</span>
            {Object.keys(AUDIT_CATEGORIES).map((cat) => (
              <button key={cat} type="button" onClick={() => setCategory(cat)} aria-pressed={category === cat} className={`${chip(category === cat)} capitalize`}>
                {cat}
              </button>
            ))}
          </div>

          {/* Only rendered when there is more than one property to choose
              between: a single-property filter is a control that cannot change
              anything, and every one of those costs the owner a moment. */}
          {properties.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-[var(--t-tertiary)]">Property:</span>
              <button type="button" onClick={() => setProperty("all")} aria-pressed={property === "all"} className={chip(property === "all")}>
                All
              </button>
              {properties.map(({ id, label, count }) => (
                <button key={id} type="button" onClick={() => setProperty(id)} aria-pressed={property === id} className={chip(property === id)}>
                  {id === NO_PROPERTY ? "No property" : label} <span className="opacity-60">{count.toLocaleString()}</span>
                </button>
              ))}
            </div>
          )}

          {/* ── What you are looking at ───────────────────────────────────────
              A filtered count read as a total is the same class of mistake as an
              empty table that actually means "the read failed". Both numbers are
              always on screen, and the active filters are named. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--line-subtle)] pt-3 text-xs text-[var(--t-tertiary)]">
            <span className="text-[var(--t-secondary)]">
              {loading ? "Loading…" : (
                <>
                  <strong className="text-[var(--t-primary)]">{sorted.length.toLocaleString()}</strong>
                  {sorted.length === logs.length ? " events" : ` of ${logs.length.toLocaleString()} events`}
                </>
              )}
            </span>
            {activeSummary.length > 0 && <span>· {activeSummary.join(" · ")}</span>}
            {undated > 0 && (
              <span className="text-amber-300">
                · {undated.toLocaleString()} row{undated === 1 ? "" : "s"} excluded: no readable timestamp
              </span>
            )}
            {filtersActive && (
              <button type="button" onClick={clearFilters} className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[var(--t-secondary)] hover:bg-white/5 hover:text-[var(--t-primary)]">
                <X className="h-3 w-3" /> Clear all filters
              </button>
            )}
          </div>

          <div className="rounded-xl border max-h-[600px] overflow-auto" ref={parentRef}>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortHead column="created_date">Timestamp</SortHead>
                  <SortHead column="username">User</SortHead>
                  <SortHead column="action">Action</SortHead>
                  <SortHead column="performed_by">Performed By</SortHead>
                  <SortHead column="device">Device</SortHead>
                  <SortHead column="result">Result</SortHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">Loading log...</TableCell></TableRow>
                ) : loadError ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center">
                      <p className="font-medium text-[var(--data-negative)]">Could not load the audit log.</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        This is a read failure, not an empty log — events may exist that are not shown. {loadError}
                      </p>
                      <Button variant="outline" size="sm" className="mt-3" onClick={load}>Try again</Button>
                    </TableCell>
                  </TableRow>
                ) : sorted.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                      {logs.length === 0 ? (
                        "No events have been recorded yet."
                      ) : (
                        <>
                          <p>No events match these filters.</p>
                          <p className="mt-1 text-xs">
                            {logs.length.toLocaleString()} events are loaded — the filters exclude all of them.
                          </p>
                          <Button variant="outline" size="sm" className="mt-3" onClick={clearFilters}>Clear all filters</Button>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ) : (
                  <>
                    <tr style={{ height: `${rowVirtualizer.getTotalSize()}px`, display: 'block', width: '100%', position: 'relative' }}>
                      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                        const l = sorted[virtualRow.index];
                        return (
                          <TableRow
                            key={l.id}
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: '100%',
                              height: `${virtualRow.size}px`,
                              transform: `translateY(${virtualRow.start}px)`
                            }}
                          >
                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground w-1/6">{new Date(l.created_date).toLocaleString()}</TableCell>
                            <TableCell className="text-sm font-medium w-1/6">{l.username}</TableCell>
                            <TableCell className="w-1/6">{ACTION_BADGE(l.action)}</TableCell>
                            <TableCell className="text-xs text-muted-foreground w-1/6">{l.performed_by}</TableCell>
                            <TableCell className="text-xs text-muted-foreground w-1/6">{l.device || "—"}</TableCell>
                            <TableCell className="w-1/6">
                              {/* Three states are written, not two: 'success', 'failed'
                                  and 'pending'. A ternary on === "success" painted
                                  pending rows in failure red. */}
                              <Badge className={`border ${RESULT_BADGE[l.result] || RESULT_BADGE.unknown}`}>
                                {l.result || "unknown"}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </tr>
                  </>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
