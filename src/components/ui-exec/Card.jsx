import React from "react";

export default function Card(
  /** @type {{
   *   title?: import('react').ReactNode;
   *   subtitle?: import('react').ReactNode;
   *   right?: import('react').ReactNode;
   *   children?: import('react').ReactNode;
   *   className?: string;
   * }} */
  { title, subtitle, right, children, className = "" }) {
  return (
    <div
      className={`rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-5 shadow-[0_10px_40px_-20px_rgba(0,0,0,0.9)] transition-all duration-300 hover:border-white/10 hover:shadow-[0_18px_50px_-20px_rgba(108,99,255,0.35)] ${className}`}
    >
      {(title || right) && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h3 className="font-heading text-sm font-semibold tracking-wide text-white">{title}</h3>}
            {subtitle && <p className="mt-1 text-xs text-slate-400">{subtitle}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}