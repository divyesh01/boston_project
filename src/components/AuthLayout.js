import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from "react";
export default function AuthLayout(
/** @type {{
 *   icon: import('react').ComponentType<{ className?: string }>;
 *   title: string;
 *   subtitle?: import('react').ReactNode;
 *   footer?: import('react').ReactNode;
 *   children?: import('react').ReactNode;
 * }} */
{ icon: Icon, title, subtitle, footer, children }) {
    return (_jsx("div", { className: "flex min-h-screen items-center justify-center bg-[#040D1A] px-4", children: _jsxs("div", { className: "w-full max-w-md", children: [_jsxs("div", { className: "mb-10 text-center", children: [_jsx("div", { className: "mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[#6C63FF]", children: _jsx(Icon, { className: "h-7 w-7 text-white", "aria-hidden": "true" }) }), _jsx("h1", { className: "text-3xl font-bold tracking-tight text-white", children: title }), subtitle && _jsx("p", { className: "mt-2 text-slate-400", children: subtitle })] }), _jsx("div", { className: "rounded-2xl border border-white/10 bg-[#0F1F35] p-8 shadow-lg", children: children }), footer && (_jsx("p", { className: "mt-6 text-center text-sm text-slate-500", children: footer }))] }) }));
}
