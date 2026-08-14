import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldCheck, Eye, EyeOff, Loader2 } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";
import { useAuth } from "@/lib/AuthContext";
import { db, setupRateLimiter } from "@/api/base44Client";
import { validatePasswordStrength } from "@/lib/security";
import { isValidEmail } from "@/lib/validator";
import { getCsrfToken, validateCsrfToken, rotateCsrfToken, sanitizeAlphanumeric, sanitizeEmail, sanitizeText, sanitizeCsvCell } from "@/lib/securityUtils";

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
        const initialized = await db.users.initialized();
        if (mounted) setAlreadyExists(initialized);
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

    // Artificially delay execution to neuter brute-force speeds (exponential backoff)
    // Even if rate limiters are bypassed, this forces the client to hang.
    const attemptCount = parseInt(sessionStorage.getItem('setup_attempts') || '0', 10);
    sessionStorage.setItem('setup_attempts', (attemptCount + 1).toString());
    const delay = Math.min(attemptCount * 1000, 8000); // Up to 8 seconds delay
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    // Rate limiting (now async and crypto-backed)
    const rateLimit = await setupRateLimiter.check('setup_route');
    if (!rateLimit.allowed) {
      setError(`Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.`);
      return;
    }
    // CSRF validation
    const csrfToken = getCsrfToken();
    if (!validateCsrfToken(csrfToken)) {
      setError("Invalid security token. Please refresh the page and try again.");
      rotateCsrfToken();
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    // Validate email format before dispatching the network request (spec 2.A.1).
    if (!isValidEmail(email)) {
      setError("Please enter a valid email address.");
      return;
    }
    const strengthError = validatePasswordStrength(password);
    if (strengthError) {
      setError(strengthError);
      return;
    }
    // Input sanitization
    const sanitizedUsername = sanitizeAlphanumeric(username);
    const sanitizedEmail = sanitizeEmail(email);
    const sanitizedFullName = sanitizeCsvCell(sanitizeText(fullName));
    if (sanitizedUsername !== username || sanitizedEmail !== email) {
      setError("Invalid characters in username or email.");
      return;
    }
    setLoading(true);
    try {
      await db.auth.registerUser({
        username: sanitizedUsername,
        email: sanitizedEmail,
        full_name: sanitizedFullName,
        role: "owner",
        permissions: "all",
        property_access: "all",
        is_active: true,
        password,
        must_change_password: false,
      });
      await login(sanitizedUsername, password, true);
      rotateCsrfToken();
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
