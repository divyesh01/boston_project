import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file) => readFileSync(file, "utf8");
const hero = read("src/components/PremiumPageHero.jsx");
const targets = [
  ["Dashboard", read("src/pages/Dashboard.jsx")],
  ["Statistics", read("src/pages/Statistics.jsx")],
  ["Forecasting", read("src/pages/Forecasting.jsx")],
];

assert.match(hero, /useReducedMotion/, "premium hero must honor reduced-motion preferences");
assert.match(hero, /perspective/, "premium hero must provide scoped 3D perspective");
assert.match(hero, /preserve-3d/, "premium hero must retain layered 3D depth");
assert.match(hero, /pointer-events-none/, "decorative 3D layers must not block page controls");
assert.match(hero, /aria-hidden="true"/, "decorative visuals must be hidden from assistive technology");
assert.match(hero, /min-h-11/, "hero actions must provide at least a 44px target");
assert.match(hero, /focus-visible:/, "hero actions must retain a visible keyboard focus state");

for (const [name, source] of targets) {
  assert.match(source, /import PremiumPageHero/, `${name} must import the shared premium hero`);
  assert.equal((source.match(/<PremiumPageHero\b/g) || []).length, 1, `${name} must render exactly one premium hero`);
}

assert.match(targets[0][1], /Export PDF/, "Dashboard hero must retain the real PDF export action");
assert.match(targets[1][1], /Export CSV/, "Statistics hero must expose a real CSV export action");
assert.match(targets[2][1], /Reset scenario/, "Forecasting hero must expose a scenario reset action");
assert.match(targets[2][1], /prefers-reduced-motion/, "Forecasting hero scrolling must honor reduced-motion preferences");

console.log("PREMIUM PAGE HERO PROBE PASSED (14 assertions)");
