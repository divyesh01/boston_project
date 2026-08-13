import React, { useState, useEffect } from "react";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Lock, Loader2, AlertTriangle, CheckCircle, Eye, EyeOff, AlertCircle } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";
import { db } from "@/api/base44Client";
import { validatePasswordStrength } from "@/lib/security";
import { getCsrfToken, sensitiveActionRateLimiter, validateCsrfToken, rotateCsrfToken } from "@/lib/securityUtils";
import { toast } from "@/components/ui/use-toast";

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const resetToken = searchParams.get("token");

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [errors, setErrors] = useState({ newPassword: "", confirmPassword: "" });
  const [passwordStrength, setPasswordStrength] = useState({
    length: false,
    lowercase: false,
    uppercase: false,
    number: false,
    special: false,
    noRepeating: false,
  });

  // Validate password on change
  useEffect(() => {
    if (newPassword) {
      const err = validatePasswordStrength(newPassword);
      setErrors((prev) => ({ ...prev, newPassword: err }));
      
      // Calculate strength indicators
      const checks = {
        length: newPassword.length >= 12,
        lowercase: /[a-z]/.test(newPassword),
        uppercase: /[A-Z]/.test(newPassword),
        number: /[0-9]/.test(newPassword),
        special: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(newPassword),
        noRepeating: !/(.)\1{2,}/.test(newPassword),
      };
      setPasswordStrength(checks);
    } else {
      setErrors((prev) => ({ ...prev, newPassword: "" }));
      setPasswordStrength({
        length: false,
        lowercase: false,
        uppercase: false,
        number: false,
        special: false,
        noRepeating: false,
      });
    }
  }, [newPassword]);

  useEffect(() => {
    if (confirmPassword && newPassword !== confirmPassword) {
      setErrors((prev) => ({ ...prev, confirmPassword: "Passwords do not match" }));
    } else {
      setErrors((prev) => ({ ...prev, confirmPassword: "" }));
    }
  }, [confirmPassword, newPassword]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      // CSRF validation
      const csrfToken = getCsrfToken();
      if (!validateCsrfToken(csrfToken)) {
        toast({ variant: "destructive", title: "Security Error", description: "Invalid security token. Please refresh the page and try again." });
        rotateCsrfToken();
        return;
      }

      // Rate limiting
      const rateLimit = sensitiveActionRateLimiter.check();
      if (!rateLimit.allowed) {
        toast({ variant: "destructive", title: "Rate Limited", description: `Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.` });
        return;
      }

      if (!resetToken) {
        throw new Error("No reset token provided.");
      }

      const err = validatePasswordStrength(newPassword);
      if (err) throw new Error(err);

      await db.auth.resetPassword(resetToken, newPassword);
      setSuccess(true);
      rotateCsrfToken();
      toast({ title: "Password reset successful", description: "You can now log in with your new password." });
      
      // Redirect to login after a short delay
      setTimeout(() => navigate("/login"), 2000);
    } catch (err) {
      toast({ variant: "destructive", title: "Error", description: err.message || "Failed to reset password" });
    } finally {
      setLoading(false);
    }
  };

  if (!resetToken) {
    return (
      <AuthLayout
        icon={AlertTriangle}
        title="Invalid reset link"
        subtitle="This password reset link is missing or invalid"
        footer={
          <Link to="/forgot-password" className="text-primary font-medium hover:underline">
            Request a new token
          </Link>
        }
      >
        <div className="flex items-center gap-3 p-4 rounded-lg bg-destructive/10 border border-destructive/30">
          <AlertCircle className="h-6 w-6 text-destructive flex-shrink-0" />
          <p className="text-sm text-foreground">
            The link you used appears to be incomplete or missing the reset token. Please request a new password reset token.
          </p>
        </div>
      </AuthLayout>
    );
  }

  if (success) {
    return (
      <AuthLayout
        icon={CheckCircle}
        title="Password reset successful"
        subtitle="Your password has been updated"
        footer={
          <Link to="/login" className="text-primary font-medium hover:underline">
            Log in with new password
          </Link>
        }
      >
        <div className="flex flex-col items-center gap-4 p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
          <CheckCircle className="h-12 w-12 text-emerald-400" />
          <div className="text-center">
            <p className="font-medium">Your password has been successfully reset.</p>
            <p className="text-sm text-slate-400 mt-1">Redirecting to login...</p>
          </div>
        </div>
      </AuthLayout>
    );
  }

  const strengthChecks = [
    { label: "At least 12 characters", met: passwordStrength.length },
    { label: "One lowercase letter", met: passwordStrength.lowercase },
    { label: "One uppercase letter", met: passwordStrength.uppercase },
    { label: "One number", met: passwordStrength.number },
    { label: "One special character", met: passwordStrength.special },
    { label: "No repeating characters (3+)", met: passwordStrength.noRepeating },
  ];

  const allChecksPassed = Object.values(passwordStrength).every(v => v === true);

  return (
    <AuthLayout
      icon={Lock}
      title="New password"
      subtitle="Enter your new password below"
      footer={
        <Link to="/login" className="text-primary font-medium hover:underline">
          Back to log in
        </Link>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="newPassword">New Password</Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              id="newPassword"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              autoFocus
              placeholder="••••••••"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="h-12 pl-10 pr-10"
              required
              aria-describedby="password-requirements"
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
          {errors.newPassword && (
            <p className="text-sm text-destructive" id="password-requirements">{errors.newPassword}</p>
          )}
        </div>

        {newPassword && (
          <div className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-3" id="password-requirements">
            <p className="text-xs font-medium text-slate-400 mb-2">Password requirements:</p>
            <ul className="space-y-1 text-xs">
              {strengthChecks.map((check, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className={`h-3 w-3 rounded-full border ${check.met ? "bg-emerald-500 border-emerald-500" : "border-slate-600"}`} />
                  <span className={`text-sm ${check.met ? "text-emerald-400" : "text-slate-500"}`}>
                    {check.label}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="confirmPassword">Confirm Password</Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              id="confirmPassword"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              placeholder="••••••••"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="h-12 pl-10"
              required
            />
          </div>
          {errors.confirmPassword && <p className="text-sm text-destructive">{errors.confirmPassword}</p>}
        </div>

        <Button type="submit" className="h-12 w-full font-medium" disabled={loading || !allChecksPassed || !confirmPassword}>
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Resetting...
            </>
          ) : (
            "Reset password"
          )}
        </Button>
      </form>
    </AuthLayout>
  );
}