import React, { useState, useEffect, lazy, Suspense } from "react";
import { Outlet, Link, useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Building2, MoreHorizontal, X, ArrowLeft, LogOut, KeyRound } from "lucide-react";
import { DURATION, EASE_OUT, fadeOnly } from "@/lib/motion";
const AIAssistant = lazy(() => import("@/components/AIAssistant"));
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
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 overflow-y-auto border-r border-white/5 bg-[#0A1628] p-6 lg:flex lg:flex-col">
        <div className="flex items-center gap-2">
          <Building2 className="h-5 w-5 text-[#6C63FF]" />
          <span className="font-heading text-sm font-semibold tracking-wide text-white">RRI Executive</span>
        </div>
        <SidebarBrand />
        <nav className="mt-8 flex-1 space-y-1 overflow-y-auto">
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
              onClick={() => logout(true)}
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

        {/* More menu — bottom sheet.
            The only hand-rolled overlay in the app (the Radix dialogs animate
            themselves via tailwindcss-animate). It used to pop in and out with
            no transition at all; AnimatePresence is needed rather than a CSS
            class because the close is the half that was missing. */}
        <AnimatePresence>
          {moreOpen && (
            /* Keyed explicitly: AnimatePresence identifies children by
               `child.key || ""`, so a keyless child works only while it is the
               sole child. A real key keeps that from becoming a trap. */
            <div key="more-sheet" className="fixed inset-0 z-40 lg:hidden" onClick={() => setMoreOpen(false)}>
              <motion.div
                className="absolute inset-0 bg-black/60"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: DURATION.fast / 1000, ease: EASE_OUT }}
              />
              <motion.div
                className="absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-white/10 bg-[#0F1F35] p-4"
                style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
                onClick={(e) => e.stopPropagation()}
                // A sheet is the one place a longer travel is right — it comes
                // from off-screen, so it animates its own height rather than a
                // token distance. Reduced motion drops to a plain cross-fade.
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: "100%" }}
                animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: "100%" }}
                transition={{ duration: DURATION.slow / 1000, ease: EASE_OUT }}
              >
              <div className="mb-4 flex items-center justify-between">
                <span className="font-heading text-sm font-semibold text-white">More</span>
                <button onClick={() => setMoreOpen(false)} aria-label="Close menu" className="text-slate-400 hover:text-white">
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
              <div className="mt-3 flex items-center justify-center gap-4 border-t border-white/10 pt-3 text-xs text-slate-400">
                <Link to="/privacy" onClick={() => setMoreOpen(false)} className="hover:text-white hover:underline">Privacy</Link>
                <Link to="/terms" onClick={() => setMoreOpen(false)} className="hover:text-white hover:underline">Terms</Link>
              </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>

      <Suspense fallback={null}>
        <AIAssistant />
      </Suspense>
      <CommandMenu />
      </div>
      </GlobalFiltersProvider>
  );
}