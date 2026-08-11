import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useState, useEffect } from "react";
import { Outlet, Link, useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Building2, MoreHorizontal, X, ArrowLeft, LogOut, KeyRound } from "lucide-react";
import AIAssistant from "@/components/AIAssistant";
import { GlobalFiltersProvider, useGlobalFilters } from "@/lib/useGlobalFilters";
import GlobalControlBar from "@/components/GlobalControlBar";
import { useAuth } from "@/lib/AuthContext";
import CommandMenu from "@/components/CommandMenu";
import { NAV, PRIMARY, MORE } from "@/lib/navigation";
function SidebarBrand() {
    const { property, properties } = useGlobalFilters();
    const isPortfolio = property === "all";
    const prop = isPortfolio ? null : properties.find((p) => p.id === property);
    const name = isPortfolio ? "Red Roof Portfolio" : (prop?.name || "Red Roof Executive");
    const detail = isPortfolio ? `${properties.length} properties` : `Code ${prop?.code || "—"} · ${prop?.rooms || 100} rooms`;
    return (_jsxs("p", { className: "mt-2 text-[11px] leading-relaxed text-slate-500", children: [name, _jsx("br", {}), _jsx("span", { className: "text-slate-600", children: detail })] }));
}
export default function Layout() {
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const { canAccessRoute, hasPermission, user, logout } = useAuth();
    const [moreOpen, setMoreOpen] = useState(false);
    const visibleNav = NAV.filter((n) => canAccessRoute(n.to));
    const active = NAV.find((n) => n.to === pathname);
    const isPrimary = PRIMARY.some((n) => n.to === pathname && canAccessRoute(n.to));
    const inMore = MORE.some((n) => n.to === pathname && canAccessRoute(n.to));
    const reduceMotion = useReducedMotion();
    useEffect(() => {
        const handler = () => setMoreOpen(false);
        window.addEventListener("popstate", handler);
        return () => window.removeEventListener("popstate", handler);
    }, []);
    useEffect(() => {
        try {
            const hist = JSON.parse(sessionStorage.getItem("rri_tab_history") || "{}");
            const group = PRIMARY.find((p) => pathname === p.to || pathname.startsWith(p.to + "/"));
            if (group) {
                hist[group.to] = pathname;
                sessionStorage.setItem("rri_tab_history", JSON.stringify(hist));
            }
        }
        catch (e) { }
    }, [pathname]);
    const transitions = reduceMotion
        ? { duration: 0.1 }
        : { duration: 0.2, ease: "easeOut" };
    const initial = reduceMotion ? { opacity: 0 } : { opacity: 0, x: 20 };
    const animate = reduceMotion ? { opacity: 1 } : { opacity: 1, x: 0 };
    const exit = reduceMotion ? { opacity: 0 } : { opacity: 0, x: -20 };
    return (_jsx(GlobalFiltersProvider, { children: _jsxs("div", { className: "min-h-screen bg-[#040D1A] font-body text-slate-200", children: [_jsxs("aside", { className: "fixed inset-y-0 left-0 hidden w-64 overflow-y-auto border-r border-white/5 bg-[#0A1628] p-6 lg:flex lg:flex-col", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Building2, { className: "h-5 w-5 text-[#6C63FF]" }), _jsx("span", { className: "font-heading text-sm font-semibold tracking-wide text-white", children: "RRI Executive" })] }), _jsx(SidebarBrand, {}), _jsx("nav", { className: "mt-8 flex-1 space-y-1 overflow-y-auto", children: visibleNav.map(({ to, label, icon: Icon }) => {
                                const a = pathname === to;
                                return (_jsxs(Link, { to: to, className: `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all duration-200 ${a ? "bg-[#6C63FF]/15 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-100"}`, children: [_jsx(Icon, { className: `h-4 w-4 ${a ? "text-[#00D4FF]" : ""}` }), label] }, to));
                            }) }), _jsxs("div", { className: "mt-auto pt-4 space-y-3", children: [user && (_jsxs("div", { className: "flex items-center gap-3 rounded-xl border border-white/5 bg-white/5 px-3 py-2.5", children: [_jsx("div", { className: "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#6C63FF]/30 text-xs font-bold text-white", children: (user.full_name || user.username || "?").slice(0, 1).toUpperCase() }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: "truncate text-xs font-medium text-slate-200", children: user.full_name || user.username }), _jsx("p", { className: "truncate text-[10px] uppercase tracking-wide text-slate-500", children: user.role?.replace("_", " ") || "" })] })] })), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs(Link, { to: "/change-password", className: "flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300 transition-colors hover:bg-white/5", children: [_jsx(KeyRound, { className: "h-3.5 w-3.5" }), " Change Password"] }), _jsxs("button", { onClick: () => logout(true), className: "flex items-center justify-center gap-2 rounded-xl border border-red-500/30 px-3 py-2 text-xs text-red-300 transition-colors hover:bg-red-500/10", children: [_jsx(LogOut, { className: "h-3.5 w-3.5" }), " Logout"] })] })] })] }), _jsxs("div", { className: "lg:pl-64", children: [_jsxs("header", { className: "sticky top-0 z-30 flex items-center gap-2 border-b border-white/5 bg-[#0A1628]/95 px-4 backdrop-blur lg:hidden", style: {
                                paddingTop: "env(safe-area-inset-top)",
                                height: "calc(3.5rem + env(safe-area-inset-top))",
                            }, children: [!isPrimary && (_jsx("button", { onClick: () => navigate(-1), className: "flex h-11 w-11 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-white/5 hover:text-white", "aria-label": "Go back", children: _jsx(ArrowLeft, { className: "h-5 w-5" }) })), _jsx(Building2, { className: "h-4 w-4 shrink-0 text-[#6C63FF]" }), _jsx("span", { className: "truncate font-heading text-sm font-semibold text-white", children: active?.short || "RRI Executive" })] }), _jsxs("main", { className: "mx-auto max-w-[1400px] px-4 pb-[calc(5rem+env(safe-area-inset-bottom))] pt-6 sm:px-8 lg:py-8", children: [_jsx(GlobalControlBar, {}), _jsx(AnimatePresence, { mode: "wait", children: _jsx(motion.div, { "data-page-content": true, initial: initial, animate: animate, exit: exit, transition: transitions, children: _jsx(Outlet, {}) }, pathname) })] }), _jsxs("nav", { className: "fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-white/10 bg-[#0A1628]/95 backdrop-blur lg:hidden", style: { paddingBottom: "env(safe-area-inset-bottom)" }, children: [PRIMARY.filter((n) => canAccessRoute(n.to)).map(({ to, short, icon: Icon }) => (_jsxs("button", { onClick: () => {
                                        if (pathname === to) {
                                            navigate(to);
                                            return;
                                        }
                                        try {
                                            const hist = JSON.parse(sessionStorage.getItem("rri_tab_history") || "{}");
                                            navigate(hist[to] || to);
                                        }
                                        catch {
                                            navigate(to);
                                        }
                                    }, className: `flex min-h-[44px] flex-1 flex-col items-center gap-1 py-3 text-[10px] ${pathname === to ? "text-[#00D4FF]" : "text-slate-500"}`, children: [_jsx(Icon, { className: "h-5 w-5" }), short] }, to))), _jsxs("button", { onClick: () => setMoreOpen(true), className: `flex min-h-[44px] flex-1 flex-col items-center gap-1 py-3 text-[10px] ${inMore ? "text-[#00D4FF]" : "text-slate-500"}`, children: [_jsx(MoreHorizontal, { className: "h-5 w-5" }), "More"] })] }), moreOpen && (_jsxs("div", { className: "fixed inset-0 z-40 lg:hidden", onClick: () => setMoreOpen(false), children: [_jsx("div", { className: "absolute inset-0 bg-black/60" }), _jsxs("div", { className: "absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-white/10 bg-[#0F1F35] p-4", style: { paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }, onClick: (e) => e.stopPropagation(), children: [_jsxs("div", { className: "mb-4 flex items-center justify-between", children: [_jsx("span", { className: "font-heading text-sm font-semibold text-white", children: "More" }), _jsx("button", { onClick: () => setMoreOpen(false), className: "text-slate-400 hover:text-white", children: _jsx(X, { className: "h-5 w-5" }) })] }), _jsx("div", { className: "grid grid-cols-3 gap-3", children: MORE.filter((n) => canAccessRoute(n.to)).map(({ to, short, icon: Icon }) => (_jsxs(Link, { to: to, onClick: () => setMoreOpen(false), className: `flex min-h-[72px] flex-col items-center gap-2 rounded-xl border px-2 py-4 text-xs ${pathname === to
                                                    ? "border-[#6C63FF] bg-[#6C63FF]/15 text-white"
                                                    : "border-white/10 bg-[#0A1628] text-slate-400"}`, children: [_jsx(Icon, { className: "h-5 w-5" }), short] }, to))) })] })] }))] }), _jsx(AIAssistant, {}), _jsx(CommandMenu, {})] }) }));
}
