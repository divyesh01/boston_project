import React, { useState, useEffect, useMemo } from "react";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Search, ShieldCheck, ShieldAlert } from "lucide-react";
import { db } from "@/api/base44Client";
import { verifyAuditChain } from "@/lib/securityUtils";

const ACTION_BADGE = (action) => {
  const cls = "border ";
  if (action.includes("Login") || action.includes("Logout")) return <Badge className={`${cls} bg-blue-500/20 text-blue-300 border-blue-500/40`}>{action}</Badge>;
  if (action.includes("Failed")) return <Badge className={`${cls} bg-red-500/20 text-red-300 border-red-500/40`}>{action}</Badge>;
  if (action.includes("Deleted") || action.includes("Disabled") || action.includes("Locked")) return <Badge className={`${cls} bg-red-500/20 text-red-300 border-red-500/40`}>{action}</Badge>;
  if (action.includes("Created")) return <Badge className={`${cls} bg-emerald-500/20 text-emerald-300 border-emerald-500/40`}>{action}</Badge>;
  if (action.includes("Password")) return <Badge className={`${cls} bg-amber-500/20 text-amber-300 border-amber-500/40`}>{action}</Badge>;
  if (action.includes("Enabled") || action.includes("Unlocked")) return <Badge className={`${cls} bg-emerald-500/20 text-emerald-300 border-emerald-500/40`}>{action}</Badge>;
  return <Badge className={`${cls} bg-slate-500/20 text-slate-300 border-slate-500/40`}>{action}</Badge>;
};

export default function AuditLog() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [result, setResult] = useState("all");
  const [chain, setChain] = useState(null);

  const verify = async () => {
    const res = await verifyAuditChain();
    setChain(res);
  };

  const load = async () => {
    setLoading(true);
    try {
      const list = await db.audit.list({}, 100000);
      setLogs(list);
      await verify();
    } catch (e) {
      toast({ variant: "destructive", title: "Error", description: e.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logs.filter((l) => {
      if (result !== "all" && l.result !== result) return false;
      if (!q) return true;
      return (
        (l.username || "").toLowerCase().includes(q) ||
        (l.performed_by || "").toLowerCase().includes(q) ||
        (l.action || "").toLowerCase().includes(q) ||
        (l.detail || "").toLowerCase().includes(q)
      );
    });
  }, [logs, search, result]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-xl">Audit Log</CardTitle>
            <CardDescription>All security-related events: logins, password changes, user management.</CardDescription>
          </div>
          <Button variant="outline" size="icon" onClick={load} title="Refresh">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {chain && (
            <div className={`flex items-center gap-3 rounded-xl border p-3 text-sm ${chain.valid ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-red-500/30 bg-red-500/10 text-red-300"}`}>
              {chain.valid ? <ShieldCheck className="h-4 w-4 shrink-0" /> : <ShieldAlert className="h-4 w-4 shrink-0" />}
              <div>
                {chain.valid ? (
                  <p className="font-medium">Audit chain verified — {chain.count} log{chain.count === 1 ? "" : "s"} hash-linked and untampered.</p>
                ) : (
                  <p className="font-medium">Audit chain verification failed ({chain.tamperedAt ? `tampering detected at log #${chain.tamperedAt}` : chain.reason || chain.error}).</p>
                )}
              </div>
              <button onClick={() => setChain(null)} className="ml-auto text-xs opacity-60 hover:opacity-100">×</button>
            </div>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative max-w-sm flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by user, action, detail..." className="pl-9" />
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Result:</span>
              {["all", "success", "failed"].map((r) => (
                <button
                  key={r}
                  onClick={() => setResult(r)}
                  className={`rounded-md px-3 py-1.5 text-xs capitalize ${result === r ? "bg-[#6C63FF]/20 text-white" : "bg-white/5 text-slate-400"}`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Performed By</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">Loading log...</TableCell></TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No matching events.</TableCell></TableRow>
                ) : filtered.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(l.created_date).toLocaleString()}</TableCell>
                    <TableCell className="text-sm font-medium">{l.username}</TableCell>
                    <TableCell>{ACTION_BADGE(l.action)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{l.performed_by}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{l.device || "—"}</TableCell>
                    <TableCell>
                      <Badge className={`border ${l.result === "success" ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40" : "bg-red-500/20 text-red-300 border-red-500/40"}`}>
                        {l.result}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
