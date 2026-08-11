import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { db } from '@/api/base44Client';
import React, { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Save, Plus, CheckCircle2, RotateCcw, Trash2, Building2, RefreshCw, UserCog, LogOut, Shield, ShieldOff, Key, Smartphone } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { getCommissionRates, setCommissionRates, getCcFeeRate, setCcFeeRate, getCcFeeOnRefunds, setCcFeeOnRefunds, COMMISSION_TYPES } from "@/lib/commissionRates";
import { getAlertThresholds, saveAlertThresholds } from "@/lib/alertThresholds";
import { getRevenueThresholds, saveRevenueThresholds } from "@/lib/revenueThresholds";
import { getTaxSettings, saveTaxSettings } from "@/lib/taxSettings";
import { toast } from "@/components/ui/use-toast";
import { useAuth } from "@/lib/AuthContext";
import { useProperties } from "@/lib/useHotelData";
import { queryClientInstance } from "@/lib/query-client";
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel, } from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { getCsrfToken, sensitiveActionRateLimiter, validateCsrfToken, rotateCsrfToken, sanitizeText, sanitizeAlphanumeric, sanitizeCsvCell } from "@/lib/securityUtils";
export default function Settings() {
    const { user: me, logout, hasPermission } = useAuth();
    const [rates, setRates] = useState(() => getCommissionRates());
    const [ccFee, setCcFee] = useState(() => getCcFeeRate());
    const [ccRefunds, setCcRefunds] = useState(() => getCcFeeOnRefunds());
    const [taxRows, setTaxRows] = useState(() => getTaxSettings());
    const [taxSaved, setTaxSaved] = useState(false);
    const [newSource, setNewSource] = useState("");
    const [saved, setSaved] = useState(false);
    const [deletePhrase, setDeletePhrase] = useState("");
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState("");
    const [thresholds, setThresholds] = useState(() => getAlertThresholds());
    const [thresholdSaved, setThresholdSaved] = useState(false);
    const [revThresholds, setRevThresholds] = useState(() => getRevenueThresholds());
    const [revSaved, setRevSaved] = useState(false);
    const { data: properties = [], refetch: refetchProps } = useProperties();
    const [newPropCode, setNewPropCode] = useState("");
    const [newPropName, setNewPropName] = useState("");
    const [newPropRooms, setNewPropRooms] = useState("100");
    const [propMsg, setPropMsg] = useState("");
    const [propDeleteTarget, setPropDeleteTarget] = useState(null);
    // MFA self-service state
    const [mfaSetupOpen, setMfaSetupOpen] = useState(false);
    const [mfaSecret, setMfaSecret] = useState(null);
    const [mfaUri, setMfaUri] = useState(null);
    const [mfaBackupCodes, setMfaBackupCodes] = useState([]);
    const [mfaVerifying, setMfaVerifying] = useState(false);
    const [mfaAction, setMfaAction] = useState(null); // 'enable' | 'disable'
    // Auto-save commission rates & CC fee to localStorage on change
    useEffect(() => {
        setCommissionRates(rates);
        setCcFeeRate(ccFee);
        setCcFeeOnRefunds(ccRefunds);
    }, [rates, ccFee, ccRefunds]);
    // Auto-save alert thresholds
    useEffect(() => {
        saveAlertThresholds(thresholds);
    }, [thresholds]);
    // Auto-save revenue thresholds
    useEffect(() => {
        saveRevenueThresholds(revThresholds);
    }, [revThresholds]);
    // Auto-save tax settings
    useEffect(() => {
        const clean = taxRows.map(({ _key, ...rest }) => rest);
        saveTaxSettings(clean);
    }, [taxRows]);
    const handleChange = (key, field, val) => {
        const cur = rates[key] || { type: "percentage", rate: 0, taxExempt: false };
        if (field === "rate") {
            // Enter plain percentages for percentage types (e.g. 15 → 15%, not 0.15).
            // Fixed $ / actual values are stored as-is.
            const n = Number(val);
            const numVal = Number.isFinite(n) ? Math.max(0, n) : 0;
            const stored = cur.type === "percentage" ? Math.min(0.9999, numVal / 100) : numVal;
            setRates({ ...rates, [key]: { ...cur, rate: stored } });
        }
        else {
            setRates({ ...rates, [key]: { ...cur, [field]: val } });
        }
    };
    const handleCcFeeChange = (val) => {
        const v = Number(val);
        setCcFee(v);
    };
    const handleAdd = () => {
        const name = newSource.trim().toUpperCase();
        if (name && !rates[name]) {
            setRates({ ...rates, [name]: { type: "percentage", rate: 0, taxExempt: false } });
            setNewSource("");
        }
    };
    const handleRemove = (key) => {
        const next = { ...rates };
        delete next[key];
        setRates(next);
    };
    const handleSave = async () => {
        const rateLimit = sensitiveActionRateLimiter.check();
        if (!rateLimit.allowed) {
            toast({ variant: "destructive", title: "Rate Limited", description: `Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.` });
            return;
        }
        const csrfToken = getCsrfToken();
        if (!validateCsrfToken(csrfToken)) {
            toast({ variant: "destructive", title: "Security Error", description: "Invalid security token. Please refresh the page and try again." });
            rotateCsrfToken();
            return;
        }
        setCommissionRates(rates);
        setCcFeeRate(ccFee);
        setCcFeeOnRefunds(ccRefunds);
        try {
            await db.audit.log({
                username: me?.username || "settings",
                action: "Commission rates updated",
                detail: `${Object.keys(rates).length} source rate(s) · CC fee ${(ccFee * 100).toFixed(2)}% · fee on refunds ${ccRefunds ? "on" : "off"}`,
            });
        }
        catch (e) {
            console.error("[audit] commission rates:", e);
        }
        queryClientInstance.invalidateQueries({ queryKey: ["sources"] });
        queryClientInstance.invalidateQueries({ queryKey: ["payments"] });
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        rotateCsrfToken();
    };
    const handleReset = () => {
        const fresh = getCommissionRates();
        setRates(fresh);
        setCcFee(getCcFeeRate());
        setCcRefunds(getCcFeeOnRefunds());
    };
    const updateTaxRow = (i, patch) => {
        setTaxRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    };
    const addTaxRow = () => {
        setTaxRows((prev) => [
            ...prev,
            {
                _key: `${Date.now()}_${prev.length}`,
                property_id: "*",
                state_rate: 0,
                city_rate: 0,
                other_rate: 0,
                effective_start: new Date().toISOString().slice(0, 10),
                effective_end: "",
            },
        ]);
    };
    const removeTaxRow = (i) => {
        setTaxRows((prev) => prev.filter((_, idx) => idx !== i));
    };
    const handleSaveTax = async () => {
        const rateLimit = sensitiveActionRateLimiter.check();
        if (!rateLimit.allowed) {
            toast({ variant: "destructive", title: "Rate Limited", description: `Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.` });
            return;
        }
        const csrfToken = getCsrfToken();
        if (!validateCsrfToken(csrfToken)) {
            toast({ variant: "destructive", title: "Security Error", description: "Invalid security token. Please refresh the page and try again." });
            rotateCsrfToken();
            return;
        }
        const clean = taxRows.map(({ _key, ...rest }) => rest);
        saveTaxSettings(clean);
        try {
            await db.audit.log({
                username: me?.username || "settings",
                action: "Tax settings updated",
                detail: `${clean.length} tax period(s): ${clean
                    .map((r) => `${r.property_id || "*"} S${((r.state_rate || 0) * 100).toFixed(2)}% C${((r.city_rate || 0) * 100).toFixed(2)}% O${((r.other_rate || 0) * 100).toFixed(2)}% (${r.effective_start || "open"}${r.effective_end ? ` → ${r.effective_end}` : ""})`)
                    .join("; ")}`,
            });
        }
        catch (e) {
            console.error("[audit] tax settings:", e);
        }
        queryClientInstance.invalidateQueries({ queryKey: ["payments"] });
        queryClientInstance.invalidateQueries({ queryKey: ["sources"] });
        queryClientInstance.invalidateQueries({ queryKey: ["occupancy"] });
        queryClientInstance.invalidateQueries({ queryKey: ["gross"] });
        queryClientInstance.invalidateQueries({ queryKey: ["expenses"] });
        queryClientInstance.invalidateQueries({ queryKey: ["payroll"] });
        setTaxSaved(true);
        setTimeout(() => setTaxSaved(false), 2000);
        rotateCsrfToken();
    };
    const handleSaveThresholds = () => {
        const rateLimit = sensitiveActionRateLimiter.check();
        if (!rateLimit.allowed) {
            toast({ variant: "destructive", title: "Rate Limited", description: `Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.` });
            return;
        }
        const csrfToken = getCsrfToken();
        if (!validateCsrfToken(csrfToken)) {
            toast({ variant: "destructive", title: "Security Error", description: "Invalid security token. Please refresh the page and try again." });
            rotateCsrfToken();
            return;
        }
        saveAlertThresholds(thresholds);
        setThresholdSaved(true);
        setTimeout(() => setThresholdSaved(false), 2000);
        rotateCsrfToken();
    };
    const handleSaveRevThresholds = () => {
        const rateLimit = sensitiveActionRateLimiter.check();
        if (!rateLimit.allowed) {
            toast({ variant: "destructive", title: "Rate Limited", description: `Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.` });
            return;
        }
        const csrfToken = getCsrfToken();
        if (!validateCsrfToken(csrfToken)) {
            toast({ variant: "destructive", title: "Security Error", description: "Invalid security token. Please refresh the page and try again." });
            rotateCsrfToken();
            return;
        }
        saveRevenueThresholds(revThresholds);
        setRevSaved(true);
        setTimeout(() => setRevSaved(false), 2000);
        rotateCsrfToken();
    };
    const handleAddProperty = async () => {
        if (!newPropCode.trim() || !newPropName.trim())
            return;
        const rateLimit = sensitiveActionRateLimiter.check();
        if (!rateLimit.allowed) {
            toast({ variant: "destructive", title: "Rate Limited", description: `Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.` });
            return;
        }
        const csrfToken = getCsrfToken();
        if (!validateCsrfToken(csrfToken)) {
            toast({ variant: "destructive", title: "Security Error", description: "Invalid security token. Please refresh the page and try again." });
            rotateCsrfToken();
            return;
        }
        setPropMsg("");
        try {
            const sanitizedCode = sanitizeAlphanumeric(newPropCode.trim()).toUpperCase();
            const sanitizedName = sanitizeCsvCell(sanitizeText(newPropName.trim()));
            const sanitizedRooms = Math.max(1, Math.min(10000, Number(newPropRooms) || 100));
            await db.entities.Property.create({
                code: sanitizedCode,
                name: sanitizedName,
                rooms: sanitizedRooms,
                active: true,
            });
            setPropMsg(`Property "${sanitizedName}" added.`);
            setNewPropCode("");
            setNewPropName("");
            setNewPropRooms("100");
            refetchProps();
            queryClientInstance.invalidateQueries({ queryKey: ["properties"] });
            rotateCsrfToken();
        }
        catch (e) {
            setPropMsg(e.message || "Could not add property.");
        }
    };
    const handleDeleteProperty = async (id) => {
        const rateLimit = sensitiveActionRateLimiter.check();
        if (!rateLimit.allowed) {
            toast({ variant: "destructive", title: "Rate Limited", description: `Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.` });
            return;
        }
        const csrfToken = getCsrfToken();
        if (!validateCsrfToken(csrfToken)) {
            toast({ variant: "destructive", title: "Security Error", description: "Invalid security token. Please refresh the page and try again." });
            rotateCsrfToken();
            return;
        }
        try {
            // Cascade-delete every record referencing this property so no orphaned
            // rows silently appear in other properties' totals or the DB health checks.
            const propertyTables = [
                "OccupancyDay", "SourceDay", "GrossRevenueDay", "PaymentDay",
                "ClerkShiftRecord", "UploadedReport", "Expense", "PayrollRun", "Staff",
            ];
            for (const tableName of propertyTables) {
                try {
                    const rows = await db.entities[tableName].filter({ property_id: id }, "-created_date", 100000);
                    const ids = rows.map((r) => r.id).filter(Boolean);
                    if (ids.length)
                        await db.entities[tableName].bulkDelete(ids);
                }
                catch (e) {
                    // Some tables may not exist or have different schemas — continue.
                    if (!/does not exist/i.test(String(e.message)) && !/Unknown entity/i.test(String(e.message))) {
                        console.warn(`[settings] cleanup ${tableName}:`, e);
                    }
                }
            }
            await db.entities.Property.delete(id);
            setPropDeleteTarget(null);
            refetchProps();
            queryClientInstance.invalidateQueries({ queryKey: ["properties"] });
            queryClientInstance.invalidateQueries({ queryKey: ["occupancy"] });
            queryClientInstance.invalidateQueries({ queryKey: ["sources"] });
            queryClientInstance.invalidateQueries({ queryKey: ["gross"] });
            queryClientInstance.invalidateQueries({ queryKey: ["payments"] });
            queryClientInstance.invalidateQueries({ queryKey: ["expenses"] });
            queryClientInstance.invalidateQueries({ queryKey: ["payroll"] });
            rotateCsrfToken();
        }
        catch (e) {
            setPropMsg(e.message || "Could not delete property.");
        }
    };
    const handleDeleteAccount = async () => {
        setDeleting(true);
        setDeleteError("");
        try {
            await db.functions.invoke("deleteAccount", {});
            localStorage.removeItem("rri_commission_rates_v2");
            localStorage.removeItem("rri_cc_fee_rate");
            await db.auth.logout(true);
        }
        catch (e) {
            setDeleteError("Your account could not be deleted. You are still signed in, and no logout was performed.");
            setDeleting(false);
        }
    };
    // MFA self-service handlers
    const handleMfaEnable = async () => {
        const rateLimit = sensitiveActionRateLimiter.check();
        if (!rateLimit.allowed) {
            toast({ variant: "destructive", title: "Rate Limited", description: `Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.` });
            return;
        }
        const csrfToken = getCsrfToken();
        if (!validateCsrfToken(csrfToken)) {
            toast({ variant: "destructive", title: "Security Error", description: "Invalid security token. Please refresh the page and try again." });
            rotateCsrfToken();
            return;
        }
        try {
            const result = await db.users.enableMfa(me, me.id);
            setMfaSecret(result.secret);
            setMfaUri(result.uri);
            setMfaBackupCodes([]);
            setMfaAction('enable');
            setMfaSetupOpen(true);
        }
        catch (e) {
            toast({ variant: "destructive", title: "Error", description: e.message });
        }
    };
    const handleMfaDisable = async () => {
        const rateLimit = sensitiveActionRateLimiter.check();
        if (!rateLimit.allowed) {
            toast({ variant: "destructive", title: "Rate Limited", description: `Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.` });
            return;
        }
        const csrfToken = getCsrfToken();
        if (!validateCsrfToken(csrfToken)) {
            toast({ variant: "destructive", title: "Security Error", description: "Invalid security token. Please refresh the page and try again." });
            rotateCsrfToken();
            return;
        }
        try {
            await db.users.disableMfa(me, me.id);
            toast({ title: "MFA Disabled", description: "Two-factor authentication has been disabled for your account." });
        }
        catch (e) {
            toast({ variant: "destructive", title: "Error", description: e.message });
        }
    };
    const handleMfaSetupComplete = async (token, done) => {
        if (done) {
            setMfaSetupOpen(false);
            setMfaSecret(null);
            setMfaUri(null);
            setMfaBackupCodes([]);
            setMfaAction(null);
            return;
        }
        if (!token)
            return;
        setMfaVerifying(true);
        try {
            await db.users.verifyMfa(me, me.id, token);
            toast({ title: "MFA Enabled Successfully!", description: "Your account is now protected with two-factor authentication." });
            setMfaSetupOpen(false);
            setMfaSecret(null);
            setMfaUri(null);
            setMfaBackupCodes([]);
            setMfaAction(null);
        }
        catch (e) {
            toast({ variant: "destructive", title: "Invalid Code", description: e.message || "The code is incorrect or has expired." });
        }
        finally {
            setMfaVerifying(false);
        }
    };
    const handleMfaSetupCancel = () => {
        setMfaSetupOpen(false);
        setMfaSecret(null);
        setMfaUri(null);
        setMfaBackupCodes([]);
        setMfaAction(null);
    };
    // Render QR code when MFA dialog opens
    const qrCanvasRef = useRef(/** @type {HTMLCanvasElement | null} */ (null));
    useEffect(() => {
        if (mfaSetupOpen && mfaUri && qrCanvasRef.current) {
            import("qrcode").then(QRCode => {
                QRCode.default.toCanvas(qrCanvasRef.current, mfaUri, {
                    width: 200,
                    margin: 2,
                    color: { dark: '#000000', light: '#ffffff' }
                }).catch(console.error);
            });
        }
    }, [mfaSetupOpen, mfaUri]);
    const entries = Object.entries(rates).sort((a, b) => a[0].localeCompare(b[0]));
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("header", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]", children: "Configuration" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "Settings" }), _jsx("p", { className: "mt-1 text-sm text-slate-400", children: "Commission rates, alert thresholds, user access, and account management." })] }), _jsxs(Card, { title: "Source commission rates", subtitle: "Editable per-source \u2014 supports %, fixed $, actual, or none. Tax-exempt = OTA pre-deducts commission.", children: [_jsx("div", { className: "space-y-2", children: entries.map(([key, info]) => {
                            const r = info || { type: "none", rate: 0, taxExempt: false };
                            return (_jsxs("div", { className: "flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3", children: [_jsx("span", { className: "text-sm font-medium text-slate-200", children: key }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("select", { value: r.type, onChange: (e) => handleChange(key, "type", e.target.value), className: "h-8 rounded-lg border border-white/10 bg-[#040D1A] px-2 text-xs text-slate-200 outline-none focus:border-[#00D4FF]", children: COMMISSION_TYPES.map(([v, l]) => _jsx("option", { value: v, children: l }, v)) }), _jsx("input", { type: "number", min: "0", step: r.type === "percentage" ? "0.01" : "0.5", value: r.type === "percentage" ? Math.round((r.rate || 0) * 10000) / 100 : r.rate, disabled: r.type === "none", onChange: (e) => handleChange(key, "rate", e.target.value), className: "w-20 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-right text-sm text-slate-200 outline-none focus:border-[#00D4FF] disabled:opacity-30" }), _jsx("span", { className: "w-6 text-xs text-slate-500", children: r.type === "fixed" ? "$/rm" : r.type === "percentage" ? "%" : "" }), _jsx("button", { onClick: () => handleChange(key, "taxExempt", !r.taxExempt), className: `rounded-full px-2.5 py-1 text-[10px] font-medium transition-colors ${r.taxExempt ? "bg-[#00D4FF]/15 text-[#00D4FF]" : "bg-white/5 text-slate-500"}`, children: r.taxExempt ? "Exempt" : "Taxable" }), _jsx("button", { onClick: () => handleRemove(key), className: "text-slate-600 transition-colors hover:text-[#FF6B6B]", children: _jsx(Trash2, { className: "h-3.5 w-3.5" }) })] })] }, key));
                        }) }), _jsxs("div", { className: "mt-4 rounded-xl border border-white/5 bg-[#0A1628]/60 p-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-slate-200", children: "CC/Debit Card Processing Fee" }), _jsx("p", { className: "text-xs text-slate-500", children: "Applied to Visa, Mastercard, Amex, Discover charges and refunds" })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("input", { type: "number", min: "0", max: "10", step: "0.1", value: (ccFee * 100).toFixed(2), onChange: (e) => handleCcFeeChange(Number(e.target.value) / 100), className: "w-24 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-right text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsx("span", { className: "text-sm text-slate-400", children: "%" })] })] }), _jsxs("label", { className: "mt-3 flex items-center gap-2 text-sm text-slate-300", children: [_jsx("input", { type: "checkbox", checked: ccRefunds, onChange: (e) => setCcRefunds(e.target.checked), className: "h-4 w-4 rounded border-white/20" }), "Apply the processing fee to refunds too (refunds also incur the card fee)"] })] }), _jsxs("div", { className: "mt-4 flex gap-2", children: [_jsx("input", { type: "text", value: newSource, onChange: (e) => setNewSource(e.target.value), onKeyDown: (e) => e.key === "Enter" && handleAdd(), placeholder: "Add new source name\u2026", className: "flex-1 rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsxs("button", { onClick: handleAdd, className: "flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 transition-colors hover:border-[#6C63FF]/60 hover:text-white", children: [_jsx(Plus, { className: "h-4 w-4" }), " Add"] })] }), _jsxs("div", { className: "mt-4 flex gap-3", children: [_jsxs("button", { onClick: handleSave, className: "flex items-center gap-2 rounded-lg bg-[#6C63FF] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8]", children: [saved ? _jsx(CheckCircle2, { className: "h-4 w-4 text-[#00E096]" }) : _jsx(Save, { className: "h-4 w-4" }), saved ? "Saved!" : "Save Rates"] }), _jsxs("button", { onClick: handleReset, className: "flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2.5 text-sm text-slate-400 transition-colors hover:border-[#FF6B6B]/60 hover:text-[#FF6B6B]", children: [_jsx(RotateCcw, { className: "h-4 w-4" }), " Reset to defaults"] })] })] }), _jsxs(Card, { title: "Tax settings (per property)", subtitle: "State, city/local, and other tax rates with effective dates. Imported PMS tax lines are always used when available; these rates only estimate taxes when reports don't include them. New settings apply to future dates only.", children: [_jsxs("div", { className: "space-y-2", children: [taxRows.map((row, i) => (_jsxs("div", { className: "grid gap-2 rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3 sm:grid-cols-2 lg:grid-cols-7", children: [_jsxs("div", { className: "lg:col-span-2", children: [_jsx("label", { className: "mb-1 block text-[10px] uppercase tracking-widest text-slate-500", children: "Property" }), _jsxs("select", { value: row.property_id || "*", onChange: (e) => updateTaxRow(i, { property_id: e.target.value }), className: "w-full rounded-lg border border-white/10 bg-[#040D1A] px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-[#00D4FF]", children: [_jsx("option", { value: "*", children: "All properties (default)" }), properties.map((p) => (_jsx("option", { value: p.id, children: p.name }, p.id)))] })] }), [
                                        ["state_rate", "State Tax %"],
                                        ["city_rate", "City/Local Tax %"],
                                        ["other_rate", "Other Tax % (opt.)"],
                                    ].map(([key, label]) => (_jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-[10px] uppercase tracking-widest text-slate-500", children: label }), _jsx("input", { type: "number", min: "0", max: "50", step: "0.01", value: ((row[key] || 0) * 100).toFixed(2), onChange: (e) => updateTaxRow(i, { [key]: Number(e.target.value) / 100 }), className: "w-full rounded-lg border border-white/10 bg-[#040D1A] px-2 py-1.5 text-right text-xs text-slate-200 outline-none focus:border-[#00D4FF]" })] }, key))), _jsx("div", { className: "flex items-end", children: _jsxs("div", { className: "w-full rounded-lg border border-[#00D4FF]/30 bg-[#00D4FF]/10 px-3 py-2 text-center text-sm font-medium text-[#00D4FF]", children: ["Combined: ", (((row.state_rate || 0) + (row.city_rate || 0) + (row.other_rate || 0)) * 100).toFixed(2), "%"] }) }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-[10px] uppercase tracking-widest text-slate-500", children: "Effective Start" }), _jsx("input", { type: "date", value: row.effective_start || "", onChange: (e) => updateTaxRow(i, { effective_start: e.target.value }), className: "w-full rounded-lg border border-white/10 bg-[#040D1A] px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-[#00D4FF]" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-[10px] uppercase tracking-widest text-slate-500", children: "Effective End (opt.)" }), _jsx("input", { type: "date", value: row.effective_end || "", onChange: (e) => updateTaxRow(i, { effective_end: e.target.value }), className: "w-full rounded-lg border border-white/10 bg-[#040D1A] px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-[#00D4FF]" })] }), _jsx("div", { className: "flex items-end", children: _jsx("button", { onClick: () => removeTaxRow(i), className: "rounded-lg border border-white/10 p-2 text-slate-500 transition-colors hover:border-[#FF6B6B]/60 hover:text-[#FF6B6B]", title: "Remove this tax period", children: _jsx(Trash2, { className: "h-4 w-4" }) }) })] }, row._key || i))), !taxRows.length && (_jsx("p", { className: "text-sm text-slate-500", children: "No tax rates configured \u2014 taxes are estimated from the combined default rate until you add property-specific settings." }))] }), _jsxs("div", { className: "mt-4 flex flex-wrap items-center gap-3", children: [_jsxs("button", { onClick: addTaxRow, className: "flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2.5 text-sm text-slate-300 transition-colors hover:border-[#6C63FF]/60 hover:text-white", children: [_jsx(Plus, { className: "h-4 w-4" }), " Add tax period"] }), _jsxs("button", { onClick: handleSaveTax, className: "flex items-center gap-2 rounded-lg bg-[#6C63FF] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8]", children: [taxSaved ? _jsx(CheckCircle2, { className: "h-4 w-4 text-[#00E096]" }) : _jsx(Save, { className: "h-4 w-4" }), taxSaved ? "Saved!" : "Save Tax Settings"] }), _jsx("span", { className: "text-xs text-slate-500", children: "Changes are recorded in the audit log and update the Executive Hub instantly." })] })] }), _jsx(Card, { title: "Alert thresholds", subtitle: "Configure when revenue and occupancy drop alerts appear on the dashboard", children: _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { className: "flex items-center justify-between rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3", children: [_jsx("span", { className: "text-sm text-slate-200", children: "Revenue decrease alert" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("input", { type: "number", min: "0", max: "100", step: "1", value: (thresholds.revenueDecreasePct * 100).toFixed(0), onChange: (e) => setThresholds({ ...thresholds, revenueDecreasePct: Number(e.target.value) / 100 }), className: "w-20 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-right text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsx("span", { className: "text-sm text-slate-400", children: "% min drop" })] })] }), _jsxs("div", { className: "flex items-center justify-between rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3", children: [_jsx("span", { className: "text-sm text-slate-200", children: "Occupancy decrease alert" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("input", { type: "number", min: "0", max: "100", step: "1", value: (thresholds.occupancyDecreasePoints * 100).toFixed(0), onChange: (e) => setThresholds({ ...thresholds, occupancyDecreasePoints: Number(e.target.value) / 100 }), className: "w-20 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-right text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsx("span", { className: "text-sm text-slate-400", children: "pp min drop" })] })] }), _jsxs("div", { className: "flex items-center justify-between rounded-xl border border-[#FF6B6B]/15 bg-[#FF6B6B]/[0.04] px-4 py-3", children: [_jsx("span", { className: "text-sm text-slate-200", children: "Low occupancy threshold" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("input", { type: "number", min: "0", max: "100", step: "1", value: ((thresholds.occupancyThreshold ?? 0.60) * 100).toFixed(0), onChange: (e) => setThresholds({ ...thresholds, occupancyThreshold: Number(e.target.value) / 100 }), className: "w-20 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-right text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsx("span", { className: "text-sm text-slate-400", children: "% trigger" })] })] }), _jsxs("button", { onClick: handleSaveThresholds, className: "flex items-center gap-2 rounded-lg bg-[#6C63FF] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8]", children: [thresholdSaved ? _jsx(CheckCircle2, { className: "h-4 w-4 text-[#00E096]" }) : _jsx(Save, { className: "h-4 w-4" }), thresholdSaved ? "Saved!" : "Save Thresholds"] })] }) }), _jsx(Card, { title: "Revenue color thresholds", subtitle: "Used by Monthly Calendar and daily detail panel for revenue-based coloring", children: _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { className: "flex items-center justify-between rounded-xl border border-[#4ade80]/15 bg-[#4ade80]/[0.04] px-4 py-3", children: [_jsx("span", { className: "text-sm text-slate-200", children: "High revenue threshold (green)" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "text-sm text-slate-400", children: "$" }), _jsx("input", { type: "number", min: "0", step: "100", value: revThresholds.highRevenueThreshold, onChange: (e) => setRevThresholds({ ...revThresholds, highRevenueThreshold: Number(e.target.value) }), className: "w-24 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-right text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsx("span", { className: "text-sm text-slate-400", children: "+" })] })] }), _jsxs("div", { className: "flex items-center justify-between rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3", children: [_jsx("span", { className: "text-sm text-slate-200", children: "Medium revenue threshold (gray)" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "text-sm text-slate-400", children: "$" }), _jsx("input", { type: "number", min: "0", step: "100", value: revThresholds.mediumRevenueThreshold, onChange: (e) => setRevThresholds({ ...revThresholds, mediumRevenueThreshold: Number(e.target.value) }), className: "w-24 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-right text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsx("span", { className: "text-sm text-slate-400", children: "+" })] })] }), _jsxs("p", { className: "text-xs text-slate-500", children: ["Days with revenue \u2265 high threshold: ", _jsx("span", { className: "text-[#4ade80]", children: "green" }), " \u00B7 \u2265 medium: ", _jsx("span", { className: "text-slate-400", children: "gray" }), " \u00B7 below medium: ", _jsx("span", { className: "text-[#ff6b6b]", children: "red" })] }), _jsxs("button", { onClick: handleSaveRevThresholds, className: "flex items-center gap-2 rounded-lg bg-[#6C63FF] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8]", children: [revSaved ? _jsx(CheckCircle2, { className: "h-4 w-4 text-[#00E096]" }) : _jsx(Save, { className: "h-4 w-4" }), revSaved ? "Saved!" : "Save Revenue Thresholds"] })] }) }), _jsxs(Card, { title: "Property management", subtitle: "Add and manage hotel properties for multi-property reporting", children: [_jsxs("div", { className: "space-y-2", children: [properties.map((p) => (_jsxs("div", { className: "flex items-center justify-between rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Building2, { className: "h-4 w-4 text-[#6C63FF]" }), _jsxs("div", { children: [_jsx("p", { className: "text-sm text-white", children: p.name }), _jsxs("p", { className: "text-xs text-slate-500", children: [p.code, " \u00B7 ", p.rooms || 100, " rooms \u00B7 ", p.city || "", p.state ? `, ${p.state}` : ""] })] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: `rounded-full px-3 py-1 text-xs ${p.active ? "bg-[#00E096]/15 text-[#00E096]" : "bg-white/5 text-slate-500"}`, children: p.active ? "Active" : "Inactive" }), _jsx("button", { onClick: () => setPropDeleteTarget(p), className: "text-xs text-slate-500 transition-colors hover:text-[#FF6B6B]", children: "Remove" })] })] }, p.id))), !properties.length && _jsx("p", { className: "text-sm text-slate-500", children: "No properties yet. Add your first property below." })] }), _jsx(AlertDialog, { open: !!propDeleteTarget, onOpenChange: (open) => { if (!open)
                            setPropDeleteTarget(null); }, children: _jsxs(AlertDialogContent, { className: "border-white/10 bg-[#0F1F35]", children: [_jsxs(AlertDialogHeader, { children: [_jsxs(AlertDialogTitle, { className: "text-white", children: ["Remove property \u201C", propDeleteTarget?.name, "\u201D?"] }), _jsxs(AlertDialogDescription, { className: "text-slate-400", children: ["This permanently deletes the property and ", _jsx("span", { className: "text-[#FF6B6B]", children: "all" }), " of its imported report rows (occupancy, sources, gross revenue, payments, clerk records, expenses, payroll, and uploaded report history). This cannot be undone."] }), propMsg.includes("Could not delete") && _jsx("p", { className: "text-sm text-[#FF6B6B]", children: propMsg })] }), _jsxs(AlertDialogFooter, { children: [_jsx(AlertDialogCancel, { className: "border-white/10 bg-[#0A1628] text-slate-300 hover:bg-[#1a2a40] hover:text-white", children: "Cancel" }), _jsx(AlertDialogAction, { onClick: () => propDeleteTarget && handleDeleteProperty(propDeleteTarget.id), className: "bg-[#FF6B6B] text-white hover:bg-[#e55555]", children: "Yes, delete everything for this property" })] })] }) }), _jsxs("div", { className: "mt-4 grid gap-2 sm:grid-cols-4", children: [_jsx("input", { type: "text", value: newPropCode, onChange: (e) => setNewPropCode(e.target.value), placeholder: "Code (e.g. RRI1416)", className: "rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsx("input", { type: "text", value: newPropName, onChange: (e) => setNewPropName(e.target.value), placeholder: "Property name", className: "sm:col-span-2 rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsx("input", { type: "number", min: "1", value: newPropRooms, onChange: (e) => setNewPropRooms(e.target.value), placeholder: "Rooms", className: "rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" })] }), _jsxs("div", { className: "mt-3 flex items-center gap-3", children: [_jsxs("button", { onClick: handleAddProperty, disabled: !newPropCode.trim() || !newPropName.trim(), className: "flex items-center gap-2 rounded-lg bg-[#6C63FF] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8] disabled:opacity-50", children: [_jsx(Plus, { className: "h-4 w-4" }), " Add Property"] }), _jsxs("button", { onClick: () => { refetchProps(); queryClientInstance.invalidateQueries({ queryKey: ["properties"] }); }, className: "flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2.5 text-sm text-slate-400 transition-colors hover:border-[#00D4FF]/60 hover:text-white", children: [_jsx(RefreshCw, { className: "h-4 w-4" }), " Refresh"] }), propMsg && _jsx("span", { className: "text-sm text-[#00E096]", children: propMsg })] })] }), _jsx(Card, { title: "User management", subtitle: "Create accounts, assign roles, permissions, and property access", children: _jsxs("div", { className: "space-y-3", children: [_jsx("p", { className: "text-sm text-slate-400", children: "Manage logins, roles, permissions, and property-level access from the User Management page." }), _jsxs(Link, { to: "/users", className: "inline-flex items-center gap-2 rounded-lg bg-[#6C63FF] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8]", children: [_jsx(UserCog, { className: "h-4 w-4" }), " Open User Management"] })] }) }), _jsx(Card, { title: "My account", subtitle: "Your profile, role, session, and security", children: me && (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "flex items-center gap-3 rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3", children: [_jsx("div", { className: "flex h-11 w-11 items-center justify-center rounded-full bg-[#6C63FF]/30 text-base font-bold text-white", children: (me.full_name || me.username || "?").slice(0, 1).toUpperCase() }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-white", children: me.full_name || me.username }), _jsx("p", { className: "text-xs text-slate-400", children: me.email }), _jsx("p", { className: "mt-0.5 text-[10px] uppercase tracking-wide text-[#6C63FF]", children: me.role?.replace("_", " ") || "user" })] })] }), _jsx("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-4", children: _jsxs("div", { className: "flex items-center justify-between mb-4", children: [_jsxs("div", { className: "flex items-center gap-3", children: [me.mfa_enabled ? (_jsx(Shield, { className: "h-5 w-5 text-emerald-400" })) : (_jsx(ShieldOff, { className: "h-5 w-5 text-slate-500" })), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-white", children: "Two-Factor Authentication" }), _jsx("p", { className: "text-xs text-slate-500", children: me.mfa_enabled
                                                            ? "MFA is enabled. You'll need your authenticator app to log in."
                                                            : "Add an extra layer of security to your account." })] })] }), me.mfa_enabled ? (_jsx("button", { onClick: handleMfaDisable, className: "text-sm text-amber-400 hover:text-amber-300 transition-colors", children: "Disable MFA" })) : (_jsxs("button", { onClick: handleMfaEnable, className: "inline-flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-3 py-1.5 text-sm font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20", children: [_jsx(Shield, { className: "h-3.5 w-3.5" }), " Enable MFA"] }))] }) }), _jsxs("div", { className: "flex flex-wrap gap-2", children: [_jsxs(Link, { to: "/change-password", className: "inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2.5 text-sm text-slate-300 transition-colors hover:border-[#6C63FF]/60 hover:text-white", children: [_jsx(Key, { className: "h-3.5 w-3.5" }), " Change Password"] }), _jsxs("button", { onClick: () => logout(true), className: "inline-flex items-center gap-2 rounded-lg border border-[#FF6B6B]/30 bg-[#FF6B6B]/10 px-4 py-2.5 text-sm font-medium text-[#FF6B6B] transition-colors hover:bg-[#FF6B6B]/20", children: [_jsx(LogOut, { className: "h-4 w-4" }), " Log out"] })] })] })) }), _jsx(Card, { title: "Account management", subtitle: "Permanently delete your account and all associated data", children: _jsxs(AlertDialog, { children: [_jsx(AlertDialogTrigger, { asChild: true, children: _jsxs("button", { className: "flex items-center gap-2 rounded-lg border border-[#FF6B6B]/30 bg-[#FF6B6B]/10 px-4 py-2.5 text-sm font-medium text-[#FF6B6B] transition-colors hover:bg-[#FF6B6B]/20", children: [_jsx(Trash2, { className: "h-4 w-4" }), " Delete Account"] }) }), _jsxs(AlertDialogContent, { className: "border-white/10 bg-[#0F1F35]", children: [_jsxs(AlertDialogHeader, { children: [_jsx(AlertDialogTitle, { className: "text-white", children: "Delete Account?" }), _jsx(AlertDialogDescription, { className: "text-slate-400", children: "This will permanently delete your account and all associated data including imported reports, occupancy records, revenue figures, clerk shift logs, and commission settings. This action cannot be undone. You will lose access to all historical hotel data and analytics." }), _jsx("input", { type: "text", value: deletePhrase, onChange: (e) => setDeletePhrase(e.target.value), placeholder: "Type DELETE to confirm", className: "mt-3 w-full rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#FF6B6B]" }), deleteError && _jsx("p", { className: "mt-2 text-sm text-[#FF6B6B]", children: deleteError })] }), _jsxs(AlertDialogFooter, { children: [_jsx(AlertDialogCancel, { className: "border-white/10 bg-[#0A1628] text-slate-300 hover:bg-[#1a2a40] hover:text-white", children: "Cancel" }), _jsx(AlertDialogAction, { onClick: handleDeleteAccount, disabled: deletePhrase !== "DELETE" || deleting, className: "bg-[#FF6B6B] text-white hover:bg-[#e55555] disabled:opacity-50", children: deleting ? "Deleting…" : "Yes, delete everything" })] })] })] }) }), mfaSetupOpen && mfaSecret && mfaUri && (_jsx("div", { className: "fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50", children: _jsx("div", { className: "w-full max-w-md bg-[#0F1F35] rounded-xl border border-white/10 overflow-hidden", children: _jsxs("div", { className: "p-6 space-y-6", children: [_jsx("div", { className: "text-center", children: mfaAction === 'enable' && (_jsxs(_Fragment, { children: [_jsx("div", { className: "mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10", children: _jsx(Shield, { className: "h-6 w-6 text-emerald-400" }) }), _jsx("h3", { className: "text-lg font-semibold text-white", children: "Set Up Authenticator App" }), _jsx("p", { className: "mt-1 text-sm text-slate-400", children: "Scan the QR code to enable two-factor authentication" })] })) }), _jsxs("div", { className: "space-y-4", children: [_jsx("div", { className: "flex justify-center", children: _jsx("div", { className: "bg-white p-4 rounded-lg border", children: _jsx("canvas", { ref: qrCanvasRef, className: "mx-auto" }) }) }), _jsxs("div", { className: "text-center text-sm", children: [_jsx("p", { className: "text-muted-foreground", children: "Or enter this secret key manually:" }), _jsx("code", { className: "block mt-1 font-mono text-xs text-slate-300 bg-slate-800 px-2 py-1 rounded break-all", children: mfaSecret })] }), _jsx(Alert, { className: "border-amber-500/30 bg-amber-500/10", children: _jsxs(AlertDescription, { className: "text-sm flex items-center gap-2", children: [_jsx("span", { className: "flex-shrink-0", children: "\u26A0" }), _jsx("strong", { children: "Save backup codes!" }), " You'll receive 10 one-time backup codes after verification. Store them securely \u2014 each can only be used once."] }) }), _jsxs("div", { className: "space-y-3", children: [_jsx(Label, { htmlFor: "mfa-token", className: "text-sm font-medium", children: "Enter the 6-digit code from your app" }), _jsxs("div", { className: "relative", children: [_jsx(Smartphone, { className: "absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground", "aria-hidden": "true" }), _jsx(Input, { id: "mfa-token", type: "text", inputMode: "numeric", pattern: "[0-9]*", maxLength: 6, placeholder: "000000", onChange: (e) => {
                                                            const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                                                            if (val.length === 6)
                                                                handleMfaSetupComplete(val);
                                                        }, className: "h-12 pl-10 text-2xl tracking-widest text-center", autoFocus: true, autoComplete: "one-time-code", disabled: mfaVerifying })] }), _jsx(Button, { className: "w-full h-12", onClick: () => { }, disabled: mfaVerifying, children: mfaVerifying ? (_jsxs(_Fragment, { children: [_jsx(Loader2, { className: "mr-2 h-4 w-4 animate-spin" }), "Verifying..."] })) : ("Verify & Enable MFA") })] }), _jsx(Button, { variant: "outline", className: "w-full", onClick: handleMfaSetupCancel, children: "Cancel" })] })] }) }) }))] }));
}
