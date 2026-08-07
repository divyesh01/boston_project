import React, { useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { LogIn, Mail, Lock, Eye, EyeOff, Loader2 } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";
import { safeReturnTo } from "@/lib/authReturnTo";
import { useAuth } from "@/lib/AuthContext";
import db from "@/api/base44Client";

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
        const count = await db.entities.User.filter({});
        if (mounted) setSetupRequired(count.length === 0);
      } catch (e) {
        const all = await db.entities.User.list();
        if (mounted) setSetupRequired(all.length === 0);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(identifier, password, remember);
      window.location.href = returnTo;
    } catch (err) {
      setError(err.message || "Invalid username/email or password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      icon={LogIn}
      title="Welcome back"
      subtitle="Log in to RRI Executive"
      footer={
        <>
          Don't have an account?{" "}
          <span className="text-slate-500">
            Contact the administrator to create your login.
          </span>
        </>
      }
    >
      {setupRequired && (
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

      {error && (
        <div className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
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
            <span className="text-xs text-slate-500">
              Forgot password? Contact an administrator.
            </span>
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
    </AuthLayout>
  );
}
