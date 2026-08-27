import { db } from '@/api/base44Client';

import React, { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Save, Plus, CheckCircle2, RotateCcw, Trash2, Building2, RefreshCw, UserCog, LogOut, Shield, ShieldOff, Key, Smartphone, Download, Upload, Database } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { ErrorState } from "@/components/ui/status";
import { getCommissionRates, setCommissionRates, getCcFeeRate, setCcFeeRate, getCcFeeOnRefunds, setCcFeeOnRefunds, COMMISSION_TYPES } from "@/lib/commissionRates";
import { getAlertThresholds, saveAlertThresholds } from "@/lib/alertThresholds";
import { getRevenueThresholds, saveRevenueThresholds } from "@/lib/revenueThresholds";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { getTaxSettings, saveTaxSettings } from "@/lib/taxSettings";
import { toast } from "@/components/ui/use-toast";

import { useAuth } from "@/lib/AuthContext";
import { useProperties } from "@/lib/useHotelData";
import { queryClientInstance } from "@/lib/query-client";
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { getCsrfToken, sensitiveActionRateLimiter, validateCsrfToken, rotateCsrfToken, sanitizeText, sanitizeAlphanumeric, sanitizeCsvCell } from "@/lib/securityUtils";
import { ARCHIVE_FILE_EXT, downloadArchive, inspectArchiveFile, parseArchive, restoreArchive } from "@/lib/dbArchive";
import { hasAllPropertyAccess } from "@/lib/launchPolicy";
import PasswordConfirmDialog from "@/components/PasswordConfirmDialog";

export default function Settings() {
  const { user: me, logout } = useAuth();
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
  // Query OBJECT kept alongside the data: propertiesQ.isError drives the banner
  // above. `?? []` instead of `= []` so a failure is never laundered into an
  // ordinary empty list.
  const propertiesQ = useProperties();
  const properties = propertiesQ.data ?? [];
  const refetchProps = propertiesQ.refetch;
  const [newPropCode, setNewPropCode] = useState("");
  const [newPropName, setNewPropName] = useState("");
  const [newPropRooms, setNewPropRooms] = useState("100");
  const [propMsg, setPropMsg] = useState("");
  const [propDeleteTarget, setPropDeleteTarget] = useState(null);
  
  // MFA self-service state
  const [mfaSetupOpen, setMfaSetupOpen] = useState(false);
  const [mfaSecret, setMfaSecret] = useState(null);
  const [mfaUri, setMfaUri] = useState(null);
  const [, setMfaBackupCodes] = useState([]);
  const [mfaVerifying, setMfaVerifying] = useState(false);
  const [mfaAction, setMfaAction] = useState(null); // 'enable' | 'disable'
  // Step-up prompt for MFA changes: { kind: 'enable' | 'disable', busy, error }.
  // The typed password lives inside PasswordConfirmDialog and is handed to the
  // run* function directly — it is never lifted into this page's state.
  const [pwPrompt, setPwPrompt] = useState(null);

  // Backup & restore. `restorePlan` holds the PARSED archive rather than the raw
  // file, so the summary the operator confirms against is the file's verified
  // contents — row counts, export date, checksum — and not just its name.
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restorePlan, setRestorePlan] = useState(null);
  const [restoreError, setRestoreError] = useState("");
  const [restorePhrase, setRestorePhrase] = useState("");
  const restoreInputRef = useRef(null);

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
    } else {
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
    const stored = [
      setCommissionRates(rates),
      setCcFeeRate(ccFee),
      setCcFeeOnRefunds(ccRefunds),
    ].every(Boolean);
    if (!stored) {
      // The write was refused by the browser, so the PREVIOUS rates are still
      // what every net-revenue figure in the app is computed from. Showing the
      // "Saved" tick here is how an owner ends up billing commission at a rate
      // they replaced weeks ago. Nothing to audit-log either: nothing changed.
      toast({
        variant: "destructive",
        title: "Not saved",
        description: "The browser refused to store these rates, so the previous commission and card-fee rates are still in effect and will come back when you reload. Storage may be full, or this window may be in private browsing. See the browser console for the exact key.",
      });
      rotateCsrfToken();
      return;
    }
    try {
      await db.audit.log({
        username: me?.username || "settings",
        action: "Commission rates updated",
        detail: `${Object.keys(rates).length} source rate(s) · CC fee ${(ccFee * 100).toFixed(2)}% · fee on refunds ${ccRefunds ? "on" : "off"}`,
      });
    } catch (e) {
      // The rates are already applied at this point, so this is not a failed
      // save — it is an unlogged one. Commission and CC-fee rates change every
      // net-revenue figure in the app, so an operator has to know the change
      // exists but has no audit trail behind it.
      toast({
        variant: "destructive",
        title: "Saved, but not logged",
        description: `The new commission rates are in effect, but the audit log entry could not be written (${e?.message || e}). Note the change manually — Audit Log will not show it.`,
      });
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
    if (!saveTaxSettings(clean)) {
      toast({
        variant: "destructive",
        title: "Not saved",
        description: "The browser refused to store these tax periods, so the previous rates are still what every tax figure is computed from and will come back when you reload. Storage may be full, or this window may be in private browsing. See the browser console for the exact key.",
      });
      rotateCsrfToken();
      return;
    }
    try {
      await db.audit.log({
        username: me?.username || "settings",
        action: "Tax settings updated",
        detail: `${clean.length} tax period(s): ${clean
          .map((r) => `${r.property_id || "*"} S${((r.state_rate || 0) * 100).toFixed(2)}% C${((r.city_rate || 0) * 100).toFixed(2)}% O${((r.other_rate || 0) * 100).toFixed(2)}% (${r.effective_start || "open"}${r.effective_end ? ` → ${r.effective_end}` : ""})`)
          .join("; ")}`,
      });
    } catch (e) {
      // Same shape as the commission-rate save above: the tax periods are
      // already persisted, so the defect is the missing audit row. Tax rates
      // change every tax figure the property reports, so an unlogged change here
      // is the one an accountant would most want to trace.
      toast({
        variant: "destructive",
        title: "Saved, but not logged",
        description: `The new tax settings are in effect, but the audit log entry could not be written (${e?.message || e}). Note the change manually — Audit Log will not show it.`,
      });
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

  const handleBackupDownload = async () => {
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
    setBackupBusy(true);
    try {
      const res = await downloadArchive();
      toast({
        title: "Backup downloaded",
        description: `${res.total_rows.toLocaleString()} record(s) from ${res.stores} table(s), plus ${res.local_slots} setting(s), saved as ${res.filename}. Keep a copy somewhere other than this computer.`,
      });
      try {
        await db.audit.log({
          username: me?.username || "settings",
          action: "Database backup exported",
          detail: `${res.filename} · ${res.total_rows} row(s) · ${res.stores} table(s) · ${res.local_slots} setting(s) · ${Math.round(res.bytes / 1024)} KB`,
        });
      } catch (e) {
        // The file is already on disk, so this is not a failed export — it is an
        // unlogged one. A copy of the entire database leaving the machine is
        // exactly the event an audit trail exists to record, so say so plainly.
        toast({
          variant: "destructive",
          title: "Downloaded, but not logged",
          description: `The backup file was created, but the audit log entry could not be written (${e?.message || e}). A full copy of the database left this browser with no record of it.`,
        });
      }
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Backup failed",
        description: `${e?.message || e} No file was written — do not treat this as a backup.`,
      });
    } finally {
      setBackupBusy(false);
      rotateCsrfToken();
    }
  };

  const handleRestoreFile = async (event) => {
    const file = event.target?.files?.[0];
    // Cleared immediately so picking the SAME file again still fires `change`.
    // Without this, correcting a mistake by re-choosing the same file does
    // nothing and looks like the button is broken.
    if (event.target) event.target.value = "";
    setRestorePlan(null);
    setRestorePhrase("");
    setRestoreError("");
    if (!file) return;
    const gate = inspectArchiveFile(file);
    if (!gate.ok) {
      setRestoreError(gate.reason);
      return;
    }
    setRestoreBusy(true);
    try {
      // parseArchive validates the whole file — format, version, checksum, per
      // table row counts — and touches nothing. Everything below this point is
      // shown to the operator BEFORE any data is replaced.
      const parsed = await parseArchive(await file.text());
      setRestorePlan({ filename: file.name, parsed });
    } catch (e) {
      setRestoreError(e?.message || String(e));
    } finally {
      setRestoreBusy(false);
    }
  };

  const handleRestoreConfirm = async () => {
    if (!restorePlan) return;
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
    setRestoreBusy(true);
    setRestoreError("");
    try {
      const res = await restoreArchive(restorePlan.parsed, { confirm: "REPLACE" });
      try {
        // Logged AFTER the restore, deliberately. The AuditLog table was just
        // replaced by the backup's rows, so an entry written beforehand would
        // have been erased by the very action it records. Written afterwards it
        // appends to the restored hash chain and survives.
        await db.audit.log({
          username: me?.username || "settings",
          action: "Database restored from backup",
          detail: `${restorePlan.filename} · exported ${res.exported_at || "unknown"} · ${res.total_rows} row(s) into ${res.stores} table(s) · ${res.local_slots} setting(s) · checksum ${String(res.checksum || "").slice(0, 12)}`,
        });
      } catch {
        // The restore itself succeeded and the operator is about to be signed
        // out; a missing log line must not read as a failed restore.
      }
      queryClientInstance.clear();
      toast({
        title: "Database restored",
        description: `${res.total_rows.toLocaleString()} record(s) restored.${res.warnings.length ? ` ${res.warnings.join(" ")}` : ""} Signing you out so the app reloads against the restored data.`,
      });
      setRestorePlan(null);
      setRestorePhrase("");
      // The signed-in account came out of the database that was just replaced —
      // its row may not exist any more, or may have a different password. A hard
      // navigation is the only way to be certain nothing in memory still refers
      // to rows that are gone.
      await logout(false);
      window.location.replace("/login");
    } catch (e) {
      setRestoreError(`${e?.message || e} Your existing data was left unchanged.`);
      setRestoreBusy(false);
    }
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
    if (!saveAlertThresholds(thresholds)) {
      toast({
        variant: "destructive",
        title: "Not saved",
        description: "The browser refused to store these alert thresholds, so the previous ones are still in effect. Storage may be full, or this window may be in private browsing.",
      });
      rotateCsrfToken();
      return;
    }
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
    if (!saveRevenueThresholds(revThresholds)) {
      toast({
        variant: "destructive",
        title: "Not saved",
        description: "The browser refused to store these revenue bands, so the previous ones are still in effect. Storage may be full, or this window may be in private browsing.",
      });
      rotateCsrfToken();
      return;
    }
    setRevSaved(true);
    setTimeout(() => setRevSaved(false), 2000);
    rotateCsrfToken();
  };

  const handleAddProperty = async () => {
    if (!newPropCode.trim() || !newPropName.trim()) return;
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
      const existing = await db.entities.Property.filter({ code: sanitizedCode });
      if (existing.length > 0) {
        setPropMsg("A property with this code already exists.");
        return;
      }
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
    } catch (e) {
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
          if (ids.length) await db.entities[tableName].bulkDelete(ids);
        } catch (e) {
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
    } catch (e) {
      setPropMsg(e.message || "Could not delete property.");
    }
  };

  const handleDeleteAccount = async () => {
    setDeleting(true);
    setDeleteError("");
    try {
      // Destructive action: pass the server-mandated confirmation token
      // ("DELETE:<userId>") so a stray/replayed call can never trigger the wipe.
      // Only an active Owner/Admin is permitted (enforced in functions.invoke).
      const confirmToken = `DELETE:${me?.id ?? ""}`;
      await db.functions.invoke("deleteAccount", { confirm: confirmToken });
      // No local cleanup here on purpose: invokeBackend() in base44Client.js
      // (PROTECTED) already clears every Dexie table AND localStorage on a
      // successful deleteAccount, on both dispatch routes. Two removeItem calls
      // used to sit here; they could not help, they named 2 of the 3 keys that
      // one settings module owns, and being unguarded they could throw into the
      // catch below and report a FAILED deletion after the account was gone.
      //
      // logout() is the AuthContext one (destructured at the top of this
      // component), whose parameter is a boolean `shouldRedirect` — the same
      // call the three other logout sites in this file make. db.auth.logout()
      // takes a redirect URL instead, so the previous `db.auth.logout(true)`
      // assigned `window.location.href = true` and sent a just-deleted account
      // to <origin>/true. See BRAIN_TROUBLESHOOTING section 36.
      await logout(true);
    } catch (e) {
      setDeleteError(e?.message || "Your account could not be deleted. You are still signed in, and no logout was performed.");
      setDeleting(false);
    }
  };

  // MFA self-service handlers
  //
  // Both actions are step-up operations on the server (custom_user_admin
  // enable_mfa/disable_mfa call assertActorPassword), so the flow is: local
  // rate-limit + CSRF pre-checks -> collect the actor's own password -> invoke.
  // The pre-checks run BEFORE the prompt so a rate-limited operator is told so
  // instead of typing a password that was never going to be sent.
  const mfaPreflight = () => {
    const rateLimit = sensitiveActionRateLimiter.check();
    if (!rateLimit.allowed) {
      toast({ variant: "destructive", title: "Rate Limited", description: `Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.` });
      return false;
    }
    const csrfToken = getCsrfToken();
    if (!validateCsrfToken(csrfToken)) {
      toast({ variant: "destructive", title: "Security Error", description: "Invalid security token. Please refresh the page and try again." });
      rotateCsrfToken();
      return false;
    }
    return true;
  };

  const runMfaEnable = async (currentPassword) => {
    setPwPrompt((p) => (p ? { ...p, busy: true, error: null } : p));
    try {
      const result = await db.users.enableMfa(me, me.id, currentPassword);
      setPwPrompt(null);
      setMfaSecret(result.secret);
      setMfaUri(result.uri);
      setMfaBackupCodes([]);
      setMfaAction('enable');
      setMfaSetupOpen(true);
    } catch (e) {
      // A refused password has to stay in the dialog so it can be retyped; any
      // other failure is not something the dialog can help with, so it closes
      // and reports through the normal toast channel.
      const message = e?.message || "Two-factor authentication could not be enabled.";
      if (currentPassword !== undefined && /password/i.test(message)) {
        setPwPrompt((p) => (p ? { ...p, busy: false, error: message } : p));
        return;
      }
      setPwPrompt(null);
      toast({ variant: "destructive", title: "Error", description: message });
    }
  };

  const handleMfaEnable = () => {
    if (!mfaPreflight()) return;
    // Enrolling for the first time needs no password; ROTATING a live factor
    // does, because that action replaces a secret the account is currently
    // protected by. The server decides either way — this only avoids asking for
    // a password that would be ignored.
    if (me.mfa_enabled) {
      setPwPrompt({ kind: 'enable', busy: false, error: null });
      return;
    }
    runMfaEnable(undefined);
  };

  const runMfaDisable = async (currentPassword) => {
    setPwPrompt((p) => (p ? { ...p, busy: true, error: null } : p));
    try {
      await db.users.disableMfa(me, me.id, currentPassword);
      setPwPrompt(null);
      // The server revokes EVERY session for the account here, this tab's
      // included. Staying on the page would leave a signed-in-looking UI whose
      // next request 401s, so end the session locally too and say why.
      toast({ title: "MFA Disabled", description: "Two-factor authentication is off and every session was signed out. Please log in again." });
      await logout(true);
    } catch (e) {
      const message = e?.message || "Two-factor authentication could not be disabled.";
      if (/password/i.test(message)) {
        setPwPrompt((p) => (p ? { ...p, busy: false, error: message } : p));
        return;
      }
      setPwPrompt(null);
      toast({ variant: "destructive", title: "Error", description: message });
    }
  };

  const handleMfaDisable = () => {
    if (!mfaPreflight()) return;
    setPwPrompt({ kind: 'disable', busy: false, error: null });
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
    if (!token) return;
    setMfaVerifying(true);
    try {
      await db.users.verifyMfa(me, me.id, token);
      toast({ title: "MFA Enabled Successfully!", description: "Your account is now protected with two-factor authentication." });
      setMfaSetupOpen(false);
      setMfaSecret(null);
      setMfaUri(null);
      setMfaBackupCodes([]);
      setMfaAction(null);
    } catch (e) {
      toast({ variant: "destructive", title: "Invalid Code", description: e.message || "The code is incorrect or has expired." });
    } finally {
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
  const [qrError, setQrError] = useState(null);
  useEffect(() => {
    if (mfaSetupOpen && mfaUri && qrCanvasRef.current) {
      setQrError(null);
      // Both failure paths used to end in console.error or nothing at all: the
      // dialog kept saying "Scan the QR code" over a blank canvas, and the
      // operator had no way to know the code was never drawn. The manual secret
      // below still works, so say to use it.
      import("qrcode").then(QRCode => {
        QRCode.default.toCanvas(qrCanvasRef.current, mfaUri, {
          width: 200,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' }
        }).catch((e) => setQrError(e?.message || String(e)));
      }).catch((e) => setQrError(e?.message || String(e)));
    }
  }, [mfaSetupOpen, mfaUri]);

  const entries = Object.entries(rates).sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Configuration</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Settings</h1>
        <p className="mt-1 text-sm text-slate-400">
          Commission rates, alert thresholds, user access, and account management.
        </p>
      </header>

      {/* A failed property read is surfaced, not swallowed. The dropdown below
          would otherwise show only "All properties (default)" and read as a
          single-property install — and a new property added from this page while
          the list is broken would appear to vanish the moment it saved. */}
      {propertiesQ.isError && (
        <ErrorState
          title="Properties could not be loaded"
          description="Property-scoped settings and the property management list below may be incomplete until this loads."
          error={propertiesQ.error}
          onRetry={refetchProps}
        />
      )}

      <Card title="Source commission rates" subtitle="Editable per-source — supports %, fixed $, actual, or none. Tax-exempt = OTA pre-deducts commission.">
        <div className="space-y-2">
          {entries.map(([key, info]) => {
            const r = info || { type: "none", rate: 0, taxExempt: false };
            return (
              <div key={key} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3">
                <span className="text-sm font-medium text-slate-200">{key}</span>
                <div className="flex items-center gap-2">
                  <select
                    value={r.type}
                    onChange={(e) => handleChange(key, "type", e.target.value)}
                    className="h-8 rounded-lg border border-white/10 bg-[#040D1A] px-2 text-xs text-slate-200 outline-none focus:border-[#00D4FF]"
                  >
                    {COMMISSION_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <input
                    type="number"
                    min="0"
                    step={r.type === "percentage" ? "0.01" : "0.5"}
                    value={r.type === "percentage" ? Math.round((r.rate || 0) * 10000) / 100 : r.rate}
                    disabled={r.type === "none"}
                    onChange={(e) => handleChange(key, "rate", e.target.value)}
                    className="w-20 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-right text-sm text-slate-200 outline-none focus:border-[#00D4FF] disabled:opacity-30"
                  />
                  <span className="w-6 text-xs text-slate-500">{r.type === "fixed" ? "$/rm" : r.type === "percentage" ? "%" : ""}</span>
                  <button
                    onClick={() => handleChange(key, "taxExempt", !r.taxExempt)}
                    className={`rounded-full px-2.5 py-1 text-[10px] font-medium transition-colors ${r.taxExempt ? "bg-[#00D4FF]/15 text-[#00D4FF]" : "bg-white/5 text-slate-500"}`}
                  >
                    {r.taxExempt ? "Exempt" : "Taxable"}
                  </button>
                  <button onClick={() => handleRemove(key)} className="text-slate-600 transition-colors hover:text-[#FF6B6B]">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-200">CC/Debit Card Processing Fee</p>
              <p className="text-xs text-slate-500">Applied to Visa, Mastercard, Amex, Discover charges and refunds</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                max="10"
                step="0.1"
                value={(ccFee * 100).toFixed(2)}
                onChange={(e) => handleCcFeeChange(Number(e.target.value) / 100)}
                className="w-24 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-right text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
              />
              <span className="text-sm text-slate-400">%</span>
            </div>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={ccRefunds}
              onChange={(e) => setCcRefunds(e.target.checked)}
              className="h-4 w-4 rounded border-white/20"
            />
            Apply the processing fee to refunds too (refunds also incur the card fee)
          </label>
        </div>

        <div className="mt-4 flex gap-2">
          <input
            type="text"
            value={newSource}
            onChange={(e) => setNewSource(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder="Add new source name…"
            className="flex-1 rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
          />
          <button
            onClick={handleAdd}
            className="flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 transition-colors hover:border-[#6C63FF]/60 hover:text-white"
          >
            <Plus className="h-4 w-4" /> Add
          </button>
        </div>

        <div className="mt-4 flex gap-3">
          <button
            onClick={handleSave}
            className="flex items-center gap-2 rounded-lg bg-[#6C63FF] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8]"
          >
            {saved ? <CheckCircle2 className="h-4 w-4 text-[#00E096]" /> : <Save className="h-4 w-4" />}
            {saved ? "Saved!" : "Save Rates"}
          </button>
          <button
            onClick={handleReset}
            className="flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2.5 text-sm text-slate-400 transition-colors hover:border-[#FF6B6B]/60 hover:text-[#FF6B6B]"
          >
            <RotateCcw className="h-4 w-4" /> Reset to defaults
          </button>
        </div>
      </Card>

      <Card title="Tax settings (per property)" subtitle="State, city/local, and other tax rates with effective dates. Imported PMS tax lines are always used when available; these rates only estimate taxes when reports don't include them. New settings apply to future dates only.">
        <div className="space-y-2">
          {taxRows.map((row, i) => (
            <div
              key={row._key || i}
              className="grid gap-2 rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3 sm:grid-cols-2 lg:grid-cols-7"
            >
              <div className="lg:col-span-2">
                <label className="mb-1 block text-[10px] uppercase tracking-widest text-slate-500">Property</label>
                <select
                  value={row.property_id || "*"}
                  onChange={(e) => updateTaxRow(i, { property_id: e.target.value })}
                  className="w-full rounded-lg border border-white/10 bg-[#040D1A] px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-[#00D4FF]"
                >
                  <option value="*">All properties (default)</option>
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              {[
                ["state_rate", "State Tax %"],
                ["city_rate", "City/Local Tax %"],
                ["other_rate", "Other Tax % (opt.)"],
              ].map(([key, label]) => (
                <div key={key}>
                  <label className="mb-1 block text-[10px] uppercase tracking-widest text-slate-500">{label}</label>
                  <input
                    type="number"
                    min="0"
                    max="50"
                    step="0.01"
                    value={((row[key] || 0) * 100).toFixed(2)}
                    onChange={(e) => updateTaxRow(i, { [key]: Number(e.target.value) / 100 })}
                    className="w-full rounded-lg border border-white/10 bg-[#040D1A] px-2 py-1.5 text-right text-xs text-slate-200 outline-none focus:border-[#00D4FF]"
                  />
                </div>
              ))}
              <div className="flex items-end">
                <div className="w-full rounded-lg border border-[#00D4FF]/30 bg-[#00D4FF]/10 px-3 py-2 text-center text-sm font-medium text-[#00D4FF]">
                  Combined: {(((row.state_rate || 0) + (row.city_rate || 0) + (row.other_rate || 0)) * 100).toFixed(2)}%
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-widest text-slate-500">Effective Start</label>
                <input
                  type="date"
                  value={row.effective_start || ""}
                  onChange={(e) => updateTaxRow(i, { effective_start: e.target.value })}
                  className="w-full rounded-lg border border-white/10 bg-[#040D1A] px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-[#00D4FF]"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-widest text-slate-500">Effective End (opt.)</label>
                <input
                  type="date"
                  value={row.effective_end || ""}
                  onChange={(e) => updateTaxRow(i, { effective_end: e.target.value })}
                  className="w-full rounded-lg border border-white/10 bg-[#040D1A] px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-[#00D4FF]"
                />
              </div>
              <div className="flex items-end">
                <button
                  onClick={() => removeTaxRow(i)}
                  className="rounded-lg border border-white/10 p-2 text-slate-500 transition-colors hover:border-[#FF6B6B]/60 hover:text-[#FF6B6B]"
                  title="Remove this tax period"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
          {!taxRows.length && (
            <p className="text-sm text-slate-500">
              No tax rates configured — taxes are estimated from the combined default rate until you add property-specific settings.
            </p>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={addTaxRow}
            className="flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2.5 text-sm text-slate-300 transition-colors hover:border-[#6C63FF]/60 hover:text-white"
          >
            <Plus className="h-4 w-4" /> Add tax period
          </button>
          <button
            onClick={handleSaveTax}
            className="flex items-center gap-2 rounded-lg bg-[#6C63FF] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8]"
          >
            {taxSaved ? <CheckCircle2 className="h-4 w-4 text-[#00E096]" /> : <Save className="h-4 w-4" />}
            {taxSaved ? "Saved!" : "Save Tax Settings"}
          </button>
          <span className="text-xs text-slate-500">Changes are recorded in the audit log and update the Executive Hub instantly.</span>
        </div>
      </Card>

      <Card title="Alert thresholds" subtitle="Configure when revenue and occupancy drop alerts appear on the dashboard">
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3">
            <span className="text-sm text-slate-200">Revenue decrease alert</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                value={(thresholds.revenueDecreasePct * 100).toFixed(0)}
                onChange={(e) => setThresholds({ ...thresholds, revenueDecreasePct: Number(e.target.value) / 100 })}
                className="w-20 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-right text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
              />
              <span className="text-sm text-slate-400">% min drop</span>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3">
            <span className="text-sm text-slate-200">Occupancy decrease alert</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                value={(thresholds.occupancyDecreasePoints * 100).toFixed(0)}
                onChange={(e) => setThresholds({ ...thresholds, occupancyDecreasePoints: Number(e.target.value) / 100 })}
                className="w-20 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-right text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
              />
              <span className="text-sm text-slate-400">pp min drop</span>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-xl border border-[#FF6B6B]/15 bg-[#FF6B6B]/[0.04] px-4 py-3">
            <span className="text-sm text-slate-200">Low occupancy threshold</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                value={((thresholds.occupancyThreshold ?? 0.60) * 100).toFixed(0)}
                onChange={(e) => setThresholds({ ...thresholds, occupancyThreshold: Number(e.target.value) / 100 })}
                className="w-20 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-right text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
              />
              <span className="text-sm text-slate-400">% trigger</span>
            </div>
          </div>
          <button
            onClick={handleSaveThresholds}
            className="flex items-center gap-2 rounded-lg bg-[#6C63FF] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8]"
          >
            {thresholdSaved ? <CheckCircle2 className="h-4 w-4 text-[#00E096]" /> : <Save className="h-4 w-4" />}
            {thresholdSaved ? "Saved!" : "Save Thresholds"}
          </button>
        </div>
      </Card>

      <Card title="Revenue color thresholds" subtitle="Used by Monthly Calendar and daily detail panel for revenue-based coloring">
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-xl border border-[#4ade80]/15 bg-[#4ade80]/[0.04] px-4 py-3">
            <span className="text-sm text-slate-200">High revenue threshold (green)</span>
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-400">$</span>
              <input
                type="number" min="0" step="100"
                value={revThresholds.highRevenueThreshold}
                onChange={(e) => setRevThresholds({ ...revThresholds, highRevenueThreshold: Number(e.target.value) })}
                className="w-24 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-right text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
              />
              <span className="text-sm text-slate-400">+</span>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3">
            <span className="text-sm text-slate-200">Medium revenue threshold (gray)</span>
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-400">$</span>
              <input
                type="number" min="0" step="100"
                value={revThresholds.mediumRevenueThreshold}
                onChange={(e) => setRevThresholds({ ...revThresholds, mediumRevenueThreshold: Number(e.target.value) })}
                className="w-24 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-1.5 text-right text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
              />
              <span className="text-sm text-slate-400">+</span>
            </div>
          </div>
          <p className="text-xs text-slate-500">
            Days with revenue ≥ high threshold: <span className="text-[#4ade80]">green</span> ·
            ≥ medium: <span className="text-slate-400">gray</span> ·
            below medium: <span className="text-[#ff6b6b]">red</span>
          </p>
          <button
            onClick={handleSaveRevThresholds}
            className="flex items-center gap-2 rounded-lg bg-[#6C63FF] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8]"
          >
            {revSaved ? <CheckCircle2 className="h-4 w-4 text-[#00E096]" /> : <Save className="h-4 w-4" />}
            {revSaved ? "Saved!" : "Save Revenue Thresholds"}
          </button>
        </div>
      </Card>

      <Card title="Property management" subtitle="Add and manage hotel properties for multi-property reporting">
        <div className="space-y-2">
          {properties.map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3">
              <div className="flex items-center gap-3">
                <Building2 className="h-4 w-4 text-[#6C63FF]" />
                <div>
                  <p className="text-sm text-white">{p.name}</p>
                  <p className="text-xs text-slate-500">{p.code} · {p.rooms || 100} rooms · {p.city || ""}{p.state ? `, ${p.state}` : ""}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-3 py-1 text-xs ${p.active ? "bg-[#00E096]/15 text-[#00E096]" : "bg-white/5 text-slate-500"}`}>
                  {p.active ? "Active" : "Inactive"}
                </span>
                <button
                  onClick={() => setPropDeleteTarget(p)}
                  className="text-xs text-slate-500 transition-colors hover:text-[#FF6B6B]"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          {!properties.length && <p className="text-sm text-slate-500">No properties yet. Add your first property below.</p>}
        </div>

        <AlertDialog open={!!propDeleteTarget} onOpenChange={(open) => { if (!open) setPropDeleteTarget(null); }}>
          <AlertDialogContent className="border-white/10 bg-[#0F1F35]">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-white">Remove property “{propDeleteTarget?.name}”?</AlertDialogTitle>
              <AlertDialogDescription className="text-slate-400">
                This permanently deletes the property and <span className="text-[#FF6B6B]">all</span> of its imported
                report rows (occupancy, sources, gross revenue, payments, clerk records, expenses, payroll, and uploaded
                report history). This cannot be undone.
              </AlertDialogDescription>
              {propMsg.includes("Could not delete") && <p className="text-sm text-[#FF6B6B]">{propMsg}</p>}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="border-white/10 bg-[#0A1628] text-slate-300 hover:bg-[#1a2a40] hover:text-white">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => propDeleteTarget && handleDeleteProperty(propDeleteTarget.id)}
                className="bg-[#FF6B6B] text-white hover:bg-[#e55555]"
              >
                Yes, delete everything for this property
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <div className="mt-4 grid gap-2 sm:grid-cols-4">
          <input
            type="text"
            value={newPropCode}
            onChange={(e) => setNewPropCode(e.target.value)}
            placeholder="Code (e.g. RRI1416)"
            className="rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
          />
          <input
            type="text"
            value={newPropName}
            onChange={(e) => setNewPropName(e.target.value)}
            placeholder="Property name"
            className="sm:col-span-2 rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
          />
          <input
            type="number"
            min="1"
            value={newPropRooms}
            onChange={(e) => setNewPropRooms(e.target.value)}
            placeholder="Rooms"
            className="rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
          />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={handleAddProperty}
            disabled={!newPropCode.trim() || !newPropName.trim()}
            className="flex items-center gap-2 rounded-lg bg-[#6C63FF] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8] disabled:opacity-50"
          >
            <Plus className="h-4 w-4" /> Add Property
          </button>
          <button
            onClick={() => { refetchProps(); queryClientInstance.invalidateQueries({ queryKey: ["properties"] }); }}
            className="flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2.5 text-sm text-slate-400 transition-colors hover:border-[#00D4FF]/60 hover:text-white"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          {propMsg && <span className="text-sm text-[#00E096]">{propMsg}</span>}
        </div>
      </Card>

      <Card title="User management" subtitle="Create accounts, assign roles, permissions, and property access">
        <div className="space-y-3">
          <p className="text-sm text-slate-400">
            Manage logins, roles, permissions, and property-level access from the User Management page.
          </p>
          <Link
            to="/users"
            className="inline-flex items-center gap-2 rounded-lg bg-[#6C63FF] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8]"
          >
            <UserCog className="h-4 w-4" /> Open User Management
          </Link>
        </div>
      </Card>

      <Card title="My account" subtitle="Your profile, role, session, and security">
        {me && (
          <div className="space-y-6">
            <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#6C63FF]/30 text-base font-bold text-white">
                {(me.full_name || me.username || "?").slice(0, 1).toUpperCase()}
              </div>
              <div>
                <p className="text-sm font-medium text-white">{me.full_name || me.username}</p>
                <p className="text-xs text-slate-400">{me.email}</p>
                <p className="mt-0.5 text-[10px] uppercase tracking-wide text-[#6C63FF]">
                  {me.role?.replace("_", " ") || "user"}
                </p>
              </div>
            </div>

            {/* MFA Section */}
            <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  {me.mfa_enabled ? (
                    <Shield className="h-5 w-5 text-emerald-400" />
                  ) : (
                    <ShieldOff className="h-5 w-5 text-slate-500" />
                  )}
                  <div>
                    <p className="text-sm font-medium text-white">Two-Factor Authentication</p>
                    <p className="text-xs text-slate-500">
                      {me.mfa_enabled 
                        ? "MFA is enabled. You'll need your authenticator app to log in." 
                        : "Add an extra layer of security to your account."}
                    </p>
                  </div>
                </div>
                {me.mfa_enabled ? (
                  <button
                    onClick={handleMfaDisable}
                    className="text-sm text-amber-400 hover:text-amber-300 transition-colors"
                  >
                    Disable MFA
                  </button>
                ) : (
                  <button
                    onClick={handleMfaEnable}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-3 py-1.5 text-sm font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20"
                  >
                    <Shield className="h-3.5 w-3.5" /> Enable MFA
                  </button>
                )}
              </div>
            </div>

            <PasswordConfirmDialog
              isOpen={!!pwPrompt}
              busy={!!pwPrompt?.busy}
              error={pwPrompt?.error || null}
              title={pwPrompt?.kind === 'disable' ? 'Disable two-factor authentication' : 'Replace your second factor'}
              description={
                pwPrompt?.kind === 'disable'
                  ? 'Enter your password to turn two-factor authentication off. Every session on this account will be signed out, including this one.'
                  : 'Enter your password to issue a new authenticator secret. Your existing authenticator entry will stop working and other sessions will be signed out.'
              }
              confirmLabel={pwPrompt?.kind === 'disable' ? 'Disable MFA' : 'Replace factor'}
              onCancel={() => setPwPrompt(null)}
              onConfirm={(password) => (pwPrompt?.kind === 'disable' ? runMfaDisable(password) : runMfaEnable(password))}
            />

            <div className="flex flex-wrap gap-2">
              <Link
                to="/change-password"
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2.5 text-sm text-slate-300 transition-colors hover:border-[#6C63FF]/60 hover:text-white"
              >
                <Key className="h-3.5 w-3.5" /> Change Password
              </Link>
              <button
                onClick={() => logout(true)}
                className="inline-flex items-center gap-2 rounded-lg border border-[#FF6B6B]/30 bg-[#FF6B6B]/10 px-4 py-2.5 text-sm font-medium text-[#FF6B6B] transition-colors hover:bg-[#FF6B6B]/20"
              >
                <LogOut className="h-4 w-4" /> Log out
              </button>
            </div>
          </div>
        )}
      </Card>

      {hasAllPropertyAccess(me) && (
        <Card title="Backup & restore" subtitle="Save the whole database to a file, or replace it from one">
          <div className="space-y-6">
            <Alert className="border-amber-500/30 bg-amber-500/10">
              <AlertDescription className="text-sm text-slate-300">
                Every record in this app — staff, payroll, expenses, imported reports, commission
                rates and tax periods — is stored in <strong>this browser, on this computer</strong>.
                There is no copy on a server. Clearing site data, resetting the machine or moving to
                a different laptop loses all of it. A backup file is the only way to move the data or
                get it back.
              </AlertDescription>
            </Alert>

            <div>
              <button
                onClick={handleBackupDownload}
                disabled={backupBusy}
                className="flex items-center gap-2 rounded-lg bg-[#6C63FF] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8] disabled:opacity-60"
              >
                {backupBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {backupBusy ? "Building backup…" : "Download backup"}
              </button>
              <p className="mt-2 text-xs text-slate-500">
                Writes a single <code className="text-slate-400">{ARCHIVE_FILE_EXT}</code> file
                holding every table and every setting, with a checksum so a damaged file is refused
                rather than half-restored. Do a fresh one after any large import, and keep it
                somewhere other than this computer.
              </p>
            </div>

            <div className="border-t border-white/10 pt-6">
              <Label className="text-sm font-medium text-slate-200">Restore from a backup</Label>
              <p className="mt-1 text-xs text-slate-500">
                Restoring <strong className="text-slate-400">replaces</strong> everything currently
                in this browser with the contents of the file. It cannot merge two databases — row
                ids from two machines would collide and records would end up attached to the wrong
                property. Download a backup of what is here first if you want to keep it.
              </p>

              <input
                ref={restoreInputRef}
                type="file"
                accept={ARCHIVE_FILE_EXT}
                onChange={handleRestoreFile}
                className="hidden"
              />
              <button
                onClick={() => restoreInputRef.current?.click()}
                disabled={restoreBusy}
                className="mt-3 inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2.5 text-sm text-slate-300 transition-colors hover:border-[#6C63FF]/60 hover:text-white disabled:opacity-60"
              >
                {restoreBusy && !restorePlan ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                {restoreBusy && !restorePlan ? "Checking file…" : "Choose backup file…"}
              </button>

              {restoreError && (
                <Alert className="mt-3 border-[#FF6B6B]/30 bg-[#FF6B6B]/10">
                  <AlertDescription className="whitespace-pre-line text-sm text-[#FF6B6B]">
                    {restoreError}
                  </AlertDescription>
                </Alert>
              )}

              {restorePlan && (
                <div className="mt-4 rounded-lg border border-[#FF6B6B]/30 bg-[#0A1628] p-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-white">
                    <Database className="h-4 w-4 text-[#FF6B6B]" />
                    {restorePlan.filename}
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                    <dt className="text-slate-500">Records in the file</dt>
                    <dd className="text-slate-300">{restorePlan.parsed.totalRows.toLocaleString()}</dd>
                    <dt className="text-slate-500">Tables</dt>
                    <dd className="text-slate-300">{restorePlan.parsed.storeNames.length}</dd>
                    <dt className="text-slate-500">Settings</dt>
                    <dd className="text-slate-300">{restorePlan.parsed.localSlotKeys.length}</dd>
                    <dt className="text-slate-500">Exported</dt>
                    <dd className="text-slate-300">
                      {restorePlan.parsed.archive.exported_at
                        ? new Date(restorePlan.parsed.archive.exported_at).toLocaleString()
                        : "unknown"}
                    </dd>
                    <dt className="text-slate-500">Exported by</dt>
                    <dd className="break-all text-slate-300">{restorePlan.parsed.archive.exported_by || "unknown"}</dd>
                  </dl>

                  {restorePlan.parsed.missingStores.length > 0 && (
                    /* Not a refusal: an older backup predates a table this build
                       added. Named so nobody discovers the empty table later. */
                    <p className="mt-3 text-xs text-amber-400">
                      This backup predates {restorePlan.parsed.missingStores.length} table(s) —{" "}
                      {restorePlan.parsed.missingStores.join(", ")}. They will be left empty after
                      the restore.
                    </p>
                  )}

                  <p className="mt-3 text-xs text-slate-400">
                    Type <strong className="text-[#FF6B6B]">REPLACE</strong> to confirm that
                    everything currently in this browser should be discarded.
                  </p>
                  <input
                    type="text"
                    value={restorePhrase}
                    onChange={(e) => setRestorePhrase(e.target.value)}
                    placeholder="Type REPLACE to confirm"
                    className="mt-2 w-full rounded-lg border border-white/10 bg-[#0F1F35] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#FF6B6B]"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={handleRestoreConfirm}
                      disabled={restorePhrase !== "REPLACE" || restoreBusy}
                      className="flex items-center gap-2 rounded-lg border border-[#FF6B6B]/30 bg-[#FF6B6B]/10 px-4 py-2.5 text-sm font-medium text-[#FF6B6B] transition-colors hover:bg-[#FF6B6B]/20 disabled:opacity-50"
                    >
                      {restoreBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                      {restoreBusy ? "Restoring…" : "Replace this database"}
                    </button>
                    <button
                      onClick={() => { setRestorePlan(null); setRestorePhrase(""); setRestoreError(""); }}
                      disabled={restoreBusy}
                      className="rounded-lg border border-white/10 px-4 py-2.5 text-sm text-slate-300 transition-colors hover:text-white disabled:opacity-60"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      <Card title="Account management" subtitle="Permanently delete your account and all associated data">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button className="flex items-center gap-2 rounded-lg border border-[#FF6B6B]/30 bg-[#FF6B6B]/10 px-4 py-2.5 text-sm font-medium text-[#FF6B6B] transition-colors hover:bg-[#FF6B6B]/20">
              <Trash2 className="h-4 w-4" /> Delete Account
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent className="border-white/10 bg-[#0F1F35]">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-white">Delete Account?</AlertDialogTitle>
              <AlertDialogDescription className="text-slate-400">
                This will permanently delete your account and all associated data including imported reports,
                occupancy records, revenue figures, clerk shift logs, and commission settings. This action cannot
                be undone. You will lose access to all historical hotel data and analytics.
              </AlertDialogDescription>
              <input
                type="text"
                value={deletePhrase}
                onChange={(e) => setDeletePhrase(e.target.value)}
                placeholder="Type DELETE to confirm"
                className="mt-3 w-full rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#FF6B6B]"
              />
              {deleteError && <p className="mt-2 text-sm text-[#FF6B6B]">{deleteError}</p>}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="border-white/10 bg-[#0A1628] text-slate-300 hover:bg-[#1a2a40] hover:text-white">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDeleteAccount}
                disabled={deletePhrase !== "DELETE" || deleting}
                className="bg-[#FF6B6B] text-white hover:bg-[#e55555] disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Yes, delete everything"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Card>

{/* MFA Setup Dialog */}
      {mfaSetupOpen && mfaSecret && mfaUri && (
        <DialogPrimitive.Root open={mfaSetupOpen} onOpenChange={handleMfaSetupCancel}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
            <DialogPrimitive.Content 
              className="fixed inset-0 z-50 flex items-center justify-center p-4 outline-none pointer-events-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
              aria-describedby={undefined}
            >
              <div className="w-full max-w-md bg-[#0F1F35] rounded-xl border border-white/10 overflow-hidden pointer-events-auto">
                <div className="p-6 space-y-6">
                  <div className="text-center">
                    <DialogPrimitive.Title className="sr-only">Set Up Authenticator App</DialogPrimitive.Title>
                {mfaAction === 'enable' && (
                  <>
                    <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
                      <Shield className="h-6 w-6 text-emerald-400" />
                    </div>
                    <h3 className="text-lg font-semibold text-white">Set Up Authenticator App</h3>
                    <p className="mt-1 text-sm text-slate-400">Scan the QR code to enable two-factor authentication</p>
                  </>
                )}
              </div>

              <div className="space-y-4">
                <div className="flex justify-center">
                  <div className="bg-white p-4 rounded-lg border">
                    <canvas ref={qrCanvasRef} className="mx-auto" />
                  </div>
                </div>

                {qrError && (
                  <p className="text-center text-xs text-[#FF6B6B]">
                    The QR code could not be drawn ({qrError}). Enter the secret key below into your authenticator app instead — it enrols the same account.
                  </p>
                )}

                <div className="text-center text-sm">
                  <p className="text-muted-foreground">Or enter this secret key manually:</p>
                  <code className="block mt-1 font-mono text-xs text-slate-300 bg-slate-800 px-2 py-1 rounded break-all">{mfaSecret}</code>
                </div>

                <Alert className="border-amber-500/30 bg-amber-500/10">
                  <AlertDescription className="text-sm flex items-center gap-2">
                    <span className="flex-shrink-0">⚠</span>
                    <strong>Save backup codes!</strong> You'll receive 10 one-time backup codes after verification. Store them securely — each can only be used once.
                  </AlertDescription>
                </Alert>

                <div className="space-y-3">
                  <Label htmlFor="mfa-token" className="text-sm font-medium">Enter the 6-digit code from your app</Label>
                  <div className="relative">
                    <Smartphone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                    <Input
                      id="mfa-token"
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={6}
                      placeholder="000000"
                      onChange={(e) => {
                        const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                        if (val.length === 6) handleMfaSetupComplete(val);
                      }}
                      className="h-12 pl-10 text-2xl tracking-widest text-center"
                      autoFocus
                      autoComplete="one-time-code"
                      disabled={mfaVerifying}
                    />
                  </div>
                  <Button 
                    className="w-full h-12" 
                    onClick={() => {}}
                    disabled={mfaVerifying}
                  >
                    {mfaVerifying ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Verifying...
                      </>
                    ) : (
                      "Verify & Enable MFA"
                    )}
                  </Button>
                </div>

                <Button variant="outline" className="w-full" onClick={handleMfaSetupCancel}>
                  Cancel
                </Button>
              </div>
              </div>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      )}
    </div>
  );
}