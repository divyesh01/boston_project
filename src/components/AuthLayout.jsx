import React from "react";
import { Link } from "react-router-dom";

export default function AuthLayout(
  /** @type {{
   *   icon: import('react').ComponentType<{ className?: string }>;
   *   title: string;
   *   subtitle?: import('react').ReactNode;
   *   footer?: import('react').ReactNode;
   *   children?: import('react').ReactNode;
   * }} */
  { icon: Icon, title, subtitle, footer, children }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#040D1A] px-4">
      <div className="w-full max-w-md">
        <div className="mb-10 text-center">
          <div className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[#6C63FF]">
            <Icon className="h-7 w-7 text-white" aria-hidden="true" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-white">{title}</h1>
          {subtitle && <p className="mt-2 text-slate-400">{subtitle}</p>}
        </div>
        <div className="rounded-2xl border border-white/10 bg-[#0F1F35] p-8 shadow-lg">
          {children}
        </div>
        {footer && (
          <p className="mt-6 text-center text-sm text-slate-500">{footer}</p>
        )}
        <div className="mt-4 text-center text-xs text-slate-500">
          <Link to="/privacy" className="hover:text-slate-300 hover:underline">Privacy Policy</Link>
          <span className="mx-2">•</span>
          <Link to="/terms" className="hover:text-slate-300 hover:underline">Terms of Service</Link>
        </div>
      </div>
    </div>
  );
}