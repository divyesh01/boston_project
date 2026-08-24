/**
 * probe-toast-lifecycle.mjs — tracker #52
 *
 * WHAT WENT WRONG
 * ===============
 * The owner screenshotted the live /users page with FIVE red toasts stacked over
 * the Add User dialog. THREE of the five were validation refusals ("Invalid
 * characters in username or email", "Password must include at least one uppercase
 * letter", "Password must be at least 12 characters"), produced one per submit by
 * a separate defect (#49 — one early return per rule, now collected into a single
 * toast). The other TWO were "Local fallback does not support action: create",
 * which lives in a protected file and is owner-blocked. Neither of those explains
 * why all five were on screen AT ONCE. This does:
 *
 *   Not one toast this application has ever shown left the screen on its own, and
 *   the X in the corner did nothing when clicked. A page reload was the only way
 *   to clear a toast.
 *
 * Three independent causes, each sufficient on its own:
 *
 *   1. `toaster.jsx` rendered `<ToastClose />` with no props. `ToastClose` is a
 *      hand-rolled `<button>` — someone had replaced the Radix primitives with
 *      plain divs and buttons, which silently removed the primitive's built-in
 *      close behaviour — so with no `onClick` passed in, the X was decoration.
 *
 *   2. Nothing anywhere dispatched DISMISS_TOAST. The reducer had the branch, and
 *      `addToRemoveQueue` existed to schedule the unmount, but no timer was ever
 *      armed to call it. The whole auto-expiry path was unreachable code.
 *
 *   3. `TOAST_REMOVE_DELAY` was 1_000_000 (16.7 minutes). That number is the
 *      upstream react-hot-toast placeholder for the DISMISS→REMOVE gap, not a
 *      lifetime. It never mattered, because of cause 2.
 *
 * Plus two that made the stack worse than it needed to be:
 *
 *   4. `TOAST_LIMIT` was 20. With nothing ever removing a toast that is not a
 *      burst allowance, it is a permanent ceiling. Twenty toasts is ~1800px in a
 *      `max-h-screen` container with no scroll, so the oldest were clipped out of
 *      the viewport and could not be read even in principle.
 *
 *   5. `ToastProvider` and `ToastViewport` carried BYTE-IDENTICAL fixed-position
 *      class strings. The toasts were children of the provider; the viewport
 *      rendered empty. An empty `fixed … z-[100] p-4` div is still 32px tall and
 *      still accepts pointer events, so every page in the app carried an invisible
 *      strip that swallowed clicks. The giveaway is that the toast items already
 *      had `pointer-events-auto` — proof the container was meant to have
 *      `pointer-events-none`, which neither of the two had.
 *
 * WHAT THIS PROBE CAN AND CANNOT CHECK
 * ====================================
 * All of the above are RUNTIME defects, and this tier cannot execute them: Node
 * cannot import a `.jsx` file (`scripts/resolve-alias.mjs` rewrites specifiers but
 * installs no `load` hook), so every probe in this repo reads `.jsx` as text. The
 * behaviour is proven in `src/components/ui/toast.test.jsx` — 17 vitest cases
 * under jsdom, mutation-tested: reverting cause 1 fails exactly 2 of them, and
 * disarming cause 2 fails exactly 5.
 *
 * So this probe does the job the vitest file cannot: it pins the CONSTANTS and the
 * WIRING as source facts, and it pins the vitest file's copies of those constants
 * to the originals. That second part is the reason the duplication is safe. A test
 * that imported `TOAST_REMOVE_DELAY` from the module and then advanced its fake
 * clock by exactly that much would pass for ANY value, including a regression back
 * to 1_000_000 — it would be measuring the source against itself. Copying the
 * numbers into the test makes them falsifiable; this probe makes the copies honest.
 *
 * ANTI-REGRESSION
 * ===============
 * Section 8 searches for the exact shapes that shipped. Those searches run over
 * CODE ONLY, because this file and the three it inspects all quote the old code in
 * their comments to explain it — a naive substring search would match the
 * explanation and fail forever.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = (rel) => path.join(ROOT, rel);

const FILES = {
  useToast: "src/components/ui/use-toast.jsx",
  toaster: "src/components/ui/toaster.jsx",
  toast: "src/components/ui/toast.jsx",
  test: "src/components/ui/toast.test.jsx",
  app: "src/App.jsx",
};

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Strips comment lines. Every anti-regression search below has to run over this
 * rather than the raw source, because all four files quote the code they replaced
 * in order to explain why it was wrong.
 */
const codeOnly = (src) =>
  src
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
    })
    .join("\n");

const raw = {};
const code = {};
for (const [key, rel] of Object.entries(FILES)) {
  if (!existsSync(P(rel))) {
    console.log(`\nFATAL: ${rel} does not exist. Every assertion below would be vacuous.`);
    process.exit(1);
  }
  raw[key] = readFileSync(P(rel), "utf8");
  code[key] = codeOnly(raw[key]);
}

/** Reads `const NAME = <number>;` out of a source file. */
function constNum(src, name) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\d[\\d_]*)\\s*;`));
  return m ? Number(m[1].replace(/_/g, "")) : null;
}

console.log("=".repeat(70));
console.log("probe-toast-lifecycle — tracker #52");
console.log("=".repeat(70));

// ── 1. The constants ─────────────────────────────────────────────────────────
console.log("\n--- 1. constants in use-toast.jsx ---");

const LIMIT = constNum(code.useToast, "TOAST_LIMIT");
const REMOVE = constNum(code.useToast, "TOAST_REMOVE_DELAY");

ok("TOAST_LIMIT is 3", LIMIT === 3, `read ${LIMIT}`);
ok("TOAST_REMOVE_DELAY is 200", REMOVE === 200, `read ${REMOVE}`);

// The 200 is not a round number picked by feel. `toastVariants` carries
// `data-[state=closed]:animate-out`, which the Tailwind CLI compiles to
// `animation-name: exit; animation-duration: .15s`. The element must outlive its
// own exit animation or it vanishes mid-transition.
ok("TOAST_REMOVE_DELAY outlives the 150ms exit animation", REMOVE > 150, `${REMOVE} > 150`);
ok("…and is not so long the toast lingers after closing", REMOVE <= 500, `${REMOVE} <= 500`);

const durMatch = code.useToast.match(/DEFAULT_DURATION_MS\s*=\s*\{([^}]*)\}/);
const durBody = durMatch ? durMatch[1] : "";
const defaultMs = Number((durBody.match(/default:\s*(\d+)/) || [])[1]);
const destructiveMs = Number((durBody.match(/destructive:\s*(\d+)/) || [])[1]);

ok("DEFAULT_DURATION_MS.default is 5000", defaultMs === 5000, `read ${defaultMs}`);
ok("DEFAULT_DURATION_MS.destructive is 10000", destructiveMs === 10000, `read ${destructiveMs}`);
ok("a failure stays up longer than a confirmation", destructiveMs > defaultMs,
  "errors carry more text and acting on them requires reading them");

// ── 2. The vitest file's copies are pinned to these ──────────────────────────
console.log("\n--- 2. toast.test.jsx mirrors the real constants ---");

ok("test mirrors TOAST_LIMIT", constNum(code.test, "TOAST_LIMIT") === LIMIT,
  `test ${constNum(code.test, "TOAST_LIMIT")} vs source ${LIMIT}`);
ok("test mirrors TOAST_REMOVE_DELAY", constNum(code.test, "REMOVE_DELAY") === REMOVE,
  `test ${constNum(code.test, "REMOVE_DELAY")} vs source ${REMOVE}`);
ok("test mirrors the default duration", constNum(code.test, "DEFAULT_MS") === defaultMs,
  `test ${constNum(code.test, "DEFAULT_MS")} vs source ${defaultMs}`);
ok("test mirrors the destructive duration", constNum(code.test, "DESTRUCTIVE_MS") === destructiveMs,
  `test ${constNum(code.test, "DESTRUCTIVE_MS")} vs source ${destructiveMs}`);
ok("the module exports no test-only internals",
  /export\s*\{\s*useToast,\s*toast\s*\}/.test(code.useToast) &&
    !/export\s+(const|function)\s+(TOAST_LIMIT|TOAST_REMOVE_DELAY|DEFAULT_DURATION_MS|subscribeToasts)/.test(code.useToast),
  "constants stay private; the test copies them and this section pins the copies");

// ── 3. The store arms and clears its timers ──────────────────────────────────
console.log("\n--- 3. use-toast.jsx timer machinery ---");

ok("an auto-dismiss timer is armed when a toast is created",
  /dismissTimers\.set\(\s*id\s*,\s*setTimeout\(\s*dismiss\s*,\s*ms\s*\)\s*\)/.test(code.useToast),
  "this is cause 2 — it did not exist");
ok("the duration is honoured only when finite and positive",
  /Number\.isFinite\(ms\)\s*&&\s*ms\s*>\s*0/.test(code.useToast),
  "so duration: Infinity means 'stays until the admin closes it'");
ok("`duration` is destructured out of props, not spread onto the DOM",
  /function\s+toast\(\{\s*duration,\s*\.\.\.props\s*\}\)/.test(code.useToast));
ok("DISMISS_TOAST cancels the pending auto-dismiss",
  /clearTimer\(dismissTimers,\s*toastId\)/.test(code.useToast),
  "on the click path that timer is still armed against a doomed id");
ok("REMOVE_TOAST drops both of a toast's timers",
  /clearTimer\(dismissTimers,\s*action\.toastId\)/.test(code.useToast) &&
    /clearTimer\(removeTimers,\s*action\.toastId\)/.test(code.useToast),
  "otherwise both maps grow for the life of the tab");
ok("ADD_TOAST drops the timers of a toast the limit pushed off screen",
  /clearTimer\(dismissTimers,\s*t\.id\)/.test(code.useToast) &&
    /clearTimer\(removeTimers,\s*t\.id\)/.test(code.useToast),
  "the invariant: a timer exists only for a toast still on screen");
ok("the limit keeps the NEWEST toasts",
  /\[action\.toast,\s*\.\.\.state\.toasts\]\s*\.slice\(0,\s*TOAST_LIMIT\)/.test(code.useToast.replace(/\s+/g, " ")),
  "prepend-then-slice — the newest message is the one the last click produced");
ok("the dead `_clearFromRemoveQueue` helper is gone",
  !/_clearFromRemoveQueue/.test(code.useToast),
  "it was unreachable and underscore-prefixed to dodge the lint rule");

// ── 4. The renderer is wired to the store ────────────────────────────────────
console.log("\n--- 4. toaster.jsx wiring ---");

ok("the close button has an onClick", /<ToastClose\s+onClick=/.test(code.toaster),
  "this is cause 1");
ok("…and it calls dismiss(id) from the hook, not the toast's own onOpenChange",
  /onClick=\{\(\)\s*=>\s*dismiss\(id\)\}/.test(code.toaster),
  "a caller passing their own onOpenChange cannot break the X this way");
ok("dismiss comes from useToast", /const\s*\{\s*toasts,\s*dismiss\s*\}\s*=\s*useToast\(\)/.test(code.toaster));
ok("`open` is passed explicitly, not spread", /<Toast\s+key=\{id\}\s+open=\{open\}/.test(code.toaster));
ok("`onOpenChange` is destructured out so it never reaches the DOM",
  /onOpenChange:\s*_onOpenChange/.test(code.toaster),
  "React reports it as 'Unknown event handler property' on a div");
ok("the toasts are children of ToastViewport",
  code.toaster.indexOf("<ToastViewport>") < code.toaster.indexOf("toasts.map"),
  "they used to be children of ToastProvider, leaving the viewport empty");

// ── 5. Exactly one fixed container ───────────────────────────────────────────
console.log("\n--- 5. toast.jsx containers (cause 5) ---");

const z100 = (code.toast.match(/z-\[100\]/g) || []).length;
ok("exactly one element carries the z-[100] fixed container class", z100 === 1, `found ${z100}`);

const viewportBlock = code.toast.slice(
  code.toast.indexOf("const ToastViewport"),
  code.toast.indexOf('ToastViewport.displayName')
);
ok("the viewport is transparent to pointer events",
  /pointer-events-none/.test(viewportBlock),
  "the strip that swallowed clicks on every page");
ok("the viewport is a labelled landmark",
  /role="region"/.test(viewportBlock) && /aria-label="Notifications"/.test(viewportBlock));
ok("the viewport renders its children",
  /\{children\}/.test(viewportBlock));

const providerBlock = code.toast.slice(
  code.toast.indexOf("const ToastProvider"),
  code.toast.indexOf("ToastProvider.displayName")
);
ok("ToastProvider has no fixed positioning of its own", !/fixed/.test(providerBlock));
ok("…and renders no DOM element at all", /<>\{children\}<\/>/.test(providerBlock.replace(/\s+/g, "")),
  "it stays exported because it is part of the shadcn API surface");

// ── 6. The Toast element ─────────────────────────────────────────────────────
console.log("\n--- 6. toast.jsx Toast element (causes 3 and 4's symptoms) ---");

ok("`open` is translated into data-state",
  /data-state=\{open\s*\?\s*"open"\s*:\s*"closed"\}/.test(code.toast),
  "before this, NO element in the app ever carried data-state");
ok("`open` defaults to true", /open\s*=\s*true/.test(code.toast),
  "a <Toast> rendered without the store should be visible, not pre-animated-out");

const variantClasses = code.toast.match(/const toastVariants = cva\(\s*"([^"]*)"/);
const vc = variantClasses ? variantClasses[1] : "";
["data-[state=open]:animate-in", "data-[state=closed]:animate-out",
 "data-[state=closed]:fade-out-80", "data-[state=closed]:slide-out-to-right-full",
 "pointer-events-auto"].forEach((cls) => {
  ok(`toastVariants still carries ${cls}`, vc.includes(cls),
    cls === "pointer-events-auto" ? "pairs with the viewport's pointer-events-none" : "dead until data-state existed");
});

ok("a failure interrupts the screen reader", /role=\{destructive \? "alert" : "status"\}/.test(code.toast));
ok("…and a confirmation waits for a pause",
  /aria-live=\{destructive \? "assertive" : "polite"\}/.test(code.toast));

// ── 7. The close button ──────────────────────────────────────────────────────
console.log("\n--- 7. toast.jsx ToastClose ---");

const closeBlock = code.toast.slice(
  code.toast.indexOf("const ToastClose"),
  code.toast.indexOf("ToastClose.displayName")
);
ok("type=\"button\"", /type="button"/.test(closeBlock),
  "a typeless button defaults to submit, and a toast renders over the Add User form");
ok("has an accessible name", /Close notification/.test(closeBlock));
ok("the icon is hidden from the accessibility tree", /aria-hidden="true"/.test(closeBlock),
  "so the button announces once, not twice");
ok("is not invisible until hover", !/opacity-0/.test(closeBlock),
  "hover does not exist on a touch screen — it was invisible but clickable on a phone");

// ── 8. Anti-regression ───────────────────────────────────────────────────────
console.log("\n--- 8. the exact shapes that shipped must not come back ---");

ok("no bare <ToastClose /> in the renderer", !/<ToastClose\s*\/>/.test(code.toaster));
ok("no 1000000 / 1_000_000 delay", !/1_?000_?000/.test(code.useToast));
ok("TOAST_LIMIT is not back above 3", LIMIT <= 3, `read ${LIMIT}`);

const toastBlock = code.toast.slice(
  code.toast.indexOf("const Toast ="),
  code.toast.indexOf("Toast.displayName")
);
ok("`open` is pulled out of props before the spread",
  /\(\{\s*className,\s*variant,\s*open\s*=\s*true,\s*\.\.\.props\s*\}/.test(toastBlock),
  "otherwise it lands on the div as a literal `open` DOM attribute");
ok("the two container class strings are no longer identical",
  providerBlock.replace(/\s+/g, "") !== viewportBlock.replace(/\s+/g, ""));
ok("nothing reintroduced a second empty fixed container in the renderer",
  !/z-\[100\]/.test(code.toaster));

// ── 9. The behaviour tier exists ─────────────────────────────────────────────
console.log("\n--- 9. the vitest file that proves the runtime behaviour ---");

ok("toast.test.jsx renders the real Toaster",
  /from "\.\/toaster"/.test(code.test) && /renderToaster/.test(code.test));
ok("…drives the real close button", /fireEvent\.click\(closeButton\(\)\)/.test(code.test));
ok("…and uses fake timers to reach the expiry path", /vi\.useFakeTimers\(\)/.test(code.test));
ok("…asserts a toast actually leaves the DOM", /toBeNull\(\)/.test(code.test));
ok("…and counts timers to pin the ADD_TOAST invariant", /vi\.getTimerCount\(\)/.test(code.test));

// ── 10. It is mounted ────────────────────────────────────────────────────────
console.log("\n--- 10. App.jsx mounts it exactly once ---");

const mounts = (code.app.match(/<Toaster\s*\/>/g) || []).length;
ok("<Toaster /> is mounted exactly once", mounts === 1, `found ${mounts}`);
ok("sonner's toaster is also mounted", /<SonnerToaster/.test(code.app),
  "two systems on purpose: 31 sonner calls were silent before it was mounted");

// ── 11. The two typecheck contracts ──────────────────────────────────────────
// Both of these were broken BY THIS FIX and caught only by `npm run typecheck`.
// Neither is visible to eslint, and neither changes runtime behaviour, so both are
// the kind of annotation a later pass deletes as noise. Asserting them here means
// the removal fails a probe as well as the typecheck gate.
console.log("\n--- 11. annotations that npm run typecheck depends on ---");

// These live in comments, so they are the one thing in this file that must be read
// from the RAW source — codeOnly() strips every line starting with `*`.
const TYPE_TAG = "@type {React.ForwardRefExoticComponent";

/** Returns the JSDoc block immediately preceding a component declaration. */
function docBlockBefore(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) return null;
  const close = src.lastIndexOf("*/", at);
  if (close < 0) return null;
  const open = src.lastIndexOf("/**", close);
  if (open < 0) return null;
  // Only whitespace may sit between the block and the declaration, or the block
  // documents something else and tsc will not associate the two.
  if (src.slice(close + 2, at).trim() !== "") return null;
  return src.slice(open, close);
}

["ToastViewport", "Toast", "ToastAction", "ToastClose", "ToastTitle", "ToastDescription"]
  .forEach((name) => {
    const block = docBlockBefore(raw.toast, `const ${name} = React.forwardRef`);
    ok(`${name} carries its ForwardRefExoticComponent annotation`,
      block !== null && block.includes(TYPE_TAG),
      block === null
        ? "no JSDoc block is attached to the declaration"
        : "without it tsc infers the props as `{}` and every prop becomes TS2339");
  });

// The `toast()` annotation has to stay an inline object type WITH an index
// signature. Written as `@param {object} props` plus `@param [props.duration]`,
// tsc reads the type as exactly `{ duration?: number }` and rejects every
// `toast({ variant, title, description })` call site in Users.jsx as an excess
// property — 10 TS2353 errors. Measured, not theorised: that is how it failed.
//
// The annotation is extracted first and every assertion runs against THAT, not
// against the file. Searching the whole file is what the header warns about: the
// JSDoc prose above the annotation quotes the broken `{ duration?: number }` form
// in order to explain it, so a file-wide search for `duration?:` passes even with
// the real annotation deleted. Measured — the first version of this section did.
const paramAnn = (raw.useToast.match(/@param\s+(\{\{[\s\S]*?\}\})\s+props/) || [])[1] || "";

ok("toast()'s props annotation is an inline object type", paramAnn !== "",
  paramAnn ? paramAnn.replace(/\s+/g, " ") : "no `@param {{...}} props` found");
ok("…and keeps an index signature", /\[key:\s*string\]:\s*any/.test(paramAnn),
  "the dotted `@param props.duration` form closes the type and breaks 10 call sites");
ok("…and marks duration optional", /duration\?:/.test(paramAnn),
  "a required `duration` broke the same call sites a different way (TS2345)");
ok("…and the dotted sub-property form is not used anywhere",
  !/@param\s+\{[^}]*\}\s+\[?props\.duration/.test(raw.useToast));

console.log("\n" + "─".repeat(70));
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail > 0) {
  console.log(`\nFAILED: ${pass} passed, ${fail} failed`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`\nPASSED: ${pass} passed, 0 failed`);
process.exit(0);
