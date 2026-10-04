import React, { useState, useEffect, lazy, Suspense } from "react";
import { Outlet, Link, useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Building2, MoreHorizontal, ArrowLeft, LogOut, KeyRound, ChevronDown } from "lucide-react";
import { DURATION, fadeOnly } from "@/lib/motion";
const AIAssistant = lazy(() => import("@/components/AIAssistant"));
import { GlobalFiltersProvider, useGlobalFilters } from "@/lib/useGlobalFilters";
import GlobalControlBar from "@/components/GlobalControlBar";
import { useAuth } from "@/lib/AuthContext";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import CommandMenu from "@/components/CommandMenu";
import { NAV, PRIMARY, MORE } from "@/lib/navigation";
import { useRealtimeInvalidation, APP_SYNC_PREFIXES } from "@/lib/realtime";
import { pullRemoteSettings } from "@/lib/settingsStore";

function SidebarBrand() {
  const { property, properties } = useGlobalFilters();
  const selected = properties.filter((p) => property === "all" || (Array.isArray(property) ? property.map(String).includes(String(p.id)) : String(p.id) === String(property)));
  const multiple = property === "all" || selected.length > 1;
  const prop = selected.length === 1 ? selected[0] : null;
  const name = multiple ? "Red Roof Portfolio" : (prop?.name || "Red Roof Executive");
  const rooms = Number(prop?.rooms);
  const detail = multiple ? `${selected.length} properties selected` : (prop ? `Code ${prop.code || "Unavailable"} / ${Number.isFinite(rooms) && rooms > 0 ? `${rooms} rooms` : "Room count unavailable"}` : "Select a property");
  return (
    <p className="mt-2 text-xs leading-relaxed text-[var(--t-tertiary)]">
      {name}
      <br />
      <span className="text-[var(--t-tertiary)]">{detail}</span>
    </p>
  );
}

export default function Layout() {
  // Profile-wide sync coordinator: exactly one registration with the union of
  // every page-level prefix, so server synchronization runs on every
  // authenticated page — not only the six pages that mount their own hook.
  // Page hooks keep working unchanged; the shared loop polls once per tab.
  useRealtimeInvalidation(APP_SYNC_PREFIXES);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { canAccessRoute, user, logout } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);
  const active = NAV.find((n) => n.to === pathname);
  const isPrimary = PRIMARY.some((n) => n.to === pathname && canAccessRoute(n.to));
  const inMore = MORE.some((n) => n.to === pathname && canAccessRoute(n.to));
  const [showAllTools, setShowAllTools] = useState(inMore);
  useEffect(() => {
    if (inMore) setShowAllTools(true);
  }, [inMore]);
  const coreVisible = PRIMARY.filter((n) => canAccessRoute(n.to));
  const moreVisible = MORE.filter((n) => canAccessRoute(n.to));
  const mobilePrimary = coreVisible.slice(0, 4);
  const mobileMore = [...coreVisible.slice(4), ...moreVisible];
  const mobileMoreActive = mobileMore.some((n) => n.to === pathname);
  const reduceMotion = useReducedMotion();

  // Reconcile cloud settings (taxes, commissions, fees) with local storage on load
  useEffect(() => {
    pullRemoteSettings();
  }, []);

  useEffect(() => { setMoreOpen(false); }, [pathname]);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = () => { if (desktop.matches) setMoreOpen(false); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

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
    } catch {
      // Deliberately silent, and it must stay that way. This remembers which
      // sub-route you were last on inside a nav group so the tab returns you
      // there; losing it costs a nicety, nothing more. The effect runs on EVERY
      // navigation, so reporting a blocked sessionStorage (private browsing,
      // storage disabled) would put an error in the console — or a toast on
      // screen — on every single click, describing a feature the owner never
      // asked about. Contrast settingsStore.js, where a swallowed write changes
      // money figures and therefore must be loud.
    }
  }, [pathname]);

  // Page transitions now come from the shared motion tokens, so navigation uses
  // the same curve and timing as every card entrance instead of its own numbers.
  //
  // The container CROSS-FADES ONLY — the travel belongs to the cards inside it,
  // which each rise 10px via `.fx-enter`. This used to slide the whole page 20px
  // horizontally; stacked on top of the card rise that came to 20px+ of combined
  // travel on two axes, well past the 8-12px the house style allows.
  const pageMotion = fadeOnly(reduceMotion ? DURATION.fast : DURATION.base);

  return (
    <GlobalFiltersProvider>
    <div className="min-h-screen bg-[#040D1A] font-body text-slate-200">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 overflow-y-auto border-r border-white/5 bg-[#0A1628] p-6 lg:flex lg:flex-col">
        <div className="flex items-center gap-2">
          <Building2 className="h-5 w-5 text-[#6C63FF]" />
          <span className="font-heading text-sm font-semibold tracking-wide text-white">RRI Executive</span>
        </div>
        <SidebarBrand />
        <nav aria-label="Main navigation" className="mt-6 flex-1 space-y-1 overflow-y-auto pr-1">
          <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Owner Intelligence
          </p>
          {coreVisible.map(({ to, label, icon: Icon }) => {
            const a = pathname === to;
            return (
              <Link
                key={to}
                to={to}
                aria-current={a ? "page" : undefined}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all duration-200 ${
                  a ? "bg-[#6C63FF]/15 text-white font-medium" : "text-slate-400 hover:bg-white/5 hover:text-slate-100"
                }`}
              >
                <Icon className={`h-4 w-4 ${a ? "text-[#00D4FF]" : ""}`} />
                {label}
              </Link>
            );
          })}

          <div className="pt-4 border-t border-white/5 mt-4">
            <button
              type="button"
              aria-expanded={showAllTools}
              aria-controls="operational-navigation"
              onClick={() => setShowAllTools((prev) => !prev)}
              className="flex w-full items-center justify-between px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-300 transition-colors"
            >
              <span>Operational Tools ({moreVisible.length})</span>
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAllTools ? "rotate-180" : ""}`} />
            </button>
            {showAllTools && (
              <div id="operational-navigation" className="mt-1 space-y-0.5">
                {moreVisible.map(({ to, label, icon: Icon }) => {
                  const a = pathname === to;
                  return (
                    <Link
                      key={to}
                      to={to}
                      aria-current={a ? "page" : undefined}
                      className={`flex items-center gap-3 rounded-xl px-3 py-3 text-sm transition-all duration-200 ${
                        a ? "bg-[#6C63FF]/15 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-100"
                      }`}
                    >
                      <Icon className={`h-3.5 w-3.5 ${a ? "text-[#00D4FF]" : ""}`} />
                      {label}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </nav>
        <div className="mt-auto pt-4 space-y-3">
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
              onClick={async () => {
                await logout(false);
                window.location.href = "/cdn-cgi/access/logout";
              }}
              className="flex items-center justify-center gap-2 rounded-xl border border-red-500/30 px-3 py-2 text-xs text-red-300 transition-colors hover:bg-red-500/10"
            >
              <LogOut className="h-3.5 w-3.5" /> Logout
            </button>

          </div>
          <div className="flex items-center justify-center gap-3 border-t border-white/5 pt-3 text-[10px] text-slate-500">
            <Link to="/privacy" className="transition-colors hover:text-slate-300 hover:underline">Privacy Policy</Link>
            <span>•</span>
            <Link to="/terms" className="transition-colors hover:text-slate-300 hover:underline">Terms of Service</Link>
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
              onClick={() => {
                if (window.history.state?.idx > 0) navigate(-1);
                else navigate("/");
              }}
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

        <main id="main-content" tabIndex={-1} className="mx-auto max-w-[1400px] px-4 pb-[calc(5rem+env(safe-area-inset-bottom))] pt-6 sm:px-8 lg:py-8">
          <GlobalControlBar />
          <AnimatePresence mode="wait">
            <motion.div
              key={pathname}
              data-page-content
              initial={pageMotion.initial}
              animate={pageMotion.animate}
              exit={pageMotion.exit}
              transition={pageMotion.transition}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>

        {/* Mobile bottom tab bar */}
        <nav
          aria-label="Mobile navigation"
          className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-white/10 bg-[#0A1628]/95 backdrop-blur lg:hidden"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          {mobilePrimary.map(({ to, short, icon: Icon }) => (
            <button
              key={to}
              type="button"
              aria-current={pathname === to ? "page" : undefined}
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
                pathname === to ? "text-[#00D4FF]" : "text-slate-400"
              }`}
            >
              <Icon className="h-5 w-5" />
              {short}
            </button>
          ))}
          <button
            type="button"
            id="mobile-more-trigger"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(true)}
            className={`flex min-h-[44px] flex-1 flex-col items-center gap-1 py-3 text-[10px] ${
              mobileMoreActive ? "text-[#00D4FF]" : "text-slate-400"
            }`}
          >
            <MoreHorizontal className="h-5 w-5" />
            More
          </button>
        </nav>

        <DialogPrimitive.Root open={moreOpen} onOpenChange={setMoreOpen}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60" />
            <DialogPrimitive.Content
              className="fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-3xl border-t border-white/10 bg-[#0F1F35] p-4"
              style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                document.getElementById("mobile-more-trigger")?.focus();
              }}
            >
              <div className="mb-4 flex items-center justify-between gap-4">
                <DialogPrimitive.Title className="font-heading text-sm font-semibold text-white">All pages</DialogPrimitive.Title>
                <DialogPrimitive.Close className="min-h-11 rounded-lg px-3 text-sm text-slate-300 hover:bg-white/5">Close</DialogPrimitive.Close>
              </div>
              <DialogPrimitive.Description className="sr-only">Choose a page or manage your account.</DialogPrimitive.Description>
              <nav aria-label="More pages" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {mobileMore.map(({ to, label, icon: Icon }) => (
                  <Link key={to} to={to} aria-current={pathname === to ? "page" : undefined}
                    onClick={() => setMoreOpen(false)}
                    className={`flex min-h-[72px] flex-col items-center gap-2 rounded-xl border px-2 py-4 text-center text-xs ${pathname === to ? "border-[var(--brand)] bg-[var(--brand-quiet)] text-white" : "border-white/10 bg-[#0A1628] text-slate-300"}`}>
                    <Icon aria-hidden="true" className="h-5 w-5" />{label}
                  </Link>
                ))}
              </nav>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-3 border-t border-white/10 pt-3 text-sm text-slate-300">
                <Link className="min-h-11 px-3 py-3" to="/change-password" onClick={() => setMoreOpen(false)}>Change password</Link>
                <button type="button" className="min-h-11 px-3 text-red-300" onClick={async () => { await logout(false); window.location.href = "/cdn-cgi/access/logout"; }}>Logout</button>
                <Link className="min-h-11 px-3 py-3" to="/privacy" onClick={() => setMoreOpen(false)}>Privacy</Link>
                <Link className="min-h-11 px-3 py-3" to="/terms" onClick={() => setMoreOpen(false)}>Terms</Link>
              </div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      </div>

      <Suspense fallback={null}>
        <AIAssistant />
      </Suspense>
      <CommandMenu />
      </div>
      </GlobalFiltersProvider>
  );
}