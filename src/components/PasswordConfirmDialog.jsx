import React, { useEffect, useRef, useState } from 'react';
import { ShieldAlert, Loader2 } from 'lucide-react';

/**
 * Ask the signed-in user to re-enter their OWN password before a change that
 * alters an account's second factor.
 *
 * Why a prompt at all: enabling, rotating or removing MFA used to need nothing
 * but a live session, which meant a stolen session cookie could strip the exact
 * protection the account was relying on — silently, with no signal to the owner
 * until they next opened their authenticator. The server now demands the actor's
 * password for those actions (custom_user_admin#assertActorPassword); this is the
 * only place the UI can collect it.
 *
 * The value is passed straight to the caller's onConfirm and never stored, logged,
 * or put into component state that outlives the dialog — it is cleared whenever
 * the dialog closes.
 */
export default function PasswordConfirmDialog({
  isOpen,
  title = 'Confirm your password',
  description = 'Re-enter your password to continue.',
  confirmLabel = 'Confirm',
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}) {
  const [password, setPassword] = useState('');
  const inputRef = useRef(null);

  // Clear on every open/close transition so a password cannot survive into a
  // later, unrelated confirmation.
  useEffect(() => {
    setPassword('');
    if (isOpen) {
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [isOpen]);

  if (!isOpen) return null;

  const submit = (e) => {
    e.preventDefault();
    if (!password || busy) return;
    onConfirm(password);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="password-confirm-title"
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl border border-gray-100"
      >
        <div className="flex items-center gap-3">
          <div className="rounded-full bg-amber-100 p-2.5 text-amber-700">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div>
            <h3 id="password-confirm-title" className="text-lg font-bold text-gray-900">{title}</h3>
            <p className="text-xs text-gray-500">Security check</p>
          </div>
        </div>

        <p className="mt-4 text-sm text-gray-600">{description}</p>

        <label className="mt-4 block text-sm font-medium text-gray-700" htmlFor="password-confirm-input">
          Your password
        </label>
        <input
          id="password-confirm-input"
          ref={inputRef}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 disabled:bg-gray-50"
        />

        {/* The server's exact refusal, shown verbatim: "your current password is
            incorrect" and "MFA is not enabled for this user" are different
            problems and collapsing them into one message would leave the user
            retyping a password that was never the issue. */}
        {error ? (
          <p className="mt-2 text-sm text-red-600" role="alert">{error}</p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!password || busy}
            className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
