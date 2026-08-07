import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldCheck, Eye, EyeOff, Loader2 } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";
import { useAuth } from "@/lib/AuthContext";
import db from "@/api/base44Client";
import { isCryptoAvailable, validatePasswordStrength } from "@/lib/security";

export default function Setup() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [checked, setChecked] = useState(false);
  const [alreadyExists, setAlreadyExists] = useState(false);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const all = await db.entities.User.list();
        if (mounted) setAlreadyExists(all.length > 0);
      } catch (e) {
        if (mounted) setAlreadyExists(false);
      } finally {
        if (mounted) setChecked(true);
      }
    })();
    return () => { mounted = false; };
  }, []);

  if (!checked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#040D1A]">
        <Loader2 className="h-8 w-8 animate-spin text-[#6C63FF]" />
      </div>
    );
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (!isCryptoAvailable()) {
      setError("Password hashing is not available in this browser. Open the app via localhost or HTTPS.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    const strengthError = validatePasswordStrength(password);
    if (strengthError) {
      setError(strengthError);
      return;
    }
    setLoading(true);
    try {
      await db.users.create(
        { id: "setup", username: username || "owner", email: email || "owner", role: "owner", is_active: true },
        {
          username,
          email,
          full_name: fullName,
          role: "owner",
          permissions: "all",
          property_access: "all",
          is_active: true,
          password,
          must_change_password: false,
        }
      );
      await login(username, password, true);
      window.location.href = "/";
    } catch (err) {
      setError(err.message || "Could not create the Owner account.");
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      icon={ShieldCheck}
      title="Create Owner account"
      subtitle="Set up the first administrator account"
    >
      {alreadyExists ? (
        <div className="rounded-lg border border-white/10 bg-[#0A1628] p-4 text-sm text-slate-400">
          <p className="text-slate-200 font-medium">Setup already complete</p>
          <p className="mt-1">
            User accounts already exist. Go to the login page to sign in.
          </p>
          <Button className="mt-4 w-full" onClick={() => navigate("/login")}>
            Go to Login
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="full_name">Full name (optional)</Label>
            <Input id="full_name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Jane Doe" className="h-11" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="username">Username</Label>
            <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="owner" className="h-11" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@example.com" className="h-11" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters with upper/lowercase and a number"
                className="h-11 pr-10"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-slate-100"
                aria-label="Toggle password visibility"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm password</Label>
            <Input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-11" required />
          </div>

          {error && (
            <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <Button type="submit" className="h-12 w-full font-medium" disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating account...
              </>
            ) : (
              "Create Owner account"
            )}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
