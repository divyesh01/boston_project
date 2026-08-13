import React, { useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { LogIn, Mail, Lock, Eye, EyeOff, Loader2, Smartphone, RotateCcw, Shield } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";
import { safeReturnTo } from "@/lib/authReturnTo";
import { useAuth } from "@/lib/AuthContext";
import { db } from "@/api/base44Client";
import { getCsrfToken, validateCsrfToken, rotateCsrfToken } from "@/lib/securityUtils";
import { isValidEmail } from "@/lib/validator";
import MFASetup from "@/components/MFASetup";

export default function Login() {
  const { login, isAuthenticated } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [returnTo, setReturnTo] = useState("/");
  const [searchParams] = useSearchParams();
  const [setupRequired, setSetupRequired] = useState(false);
  
  // MFA flow states
  const [mfaStep, setMfaStep] = useState(null); // null = password step, 'verify' = MFA token, 'setup' = first-time setup
  const [mfaUserId, setMfaUserId] = useState(null);
  const [mfaUsername, setMfaUsername] = useState(null);
  const [mfaSecret, setMfaSecret] = useState(null);
  const [mfaUri, setMfaUri] = useState(null);
  const [mfaBackupCodes, setMfaBackupCodes] = useState([]);
  const [mfaToken, setMfaToken] = useState("");
  const [mfaError, setMfaError] = useState("");

  // Post-login destination (same-origin paths only)
  useEffect(() => {
    setReturnTo(safeReturnTo() || "/");
  }, [searchParams]);

  useEffect(() => {
    if (isAuthenticated) {
      window.location.href = safeReturnTo() || "/";
    }
  }, [isAuthenticated]);

  // Detect first-run: no users exist yet → show Setup prompt
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const initialized = await db.users.initialized();
        if (mounted) setSetupRequired(!initialized);
      } catch (e) {
        if (mounted) setSetupRequired(true);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Normalize the login identifier: trim whitespace and lowercase the email
  // branch so credential lookups are case-insensitive (spec A.1). Usernames are
  // left untouched.
  const normalizeIdentifier = (value) => {
    const v = String(value || "").trim();
    return v.includes("@") ? v.toLowerCase() : v;
  };

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    setError("");
    // Format check before any network/auth work. Emails are validated strictly;
    // the username branch mirrors the identifier policy in base44Client (hyphens
    // allowed, bounded length) so legacy accounts are never blocked here.
    const id = identifier.trim();
    if (id.includes("@") ? !isValidEmail(id) : !/^[A-Za-z0-9_-]{1,50}$/.test(id)) {
      setError("Please enter a valid username or email.");
      return;
    }
    // CSRF validation
    const csrfToken = getCsrfToken();
    if (!validateCsrfToken(csrfToken)) {
      setError("Invalid security token. Please refresh the page and try again.");
      rotateCsrfToken();
      return;
    }
    setLoading(true);
    try {
      const result = await login(normalizeIdentifier(identifier), password, remember);
      if (result?.mfaRequired) {
        // MFA required but no token provided - move to MFA verification step.
        // Keep `password` in memory; the verify step still needs it.
        setMfaStep('verify');
        setMfaUserId(result.userId);
        setMfaUsername(result.username);
        setError("");
      } else {
        // Login successful (no MFA or MFA already verified)
        setPassword("");
        rotateCsrfToken();
        window.location.href = returnTo;
      }
    } catch (err) {
      // Never leak the specific failure reason. Only distinguish network
      // outages so the user gets an actionable message (spec C.1 / C.3).
      const isNetworkError =
        (typeof navigator !== "undefined" && navigator.onLine === false) ||
        /network|server|offline|failed to fetch|timeout|econn/i.test(err?.message || "");
      setError(
        isNetworkError
          ? "Unable to reach authentication server. Please check your connection."
          : "Invalid email or password"
      );
      // Retain the entered identifier, but always clear the password field.
      setPassword("");
    } finally {
      setLoading(false);
    }
  };

  const handleMfaVerify = async (e) => {
    e.preventDefault();
    setMfaError("");
    const csrfToken = getCsrfToken();
    if (!validateCsrfToken(csrfToken)) {
      setMfaError("Invalid security token. Please refresh the page and try again.");
      rotateCsrfToken();
      return;
    }
    if (!mfaToken || mfaToken.length !== 6) {
      setMfaError("Please enter a 6-digit code.");
      return;
    }
    setLoading(true);
    try {
      await login(normalizeIdentifier(identifier), password, remember, mfaToken);
      setPassword("");
      rotateCsrfToken();
      window.location.href = returnTo;
    } catch (err) {
      setMfaError(err.message || "Invalid MFA code. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleMfaSetupComplete = async (token, done) => {
    if (done) {
      // Setup complete, redirect
      rotateCsrfToken();
      window.location.href = returnTo;
      return;
    }
    // Verify the token during setup
    setLoading(true);
    try {
      await login(normalizeIdentifier(identifier), password, remember, token);
      setPassword("");
      rotateCsrfToken();
      window.location.href = returnTo;
    } catch (err) {
      setMfaError(err.message || "Invalid MFA code. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleMfaSetupCancel = () => {
    // Cancel MFA setup - go back to password step
    setMfaStep(null);
    setMfaUserId(null);
    setMfaUsername(null);
    setMfaSecret(null);
    setMfaUri(null);
    setMfaBackupCodes([]);
    setMfaToken("");
    setMfaError("");
  };

  const goBackToPassword = () => {
    setMfaStep(null);
    setMfaUserId(null);
    setMfaUsername(null);
    setMfaToken("");
    setMfaError("");
  };

  return (
    <AuthLayout
      icon={LogIn}
      title={mfaStep === 'verify' ? "Two-Factor Authentication" : mfaStep === 'setup' ? "Set Up MFA" : "Welcome back"}
      subtitle={
        mfaStep === 'verify' ? "Enter the code from your authenticator app" :
        mfaStep === 'setup' ? "Scan the QR code to enable MFA" :
        "Log in to RRI Executive"
      }
      footer={
        <>
          Don't have an account?{" "}
          <span className="text-slate-500">
            Contact the administrator to create your login.
          </span>
        </>
      }
    >
      {setupRequired && mfaStep === null && (
        <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-300">
          <p className="font-medium">First-time setup</p>
          <p className="mt-1">
            No user accounts exist yet. Create the Owner account to get started.
          </p>
          <Link to="/setup" className="mt-2 inline-block font-medium text-[#6C63FF] hover:underline">
            Create Owner account →
          </Link>
        </div>
      )}

      {/* Temporary Reset Button to wipe data */}
      <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
        <p className="font-medium text-red-500">Need to start over?</p>
        <p className="mt-1 text-slate-400">
          Click below to wipe all local database data (including accounts).
        </p>
        <Button 
          variant="destructive" 
          size="sm" 
          className="mt-2"
          onClick={() => {
            if(window.confirm('Are you sure? This will delete all local accounts and data.')) {
              indexedDB.deleteDatabase('RedRoofIntelligence');
              window.location.reload();
            }
          }}
        >
          Reset All Data
        </Button>
      </div>

      {(error && mfaStep === null) && (
        <div className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {(mfaError && mfaStep !== null) && (
        <div className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {mfaError}
        </div>
      )}

      {mfaStep === 'verify' && (
        <form onSubmit={handleMfaVerify} className="space-y-4">
          <div className="flex items-center justify-center gap-3 mb-4">
            <Shield className="h-8 w-8 text-[#6C63FF]" />
            <div className="text-left">
              <p className="font-medium">MFA Required</p>
              <p className="text-sm text-slate-500">Enter the 6-digit code from your authenticator app</p>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="mfa-token">Authentication Code</Label>
            <div className="relative">
              <Smartphone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                id="mfa-token"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="000000"
                value={mfaToken}
                onChange={(e) => setMfaToken(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="h-12 pl-10 text-2xl tracking-widest text-center"
                autoFocus
                autoComplete="one-time-code"
                required
              />
            </div>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-500">Code refreshes every 30 seconds</span>
            <Button type="button" variant="ghost" size="sm" onClick={goBackToPassword}>
              <RotateCcw className="mr-1 h-3 w-3" /> Use password instead
            </Button>
          </div>
          <Button type="submit" className="h-12 w-full font-medium" disabled={loading || mfaToken.length !== 6}>
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Verifying...
              </>
            ) : (
              "Verify & Log in"
            )}
          </Button>
        </form>
      )}

      {mfaStep === 'setup' && (
        <MFASetup
          secret={mfaSecret}
          uri={mfaUri}
          userEmail={mfaUsername}
          backupCodes={mfaBackupCodes}
          onComplete={handleMfaSetupComplete}
          onCancel={handleMfaSetupCancel}
          isEnabling={true}
        />
      )}

      {mfaStep === null && (
        <form onSubmit={handlePasswordSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="identifier">Username or Email</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                id="identifier"
                type="text"
                autoComplete="username"
                autoFocus
                placeholder="you@example.com or username"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                className="h-12 pl-10"
                required
              />
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link to="/forgot-password" className="text-xs text-[#6C63FF] hover:underline">
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-12 pl-10 pr-10"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-slate-100"
                aria-label={showPassword ? "Hide password" : "Show password"}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="remember"
              checked={remember}
              onCheckedChange={(v) => setRemember(!!v)}
            />
            <label htmlFor="remember" className="text-sm text-slate-400">
              Remember me for 30 days
            </label>
          </div>
          <Button type="submit" className="h-12 w-full font-medium" disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Logging in...
              </>
            ) : (
              "Log in"
            )}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
