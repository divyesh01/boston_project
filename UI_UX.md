# UI/UX DIRECTIVES — USER FRICTION ANALYSIS & POLISH

## 1. USER PERSPECTIVE & FRICTION REDUCTION
- Evaluate features from the end-user's perspective: *"Is this layout clear? Is navigation smooth? Are controls intuitive?"*
- Eliminate confusing dropdowns, hidden filters, or dead UI controls that do not alter the underlying data view.

## 2. ERROR & EMPTY STATES
- Never allow components to crash into white screens or throw unhandled raw errors to the user.
- Provide clear, user-friendly empty states and inline status badges when data is absent or being filtered.

## 3. VISUAL & COMPONENT POLISH
- Cards, tables, inputs and modal dialogs take their surfaces, hairlines, shadows and text colours from the **design tokens in `src/index.css`** — never from a hex literal typed into a component. Amended 2026-08-19: this clause previously pinned `#0A1628` / `#0F1F35` / `#00E096` by hand, which had produced ~49 hard-coded hexes across `src/` and five accent colours competing at roughly equal weight (cyan 231 uses, green 230, coral 203, indigo 178, amber 141).
- **Surface ramp** (rises toward the viewer): `--s-canvas` page → `--s-raised` cards → `--s-overlay` inputs and nested wells → `--s-hover` hovered/pressed rows. Never invent a fourth surface.
- **Text ramp:** `--t-primary` figures and headings, `--t-secondary` body, `--t-tertiary` labels and captions. Do not go dimmer than `--t-tertiary`.
- **Hairlines, not borders:** `--line-subtle` / `--line` / `--line-strong`, or the `.u-hairline*` utilities. A solid grey border draws a box around a panel; a 6–8% white hairline separates it. Prefer the inset-box-shadow utilities on grid children, where a real `border` would shift layout by 1px.
- **Depth:** `--elev-1|2|3`, or `.u-elev-*`. Always multi-layer (contact shadow + ambient shadow + 1px inset top highlight). Never one large blur.
- **One chrome accent:** `--brand` (emerald `#00E096`) owns *all* chrome — focus rings, hover glows, active nav, KPI hairlines, selection. Do not introduce a second chrome accent.
- **The semantic data palette is LOCKED and is separate from chrome:** `--data-positive`, `--data-negative`, `--data-warning`, `--data-info`, `--data-violet`. These encode meaning, not decoration — a P&L where profit and loss share a hue is a lie, so they must never be collapsed into `--brand`. Anything encoded by one of these must **also** carry a non-colour cue (sign, arrow, or label): colour alone fails WCAG 1.4.1 and is unreadable for red/green colour-vision deficiency.
- **Measured contrast floors, not eyeballed:** 4.5:1 for body text, 3:1 for large text, graphical objects and focus indicators. `scripts/probe-premium-surfaces.mjs` recomputes every text-on-surface ratio (compositing alpha properly) and fails if any pair drops under its floor. `--data-violet` measures 4.28:1 on `--s-raised` and is therefore **graphics-only — never a text colour**.
- **Never reuse a shadcn token name with a different value type.** shadcn stores colours as bare HSL triples (`--accent: 0 0% 96.1%`) which `tailwind.config.js` wraps as `hsl(var(--accent))`. Redeclaring one as a hex later in the same `:root` wins the cascade and makes `hsl(#00E096)` invalid, silently blanking `bg-accent` / `hover:bg-accent` across 35 usages in 12 components. This is why the chrome accent is `--brand`, not `--accent`. The probe asserts it.
- **Glassmorphism is opt-in** (`<Card glass>` / `.u-glass`), not the default surface: `backdrop-filter` forces a compositing pass per element and these pages hold 30+ cards. The no-`backdrop-filter` fallback must stay opaque.
- **Financial and metric figures use `.u-figure`** (mono stack + `tabular-nums`). Fixed-advance digits are load-bearing, not cosmetic: without them every frame of the KPI count-up is a different width and the figure visibly jitters.
- Motion tokens (`--fx-*`) are owned by the motion system and asserted against `src/lib/motion.js` by `scripts/verify-motion.mjs`. Do not retune them as part of a visual change.
- Verify charts (Recharts) render accessible legends, accurate tooltips, and appropriate colour coding for revenue vs. expenses.

## 4. LUXURY 3D BUTTON SYSTEM DIRECTIVES
- **Centralized Definition**: The luxury 3D button system is centralized in `src/components/ui/button.jsx` (CVA variants) and depth tokens in `src/index.css`. Do not apply ad-hoc button styling in individual page files.
- **Layered Surface Depth**: Restrained linear gradients (`[background-image:linear-gradient(...)]`) layered over semantic tokens (`bg-primary`, `bg-destructive`, `bg-secondary`), preventing `tailwind-merge` class stripping.
- **Specular Top Highlight**: Controlled 1px top highlight bevels (`--btn-bevel-strong` / `inset 0 1px 0 rgba(255,255,255,0.16)` on primary/destructive; `--btn-bevel-soft` on secondary).
- **Lower Contact Shadows**: Dual-layer ambient and contact shadows (`--btn-contact`, `0 2px 4px -1px rgba(0,0,0,0.50), 0 1px 2px rgba(0,0,0,0.40)`).
- **Tactile Interaction**: Subtle resting elevation, smooth hover lift (`hover:-translate-y-px` with intensified shadow), and tactile pressed compression (`active:translate-y-[1px]` with inset shadow).
- **Performance & Compositor Isolation**: Hardware-accelerated GPU transforms (`transform-gpu`) without `will-change` (preventing compositor layer memory bloat in dense grids).
- **Scoped Transitions**: Transitions are strictly property-scoped (`transition-[transform,box-shadow,background-color,border-color]`, 150ms ease-out) to prevent layout thrashing or contention with `framer-motion`.
- **Focus Indicators**: High-contrast Emerald brand ring (`focus-visible:ring-2 focus-visible:ring-[#00E096]`) with 10.64:1 contrast on dark cards.
- **Accessibility & Reduced Motion**: `disabled:opacity-50 disabled:shadow-none disabled:translate-y-0` and full reduced-motion neutralization (`motion-reduce:transition-none motion-reduce:transform-none`).
- **Hierarchy**: `ghost` and `link` variants remain flat without 3D transforms.