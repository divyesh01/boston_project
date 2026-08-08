import React, { useState, useEffect } from "react";
import { Outlet, Link, useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  LayoutDashboard, GitCompareArrows, Grid3x3, BarChart3, Upload, Building2,
  Users, CreditCard, Settings as SettingsIcon, MoreHorizontal, X, ArrowLeft,
  CalendarDays, TrendingUp, Wallet, ClipboardList, Radio, FileSpreadsheet, LineChart, Table2,
  ShieldCheck, ScrollText, LogOut, KeyRound, BrainCircuit,
} from "lucide-react";
import AIAssistant from "@/components/AIAssistant";
import { GlobalFiltersProvider, useGlobalFilters } from "@/lib/useGlobalFilters";
import GlobalControlBar from "@/components/GlobalControlBar";
import { useAuth } from "@/lib/AuthContext";

const NAV = [
  { to: "/", label: "Executive Hub", icon: LayoutDashboard, short: "Dashboard" },
  { to: "/upload", label: "Import Reports", icon: Upload, short: "Upload" },
  { to: "/mtd", label: "MTD Growth", icon: TrendingUp, short: "MTD" },
  { to: "/calendar", label: "Monthly Calendar", icon: CalendarDays, short: "Calendar" },
  { to: "/compare", label: "Period Compare", icon: GitCompareArrows, short: "Compare" },
  { to: "/data-intelligence", label: "Data Intelligence", icon: BrainCircuit, short: "Data AI" },
  { to: "/rooms", label: "Room Board", icon: Grid3x3, short: "Rooms" },
  { to: "/employees", label: "Clerk Audit", icon: Users, short: "Employees" },
  { to: "/payments", label: "Payments", icon: CreditCard, short: "Payments" },
  { to: "/ota", label: "OTA Channels", icon: Radio, short: "OTA" },
  { to: "/charts", label: "Chart Builder", icon: BarChart3, short: "Charts" },
  { to: "/expenses", label: "Expenses", icon: Wallet, short: "Expenses" },
  { to: "/payroll", label: "Payroll", icon: ClipboardList, short: "Payroll" },
  { to: "/manual-entry", label: "Manual Entry", icon: Table2, short: "Manual" },
  { to: "/forecasting", label: "Forecasting", icon: LineChart, short: "Forecast" },
  { to: "/data-template", label: "Data Template", icon: FileSpreadsheet, short: "Template" },
  { to: "/users", label: "User Management", icon: ShieldCheck, short: "Users" },
  { to: "/audit-log", label: "Audit Log", icon: ScrollText, short: "Audit Log" },
  { to: "/settings", label: "Settings", icon: SettingsIcon, short: "Settings" },
];

const PRIMARY = NAV.slice(0, 4);
const MORE = NAV.slice(4);

function SidebarBrand() {
  const { property, properties } = useGlobalFilters();
  const isPortfolio = property === "all";
  const prop = isPortfolio ? null : properties.find((p) => p.id === property);
  const name = isPortfolio ? "Red Roof Portfolio" : (prop?.name || "Red Roof Executive");
  const detail = isPortfolio ? `${properties.length} properties` : `Code ${prop?.code || "—"} · ${prop?.rooms || 100} rooms`;
  return (
    <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
      {name}
      <br />
      <span className="text-slate-600">{detail}</span>
    </p>
  );
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
    } catch (e) {}
  }, [pathname]);

  const transitions = reduceMotion
    ? { duration: 0.1 }
    : { duration: 0.2, ease: "easeOut" };
  const initial = reduceMotion ? { opacity: 0 } : { opacity: 0, x: 20 };
  const animate = reduceMotion ? { opacity: 1 } : { opacity: 1, x: 0 };
  const exit = reduceMotion ? { opacity: 0 } : { opacity: 0, x: -20 };

  return (
    <GlobalFiltersProvider>
    <div className="min-h-screen bg-[#040D1A] font-body text-slate-200">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-white/5 bg-[#0A1628] p-6 lg:block">
        <div className="flex items-center gap-2">
          <Building2 className="h-5 w-5 text-[#6C63FF]" />
          <span className="font-heading text-sm font-semibold tracking-wide text-white">RRI Executive</span>
        </div>
        <SidebarBrand />
        <nav className="mt-8 space-y-1">
          {visibleNav.map(({ to, label, icon: Icon }) => {
            const a = pathname === to;
            return (
              <Link
                key={to}
                to={to}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all duration-200 ${
                  a ? "bg-[#6C63FF]/15 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-100"
                }`}
              >
                <Icon className={`h-4 w-4 ${a ? "text-[#00D4FF]" : ""}`} />
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="absolute inset-x-6 bottom-6 space-y-3">
          {user && (
            <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/5 px-3 py-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#6C63FF]/30 text-xs font-bold text-white">
                {(user.full_name || user.username || "?").slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-slate-200">{user.full_name || user.username}</p>
                <p className="truncate text-[10px] uppercase tracking-wide text-slate-500">{user.role?.replace("_", " ") || ""}</p>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Link
              to="/change-password"
              className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300 transition-colors hover:bg-white/5"
            >
              <KeyRound className="h-3.5 w-3.5" /> Change Password
            </Link>
            <button
              onClick={() => logout(true)}
              className="flex items-center justify-center gap-2 rounded-xl border border-red-500/30 px-3 py-2 text-xs text-red-300 transition-colors hover:bg-red-500/10"
            >
              <LogOut className="h-3.5 w-3.5" /> Logout
            </button>
          </div>
        </div>
      </aside>

      <div className="lg:pl-64">
        {/* Mobile top header bar */}
        <header
          className="sticky top-0 z-30 flex items-center gap-2 border-b border-white/5 bg-[#0A1628]/95 px-4 backdrop-blur lg:hidden"
          style={{
            paddingTop: "env(safe-area-inset-top)",
            height: "calc(3.5rem + env(safe-area-inset-top))",
          }}
        >
          {!isPrimary && (
            <button
              onClick={() => navigate(-1)}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-white/5 hover:text-white"
              aria-label="Go back"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <Building2 className="h-4 w-4 shrink-0 text-[#6C63FF]" />
          <span className="truncate font-heading text-sm font-semibold text-white">
            {active?.short || "RRI Executive"}
          </span>
        </header>

        <main className="mx-auto max-w-[1400px] px-4 pb-[calc(5rem+env(safe-area-inset-bottom))] pt-6 sm:px-8 lg:py-8">
          <GlobalControlBar />
          <AnimatePresence mode="wait">
            <motion.div
              key={pathname}
              data-page-content
              initial={initial}
              animate={animate}
              exit={exit}
              transition={transitions}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>

        {/* Mobile bottom tab bar */}
        <nav
          className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-white/10 bg-[#0A1628]/95 backdrop-blur lg:hidden"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          {PRIMARY.filter((n) => canAccessRoute(n.to)).map(({ to, short, icon: Icon }) => (
            <button
              key={to}
              onClick={() => {
                if (pathname === to) {
                  navigate(to);
                  return;
                }
                try {
                  const hist = JSON.parse(sessionStorage.getItem("rri_tab_history") || "{}");
                  navigate(hist[to] || to);
                } catch {
                  navigate(to);
                }
              }}
              className={`flex min-h-[44px] flex-1 flex-col items-center gap-1 py-3 text-[10px] ${
                pathname === to ? "text-[#00D4FF]" : "text-slate-500"
              }`}
            >
              <Icon className="h-5 w-5" />
              {short}
            </button>
          ))}
          <button
            onClick={() => setMoreOpen(true)}
            className={`flex min-h-[44px] flex-1 flex-col items-center gap-1 py-3 text-[10px] ${
              inMore ? "text-[#00D4FF]" : "text-slate-500"
            }`}
          >
            <MoreHorizontal className="h-5 w-5" />
            More
          </button>
        </nav>

        {/* More menu — bottom sheet */}
        {moreOpen && (
          <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMoreOpen(false)}>
            <div className="absolute inset-0 bg-black/60" />
            <div
              className="absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-white/10 bg-[#0F1F35] p-4"
              style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-center justify-between">
                <span className="font-heading text-sm font-semibold text-white">More</span>
                <button onClick={() => setMoreOpen(false)} className="text-slate-400 hover:text-white">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {MORE.filter((n) => canAccessRoute(n.to)).map(({ to, short, icon: Icon }) => (
                  <Link
                    key={to}
                    to={to}
                    onClick={() => setMoreOpen(false)}
                    className={`flex min-h-[72px] flex-col items-center gap-2 rounded-xl border px-2 py-4 text-xs ${
                      pathname === to
                        ? "border-[#6C63FF] bg-[#6C63FF]/15 text-white"
                        : "border-white/10 bg-[#0A1628] text-slate-400"
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                    {short}
                  </Link>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <AIAssistant />
      </div>
      </GlobalFiltersProvider>
  );
}