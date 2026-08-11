import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useState, useEffect, useMemo } from "react";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Search, ShieldCheck, ShieldAlert } from "lucide-react";
import db from "@/api/base44Client";
import { verifyAuditChain } from "@/lib/securityUtils";
const ACTION_BADGE = (action) => {
    const cls = "border ";
    if (action.includes("Login") || action.includes("Logout"))
        return _jsx(Badge, { className: `${cls} bg-blue-500/20 text-blue-300 border-blue-500/40`, children: action });
    if (action.includes("Failed"))
        return _jsx(Badge, { className: `${cls} bg-red-500/20 text-red-300 border-red-500/40`, children: action });
    if (action.includes("Deleted") || action.includes("Disabled") || action.includes("Locked"))
        return _jsx(Badge, { className: `${cls} bg-red-500/20 text-red-300 border-red-500/40`, children: action });
    if (action.includes("Created"))
        return _jsx(Badge, { className: `${cls} bg-emerald-500/20 text-emerald-300 border-emerald-500/40`, children: action });
    if (action.includes("Password"))
        return _jsx(Badge, { className: `${cls} bg-amber-500/20 text-amber-300 border-amber-500/40`, children: action });
    if (action.includes("Enabled") || action.includes("Unlocked"))
        return _jsx(Badge, { className: `${cls} bg-emerald-500/20 text-emerald-300 border-emerald-500/40`, children: action });
    return _jsx(Badge, { className: `${cls} bg-slate-500/20 text-slate-300 border-slate-500/40`, children: action });
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
        }
        catch (e) {
            toast({ variant: "destructive", title: "Error", description: e.message });
        }
        finally {
            setLoading(false);
        }
    };
    useEffect(() => { load(); }, []);
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return logs.filter((l) => {
            if (result !== "all" && l.result !== result)
                return false;
            if (!q)
                return true;
            return ((l.username || "").toLowerCase().includes(q) ||
                (l.performed_by || "").toLowerCase().includes(q) ||
                (l.action || "").toLowerCase().includes(q) ||
                (l.detail || "").toLowerCase().includes(q));
        });
    }, [logs, search, result]);
    return (_jsx("div", { className: "space-y-6", children: _jsxs(Card, { children: [_jsxs(CardHeader, { className: "flex flex-row items-start justify-between space-y-0", children: [_jsxs("div", { children: [_jsx(CardTitle, { className: "text-xl", children: "Audit Log" }), _jsx(CardDescription, { children: "All security-related events: logins, password changes, user management." })] }), _jsx(Button, { variant: "outline", size: "icon", onClick: load, title: "Refresh", children: _jsx(RefreshCw, { className: `h-4 w-4 ${loading ? "animate-spin" : ""}` }) })] }), _jsxs(CardContent, { className: "space-y-4", children: [chain && (_jsxs("div", { className: `flex items-center gap-3 rounded-xl border p-3 text-sm ${chain.valid ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-red-500/30 bg-red-500/10 text-red-300"}`, children: [chain.valid ? _jsx(ShieldCheck, { className: "h-4 w-4 shrink-0" }) : _jsx(ShieldAlert, { className: "h-4 w-4 shrink-0" }), _jsx("div", { children: chain.valid ? (_jsxs("p", { className: "font-medium", children: ["Audit chain verified \u2014 ", chain.count, " log", chain.count === 1 ? "" : "s", " hash-linked and untampered."] })) : (_jsxs("p", { className: "font-medium", children: ["Audit chain verification failed (", chain.tamperedAt ? `tampering detected at log #${chain.tamperedAt}` : chain.reason || chain.error, ")."] })) }), _jsx("button", { onClick: () => setChain(null), className: "ml-auto text-xs opacity-60 hover:opacity-100", children: "\u00D7" })] })), _jsxs("div", { className: "flex flex-col gap-3 sm:flex-row sm:items-center", children: [_jsxs("div", { className: "relative max-w-sm flex-1", children: [_jsx(Search, { className: "absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" }), _jsx(Input, { value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search by user, action, detail...", className: "pl-9" })] }), _jsxs("div", { className: "flex items-center gap-2 text-sm", children: [_jsx("span", { className: "text-muted-foreground", children: "Result:" }), ["all", "success", "failed"].map((r) => (_jsx("button", { onClick: () => setResult(r), className: `rounded-md px-3 py-1.5 text-xs capitalize ${result === r ? "bg-[#6C63FF]/20 text-white" : "bg-white/5 text-slate-400"}`, children: r }, r)))] })] }), _jsx("div", { className: "rounded-xl border", children: _jsxs(Table, { children: [_jsx(TableHeader, { children: _jsxs(TableRow, { children: [_jsx(TableHead, { children: "Timestamp" }), _jsx(TableHead, { children: "User" }), _jsx(TableHead, { children: "Action" }), _jsx(TableHead, { children: "Performed By" }), _jsx(TableHead, { children: "Device" }), _jsx(TableHead, { children: "Result" })] }) }), _jsx(TableBody, { children: loading ? (_jsx(TableRow, { children: _jsx(TableCell, { colSpan: 6, className: "py-10 text-center text-muted-foreground", children: "Loading log..." }) })) : filtered.length === 0 ? (_jsx(TableRow, { children: _jsx(TableCell, { colSpan: 6, className: "py-10 text-center text-muted-foreground", children: "No matching events." }) })) : filtered.map((l) => (_jsxs(TableRow, { children: [_jsx(TableCell, { className: "whitespace-nowrap text-xs text-muted-foreground", children: new Date(l.created_date).toLocaleString() }), _jsx(TableCell, { className: "text-sm font-medium", children: l.username }), _jsx(TableCell, { children: ACTION_BADGE(l.action) }), _jsx(TableCell, { className: "text-xs text-muted-foreground", children: l.performed_by }), _jsx(TableCell, { className: "text-xs text-muted-foreground", children: l.device || "—" }), _jsx(TableCell, { children: _jsx(Badge, { className: `border ${l.result === "success" ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40" : "bg-red-500/20 text-red-300 border-red-500/40"}`, children: l.result }) })] }, l.id))) })] }) })] })] }) }));
}
