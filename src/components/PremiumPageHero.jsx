import React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, Sparkles } from "lucide-react";

const ACCENTS = {
  violet: { glow: "rgba(139, 92, 246, 0.28)", line: "rgba(167, 139, 250, 0.38)" },
  cyan: { glow: "rgba(6, 182, 212, 0.24)", line: "rgba(34, 211, 238, 0.36)" },
  emerald: { glow: "rgba(16, 185, 129, 0.24)", line: "rgba(52, 211, 153, 0.36)" },
};

/**
 * Scoped premium hero for high-value analytics pages. Decorative layers never
 * receive pointer events, and all spatial motion is removed when requested.
 */
export default function PremiumPageHero({
  eyebrow,
  title,
  description,
  meta,
  icon: Icon,
  accent = "violet",
  actions = [],
  controls = null,
}) {
  const reduceMotion = useReducedMotion();
  const palette = ACCENTS[accent] || ACCENTS.violet;

  return (
    <section
      className="relative isolate overflow-hidden rounded-[28px] border border-[var(--line)] bg-[var(--s-raised)] shadow-[var(--elev-3)]"
      aria-labelledby={`premium-hero-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-90"
        style={{
          background: `radial-gradient(circle at 82% 20%, ${palette.glow}, transparent 32%), linear-gradient(120deg, transparent 35%, rgba(255,255,255,0.035), transparent 68%)`,
        }}
      />
      <div className="relative grid min-h-[260px] gap-8 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-center lg:p-10">
        <div className="max-w-3xl">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--s-overlay)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--t-secondary)]">
            <Sparkles aria-hidden="true" className="h-3.5 w-3.5 text-[var(--brand)]" />
            {eyebrow}
          </div>
          <h1
            id={`premium-hero-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
            className="max-w-2xl text-balance font-heading text-3xl font-semibold leading-tight text-[var(--t-primary)] sm:text-4xl lg:text-5xl"
          >
            {title}
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-[var(--t-secondary)] sm:text-base">
            {description}
          </p>
          {meta && <p className="mt-3 text-xs leading-5 text-[var(--t-tertiary)]">{meta}</p>}

          {(actions.length > 0 || controls) && (
            <div className="mt-7 flex flex-wrap items-center gap-3">
              {actions.map(({ label, onClick, icon: ActionIcon = ArrowUpRight, variant = "secondary", disabled = false }) => (
                <button
                  key={label}
                  type="button"
                  onClick={onClick}
                  disabled={disabled}
                  className={[
                    "fx-clickable inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold transition-all duration-150",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--s-raised)]",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    variant === "primary"
                      ? "bg-gradient-to-b from-[#00FFA8] to-[#00E096] text-[#04241A] font-bold shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_6px_18px_rgba(0,224,150,0.28),0_1px_2px_rgba(0,0,0,0.25)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_8px_24px_rgba(0,224,150,0.4)] hover:-translate-y-0.5 active:translate-y-[1px] active:shadow-[inset_0_2px_4px_rgba(0,0,0,0.3)]"
                      : "border border-[var(--line-strong)] bg-gradient-to-b from-[var(--s-overlay)] to-[var(--s-raised)] text-[var(--t-primary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),var(--elev-1)] hover:border-white/20 hover:bg-[var(--s-hover)] hover:-translate-y-0.5 active:translate-y-[1px] active:shadow-[inset_0_2px_4px_rgba(0,0,0,0.35)]",
                  ].join(" ")}
                >
                  {ActionIcon && <ActionIcon aria-hidden="true" className="h-4 w-4" />}
                  <span>{label}</span>
                </button>
              ))}
              {controls}
            </div>
          )}
        </div>

        <div aria-hidden="true" className="pointer-events-none hidden items-center justify-center [perspective:1100px] lg:flex">
          <motion.div
            className="relative h-52 w-52 [transform-style:preserve-3d]"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, rotateX: 18, rotateY: -22, y: 18 }}
            animate={{ opacity: 1, rotateX: 0, rotateY: 0, y: 0 }}
            transition={{ duration: reduceMotion ? 0.16 : 0.7, ease: [0.16, 1, 0.3, 1] }}
          >
            <div
              className="absolute inset-5 rounded-[30px] border bg-[var(--s-overlay)] shadow-[var(--elev-3)] [transform:translateZ(34px)_rotate(-4deg)]"
              style={{ borderColor: palette.line }}
            />
            <div className="absolute inset-10 rounded-[26px] border border-[var(--line)] bg-[var(--s-hover)] [transform:translateZ(58px)_rotate(5deg)]" />
            <div
              className="absolute inset-[62px] grid place-items-center rounded-2xl border bg-[var(--s-raised)] shadow-[var(--elev-2)] [transform:translateZ(82px)]"
              style={{ borderColor: palette.line }}
            >
              {Icon && <Icon className="h-12 w-12 text-[var(--brand)]" strokeWidth={1.5} />}
            </div>
            <div className="absolute bottom-7 left-9 right-9 h-px bg-gradient-to-r from-transparent via-[var(--brand)] to-transparent opacity-70 [transform:translateZ(92px)]" />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
