import { Link, useLocation } from "react-router-dom";

export default function PageNotFound() {
  const { pathname } = useLocation();
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--s-canvas)] p-6">
      <div className="w-full max-w-md space-y-5 text-center">
        <p className="text-6xl font-heading text-[var(--t-tertiary)]">404</p>
        <h1 className="text-2xl font-semibold text-white">Page not found</h1>
        <p className="break-words text-sm leading-relaxed text-slate-400">The address {pathname} does not match a page. Use the Executive Hub to find what you need.</p>
        <Link to="/" className="inline-flex min-h-11 items-center rounded-lg bg-[var(--brand)] px-5 py-3 text-sm font-medium text-[var(--brand-ink)]">Go to Executive Hub</Link>
      </div>
    </main>
  );
}
