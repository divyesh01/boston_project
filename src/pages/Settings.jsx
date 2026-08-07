import { db } from '@/api/base44Client';

import React, { useState, useEffect } from "react";
import { Save, Plus, CheckCircle2, RotateCcw, Trash2, UserPlus, AlertTriangle, Building2, RefreshCw } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { getCommissionRates, setCommissionRates, getCcFeeRate, setCcFeeRate, COMMISSION_TYPES } from "@/lib/commissionRates";
import { getAlertThresholds, saveAlertThresholds } from "@/lib/alertThresholds";
import { getRevenueThresholds, saveRevenueThresholds } from "@/lib/revenueThresholds";

import { useProperties } from "@/lib/useHotelData";
import { queryClientInstance } from "@/lib/query-client";
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from "@/components/ui/alert-dialog";

export default function Settings() {
  const [rates, setRates] = useState(() => getCommissionRates());
  const [ccFee, setCcFee] = useState(() => getCcFeeRate());
  const [newSource, setNewSource] = useState("");
  const [saved, setSaved] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [thresholds, setThresholds] = useState(() => getAlertThresholds());
  const [thresholdSaved, setThresholdSaved] = useState(false);
  const [revThresholds, setRevThresholds] = useState(() => getRevenueThresholds());
  const [revSaved, setRevSaved] = useState(false);
  const [users, setUsers] = useState([]);
  const [usersError, setUsersError] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("user");
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState("");
  const { data: properties = [], refetch: refetchProps } = useProperties();
  const [newPropCode, setNewPropCode] = useState("");
  const [newPropName, setNewPropName] = useState("");
  const [newPropRooms, setNewPropRooms] = useState("100");
  const [propMsg, setPropMsg] = useState("");

  useEffect(() => {
    db.entities.User.list()
      .then((res) => setUsers(res))
      .catch(() => setUsersError("Only admins can manage users."));
  }, []);

  const handleChange = (key, field, val) => {
    const cur = rates[key] || { type: "percentage", rate: 0, taxExempt: false };
    setRates({ ...rates, [key]: { ...cur, [field]: field === "rate" ? Number(val) : val } });
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

  const handleSave = () => {
    setCommissionRates(rates);
    setCcFeeRate(ccFee);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    const fresh = getCommissionRates();
    setRates(fresh);
    setCcFee(getCcFeeRate());
  };

  const handleSaveThresholds = () => {
    saveAlertThresholds(thresholds);
    setThresholdSaved(true);
    setTimeout(() => setThresholdSaved(false), 2000);
  };

  const handleSaveRevThresholds = () => {
    saveRevenueThresholds(revThresholds);
    setRevSaved(true);
    setTimeout(() => setRevSaved(false), 2000);
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteMsg("");
    try {
      await db.users.inviteUser(inviteEmail.trim(), inviteRole);
      setInviteMsg(`Invitation sent to ${inviteEmail.trim()}`);
      setInviteEmail("");
      const res = await db.entities.User.list();
      setUsers(res);
    } catch (e) {
      setInviteMsg(e.message || "Could not invite user");
    }
    setInviting(false);
  };

  const handleAddProperty = async () => {
    if (!newPropCode.trim() || !newPropName.trim()) return;
    setPropMsg("");
    try {
      await db.entities.Property.create({
        code: newPropCode.trim().toUpperCase(),
        name: newPropName.trim(),
        rooms: Number(newPropRooms) || 100,
        active: true,
      });
      setPropMsg(`Property "${newPropName.trim()}" added.`);
      setNewPropCode("");
      setNewPropName("");
      setNewPropRooms("100");
      refetchProps();
      queryClientInstance.invalidateQueries({ queryKey: ["properties"] });
    } catch (e) {
      setPropMsg(e.message || "Could not add property.");
    }
  };

  const handleDeleteProperty = async (id) => {
    try {
      await db.entities.Property.delete(id);
      refetchProps();
      queryClientInstance.invalidateQueries({ queryKey: ["properties"] });
    } catch (e) {
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
    } catch (e) {
      setDeleteError("Your account could not be deleted. You are still signed in, and no logout was performed.");
      setDeleting(false);
    }
  };

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
                    step="0.5"
                    value={r.rate}
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
                  onClick={() => handleDeleteProperty(p.id)}
                  className="text-xs text-slate-500 transition-colors hover:text-[#FF6B6B]"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          {!properties.length && <p className="text-sm text-slate-500">No properties yet. Add your first property below.</p>}
        </div>

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

      <Card title="User management" subtitle="Invite team members and control access">
        {usersError ? (
          <p className="text-sm text-slate-500">{usersError}</p>
        ) : (
          <>
            <div className="space-y-2">
              {users.map((u) => (
                <div key={u.id} className="flex items-center justify-between rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3">
                  <div>
                    <p className="text-sm text-white">{u.email}</p>
                    <p className="text-xs text-slate-500">{u.full_name || "—"}</p>
                  </div>
                  <span
                    className={`rounded-full px-3 py-1 text-xs ${
                      u.role === "admin" ? "bg-[#6C63FF]/15 text-[#6C63FF]" : "bg-white/5 text-slate-400"
                    }`}
                  >
                    {u.role || "user"}
                  </span>
                </div>
              ))}
              {!users.length && <p className="text-sm text-slate-500">No users found.</p>}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="employee@email.com"
                className="flex-1 rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
                className="min-h-[44px] rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
              <button
                onClick={handleInvite}
                disabled={inviting || !inviteEmail.trim()}
                className="flex h-11 items-center gap-2 rounded-lg bg-[#6C63FF] px-4 text-sm font-medium text-white transition-colors hover:bg-[#5b52e8] disabled:opacity-50"
              >
                <UserPlus className="h-4 w-4" /> {inviting ? "…" : "Invite"}
              </button>
            </div>
            {inviteMsg && <p className="mt-2 text-sm text-[#00E096]">{inviteMsg}</p>}
          </>
        )}
      </Card>

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
    </div>
  );
}