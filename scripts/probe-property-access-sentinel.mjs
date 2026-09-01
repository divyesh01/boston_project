// PROBE: `property_access === null` is stored as the "all properties" sentinel by
// some writers and read as "no properties at all" by every reader. An all-access
// grant becomes a lockout.
//
// THE THREE READERS, none of which knows about `null`:
//
//   resolvePropertyAccessUncached()  src/api/base44Client.js
//       returns ALL_PROPERTIES for role owner/admin, ALL_PROPERTIES for the
//       literal 'all', the array itself for an array — and falls through to `[]`
//       for everything else. `null` takes the fall-through: zero properties.
//
//   hasAllPropertyAccess()           src/lib/launchPolicy.js
//       `user.property_access === 'all'` after the owner/admin role check. `null`
//       is false, and LAUNCH_POLICY_V1 turns that into a refused LOGIN.
//
//   the entity RLS rules                JSONC files under base44/entities
//       `"data.property_id": { "$in": "{{user.property_access}}" }`. There is no
//       `$in null`, so the row-level rule cannot match either.
//
// THE WRITERS THAT PRODUCE `null`, and this is where the premise needed checking:
//
//   LATENT   base44/functions/custom_user_admin/entry.js  ('all' -> null)
//            base44/functions/custom_auth_register/entry.js ('all' -> null)
//            Both are serverless handlers on a backend this repo no longer
//            deploys against: .env.production commits VITE_USE_LOCAL_AUTH=true
//            and VITE_STANDALONE_LOCAL=true, which routes every auth call to the
//            in-browser shims instead. Section 2 proves that, so nobody rates
//            these two as the live cause.
//
//   LATENT   src/api/base44Client.js#handleLocalAuthRegister does the SAME
//            mapping — `property_access === 'all' || !property_access ? null :
//            property_access` — and it is the shim that actually runs. Setup.jsx
//            posts `property_access: "all"`, so the FIRST OWNER of every install
//            has `property_access === null` on disk. Section 3 observes it.
//
//   LATENT, and the counter-example to a blanket "the local path is safe" claim:
//            handleLocalUserAdmin's `create` action stores `data.property_access
//            || 'all'` — the literal string, verbatim. Its `update` action passes
//            whatever it is handed straight through. So the live admin path never
//            MANUFACTURES null but will happily persist one. Section 4.
//
// HOW BAD IS IT TODAY — the honest answer, measured in section 6 rather than
// asserted. LAUNCH_POLICY_V1 already refuses every non-owner/admin account whose
// property_access is not the literal 'all'. A `front_desk` with `null` is locked
// out, but so is a `front_desk` with a perfectly legitimate `['prop_a']` grant.
// So the null sentinel is not currently the thing keeping per-property staff out;
// the launch gate is. What null DOES cost today:
//
//   * the owner rows created by Setup carry null, and Users.jsx renders that as
//     "None" and reads it back as property_mode "specific" with zero properties
//     (section 7) — so the admin UI describes a full grant as no grant, and one
//     untouched save rewrites it to `[]`;
//   * `null` survives only because `role === 'owner'` short-circuits ahead of it.
//     Demote that owner to manager and the account is locked out instantly
//     (section 6), with nothing in the UI having said so.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-property-access-sentinel.mjs

await import("fake-indexeddb/auto");
globalThis.crypto ??= (await import("node:crypto")).webcrypto;

const __store = new Map();
const __storage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(k, String(v)),
  removeItem: (k) => __store.delete(k),
  clear: () => __store.clear(),
};
globalThis.localStorage = __storage;
globalThis.sessionStorage = __storage;
globalThis.window = globalThis;
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "harness", language: "en-US" },
    configurable: true,
  });
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

const localDb = (await import("@/api/localDb")).default;
const { db, primePropertyAccess, invalidatePropertyAccess, browserHashPassword } =
  await import("@/api/base44Client");
const { hasAllPropertyAccess } = await import("@/lib/launchPolicy");

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const eq = (label, actual, expected) =>
  ok(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

const SALT = "0123456789abcdef0123456789abcdef";
const PASSWORD = "Sentinel-Probe-Password-1!";
let HASH;

async function reset() {
  for (const t of localDb.tables) await t.clear();
  __store.clear();
  invalidatePropertyAccess();
  HASH ??= "$pbkdf2$" + (await browserHashPassword(PASSWORD, SALT));
}

const mkUser = (id, role, property_access) => ({
  id, username: id, email: `${id}@probe.local`, full_name: id, role, property_access,
  is_active: true, is_locked: false, mfa_enabled: false, failed_login_count: 0,
  salt: SALT, password_hash: HASH, permissions: {},
  created_date: new Date().toISOString(),
});

console.log("--- PROBE: property_access null-vs-'all' SENTINEL ---");

// ── 1. The LATENT writers: both server handlers map 'all' -> null ───────────
console.log("\n[1] the two serverless handlers map 'all' to null");
{
  const admin = read("base44/functions/custom_user_admin/entry.js");
  const register = read("base44/functions/custom_auth_register/entry.js");

  ok("custom_user_admin create maps 'all' (and null) to stored null",
    /property_access === 'all' \|\| data\.property_access === null\s*\n?\s*\?\s*null/.test(admin) ||
    /data\.property_access === 'all' \|\| data\.property_access === null[\s\S]{0,40}\?\s*null/.test(admin),
    "expected the `=== 'all' ... ? null` mapping in createUser");
  ok("custom_user_admin update maps 'all' to stored null as well",
    /patch\.property_access = data\.property_access === 'all'[\s\S]{0,80}\?\s*null/.test(admin));
  ok("custom_auth_register maps 'all' to stored null",
    /property_access === 'all' \? null : property_access/.test(register));
  ok("custom_auth_register also defaults a PRIVILEGED account to null",
    /isPrivileged\s*\n?\s*\?\s*null/.test(register),
    "expected `: isPrivileged ? null` in the finalPropertyAccess ternary");
}

// ── 2. …but those handlers and legacy shims are not what production runs ───
//
// This is the section that decides how urgent section 1 is, so it reads the
// COMMITTED env file rather than the ambient process environment: a harness that
// exported VITE_USE_LOCAL_AUTH itself must not be able to answer this question.
console.log("\n[2] the shipped deployment uses Worker auth and browser business data");
{
  const prod = read(".env.production");
  ok("`.env.production` disables legacy browser-local auth",
    /^\s*VITE_USE_LOCAL_AUTH=false\s*$/m.test(prod) &&
    /^\s*VITE_STANDALONE_LOCAL=false\s*$/m.test(prod));
  ok("`.env.production` enables Worker auth without D1 business storage",
    /^\s*VITE_USE_SERVER_AUTH=true\s*$/m.test(prod) &&
    /^\s*VITE_USE_D1_API=false\s*$/m.test(prod));
  ok("base44Client routes auth on that flag",
    /const USE_SERVER_AUTH =[^\n]*VITE_USE_SERVER_AUTH === 'true'/.test(
      read("src/api/base44Client.js")));
  console.log("        => Base44 function handlers and legacy local-auth shims are LATENT, not production auth");
}

// ── 3. The LEGACY register shim stores null too — for the FIRST OWNER ─────
//
// Driven through the real production entry point: db.auth.registerUser() with
// exactly the payload src/pages/Setup.jsx sends.
console.log("\n[3] the legacy local register shim stores null for the first owner");
let OWNER_ID;
{
  await reset();
  ok("Setup.jsx posts property_access: \"all\"",
    /property_access:\s*"all"/.test(read("src/pages/Setup.jsx")));
  ok("handleLocalAuthRegister maps that to null",
    /property_access: property_access === 'all' \|\| !property_access \? null : property_access/
      .test(read("src/api/base44Client.js")));

  await db.auth.registerUser({
    username: "sentinel_owner",
    email: "sentinel-owner@probe.local",
    full_name: "Sentinel Owner",
    role: "owner",
    permissions: "all",
    property_access: "all",
    is_active: true,
    password: PASSWORD,
    must_change_password: false,
  });

  const rows = await localDb.User.toArray();
  eq("exactly one owner row was created", rows.length, 1);
  OWNER_ID = rows[0].id;
  console.log(`        stored property_access = ${JSON.stringify(rows[0].property_access)} (${rows[0].property_access === null ? "null" : typeof rows[0].property_access})`);
  eq("the grant the operator asked for ('all') is on disk as null", rows[0].property_access, null);
}

// ── 4. The LEGACY user-admin shim stores 'all' VERBATIM ───────────────────
//
// The other half of the legacy local split. Two writers, two different
// representations of the same grant, in the same file.
console.log("\n[4] the legacy local user-admin shim stores the literal 'all'");
{
  ok("handleLocalUserAdmin create stores data.property_access || 'all'",
    /property_access: data\.property_access \|\| 'all'/.test(read("src/api/base44Client.js")));
  ok("Users.jsx sends the literal 'all' for all-properties mode",
    /property_access:\s*form\.property_mode === "all" \? "all" : form\.property_ids/
      .test(read("src/pages/Users.jsx")));

  // Sign in as the owner created in [3] so requireLocalAdmin() is satisfied, then
  // create a manager through the real handler.
  await db.auth.login("sentinel-owner@probe.local", PASSWORD);
  await db.functions.invoke("custom_user_admin", {
    action: "create",
    data: {
      username: "live_mgr", email: "live-mgr@probe.local", role: "manager",
      password: PASSWORD, property_access: "all",
    },
  });
  const mgr = (await localDb.User.toArray()).find((u) => u.username === "live_mgr");
  console.log(`        stored property_access = ${JSON.stringify(mgr.property_access)}`);
  eq("the live admin path stores 'all', not null", mgr.property_access, "all");
  console.log("        => two live writers, two spellings of one grant. That is the contract gap.");
}

// ── 5. Every reader treats null as ZERO properties ────────────────────────
console.log("\n[5] the readers: null resolves to no properties at all");
{
  // 5a — the pure launch-policy predicate, over the whole matrix.
  const ACCESS = [
    ["'all'", "all"],
    ["null", null],
    ["undefined", undefined],
    ["[]", []],
    ["['prop_a']", ["prop_a"]],
  ];
  for (const [label, value] of ACCESS) {
    eq(`hasAllPropertyAccess(owner,   ${label})`, hasAllPropertyAccess({ role: "owner", property_access: value }), true);
  }
  eq("hasAllPropertyAccess(manager, 'all')", hasAllPropertyAccess({ role: "manager", property_access: "all" }), true);
  eq("hasAllPropertyAccess(manager, null)  — an 'all' grant read as NOT all",
    hasAllPropertyAccess({ role: "manager", property_access: null }), false);
  eq("hasAllPropertyAccess(manager, [])", hasAllPropertyAccess({ role: "manager", property_access: [] }), false);

  // 5b — the scope resolver, observed through the real cached snapshot.
  await reset();
  await localDb.User.bulkAdd([
    mkUser("own_null", "owner", null),
    mkUser("adm_null", "admin", null),
  ]);
  await db.auth.login("own_null@probe.local", PASSWORD);
  invalidatePropertyAccess();
  eq("a null-grant OWNER still resolves to full access (role short-circuits first)",
    await primePropertyAccess({ force: true }), "all");

  await db.auth.login("adm_null@probe.local", PASSWORD);
  invalidatePropertyAccess();
  eq("a null-grant ADMIN still resolves to full access", await primePropertyAccess({ force: true }), "all");
  console.log("        so null is invisible today ONLY because role is checked before it");

  // 5c — the resolver's fall-through, read from source. There is no runtime path
  // to it for a signed-in user (section 6 proves why), so the branch structure is
  // the evidence: three positive branches, then `return []`.
  const client = read("src/api/base44Client.js");
  const fn = client.slice(client.indexOf("async function resolvePropertyAccessUncached"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  ok("resolvePropertyAccessUncached has no branch for null",
    !/property_access\s*===\s*null/.test(body) && !/property_access\s*==\s*null/.test(body),
    "a null branch appeared — re-read this probe's premise");
  ok("its fall-through returns an EMPTY array (zero properties)",
    /\/\/ Unset, null, or a shape nobody planned for\.[\s\S]{0,40}return \[\];/.test(body) ||
    /return \[\];\s*\n\s*\} catch/.test(body),
    "expected `return [];` as the last statement before the catch");
}

// ── 6. The lockout, as a truth table over real logins ────────────────────
//
// One real db.auth.login() per cell. This is what makes the urgency claim
// measurable instead of rhetorical: read the `null` column against the
// `['prop_a']` column. They are identical for every non-privileged role, which
// means the launch gate — not the sentinel — is what keeps staff out today.
console.log("\n[6] login truth table: role x property_access");
{
  const ROLES = ["owner", "admin", "manager", "front_desk", "read_only"];
  const ACCESS = [["all", "all"], ["null", null], ["[]", []], ["['prop_a']", ["prop_a"]]];

  await reset();
  const rows = [];
  for (const role of ROLES) {
    for (const [alabel, value] of ACCESS) {
      rows.push({ id: `${role}_${alabel.replace(/\W/g, "")}`, role, alabel, value });
    }
  }
  await localDb.User.bulkAdd(rows.map((r) => mkUser(r.id, r.role, r.value)));

  const table = {};
  for (const r of rows) {
    let verdict;
    try {
      await db.auth.login(`${r.id}@probe.local`, PASSWORD);
      verdict = "IN";
    } catch (e) {
      verdict = /all properties/.test(e?.message || "") ? "REFUSED" : `ERR:${e?.message}`;
    }
    invalidatePropertyAccess();
    (table[r.role] ??= {})[r.alabel] = verdict;
  }

  const cols = ACCESS.map(([l]) => l);
  console.log(`        ${"role".padEnd(12)}${cols.map((c) => c.padEnd(12)).join("")}`);
  for (const role of ROLES) {
    console.log(`        ${role.padEnd(12)}${cols.map((c) => String(table[role][c]).padEnd(12)).join("")}`);
  }

  eq("owner + null signs in", table.owner.null, "IN");
  eq("admin + null signs in", table.admin.null, "IN");
  eq("manager + 'all' signs in", table.manager.all, "IN");
  eq("manager + null is REFUSED — the 'all properties' grant became a lockout",
    table.manager.null, "REFUSED");
  eq("front_desk + null is REFUSED", table.front_desk.null, "REFUSED");
  eq("read_only + null is REFUSED", table.read_only.null, "REFUSED");

  // The discriminator. If these two columns ever differ, the sentinel has become
  // the live cause of the lockout and this probe's urgency note is out of date.
  const nullCol = ROLES.map((r) => table[r].null).join(",");
  const specificCol = ROLES.map((r) => table[r]["['prop_a']"]).join(",");
  eq("null and a LEGITIMATE specific grant produce the identical outcome for every role",
    nullCol, specificCol);
  console.log("        => today the LAUNCH GATE causes the refusal, not the sentinel.");
  console.log("           null only becomes the live cause once LAUNCH_POLICY_V1 is lifted.");
}

// ── 7. What null costs TODAY: the admin UI misreports a full grant ────────
//
// Not hypothetical, and not gated. The owner row from section 3 has null on disk
// on every install. Users.jsx's two read expressions are asserted here verbatim
// and then evaluated against that stored value, and the write half is driven
// through the real custom_user_admin handler.
console.log("\n[7] the live cost: Users.jsx reads null as 'no properties'");
{
  const usersSrc = read("src/pages/Users.jsx");
  const RENDER = /u\.property_access === "all" \? "All properties" : Array\.isArray\(u\.property_access\) \? `\$\{u\.property_access\.length\} property\(ies\)` : "None"/;
  const READBACK = /property_mode: u\.property_access === "all" \? "all" : "specific"/;
  ok("Users.jsx renders a non-'all', non-array grant as the literal \"None\"", RENDER.test(usersSrc));
  ok("Users.jsx reads a non-'all' grant back as property_mode \"specific\"", READBACK.test(usersSrc));

  await reset();
  await db.auth.registerUser({
    username: "cost_owner", email: "cost-owner@probe.local", full_name: "Cost Owner",
    role: "owner", permissions: "all", property_access: "all", is_active: true,
    password: PASSWORD, must_change_password: false,
  });
  const stored = (await localDb.User.toArray())[0];
  eq("the stored grant is null", stored.property_access, null);

  // The two expressions above, applied to the value actually on disk.
  const label = stored.property_access === "all"
    ? "All properties"
    : Array.isArray(stored.property_access)
      ? `${stored.property_access.length} property(ies)`
      : "None";
  const mode = stored.property_access === "all" ? "all" : "specific";
  const ids = Array.isArray(stored.property_access) ? stored.property_access : [];
  console.log(`        Users list badge  => "${label}"`);
  console.log(`        Edit form         => property_mode="${mode}", property_ids=${JSON.stringify(ids)}`);
  eq("the owner's ALL-properties grant is labelled \"None\" in the users list", label, "None");
  eq("the edit form opens on \"specific\" with zero properties", `${mode}:${ids.length}`, "specific:0");

  // The write half, through the real handler: saving that form as-is.
  //
  // It has to be a DIFFERENT admin doing the saving, and that is a finding rather
  // than harness plumbing. handleLocalUserAdmin's `update` action computes
  // `self = String(actor.id) === String(user.id)` and only assigns role /
  // permissions / property_access when `!self`, so an owner editing their OWN row
  // cannot rewrite their own grant at all — the first attempt at this section
  // logged in as the owner, saved, and observed null unchanged. The rewrite needs
  // a second privileged account, which narrows the exposure without removing it.
  await db.auth.login("cost-owner@probe.local", PASSWORD);
  await db.functions.invoke("custom_user_admin", {
    action: "create",
    data: {
      username: "cost_admin", email: "cost-admin@probe.local", role: "admin",
      password: PASSWORD, property_access: "all",
    },
  });
  invalidatePropertyAccess();

  await db.auth.login("cost-admin@probe.local", PASSWORD);
  const selfSave = await db.functions.invoke("custom_user_admin", {
    action: "update", id: stored.id, data: { property_access: mode === "all" ? "all" : ids },
  });
  ok("the update handler accepted the save", !!selfSave?.user, JSON.stringify(selfSave));
  const after = await localDb.User.get(stored.id);
  console.log(`        after one untouched save by a second admin => ${JSON.stringify(after.property_access)}`);
  eq("that save rewrites the owner's full grant to an empty array",
    JSON.stringify(after.property_access), "[]");
  eq("the row is now genuinely scope-less to every reader",
    hasAllPropertyAccess({ role: "manager", property_access: after.property_access }), false);
  console.log("        (the account keeps working only while its role stays owner/admin)");
}

// ── 8. The entity RLS rules cannot match null either ──────────────────────
console.log("\n[8] the row-level rules interpolate property_access directly");
{
  const dir = path.join(REPO, "base44", "entities");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonc"));
  let withRule = 0;
  for (const f of files) {
    if (/"data\.property_id"\s*:\s*\{\s*"\$in"\s*:\s*"\{\{user\.property_access\}\}"/.test(
      fs.readFileSync(path.join(dir, f), "utf8"))) withRule += 1;
  }
  ok("the $in {{user.property_access}} rule is widespread (not vacuous)", withRule >= 10,
    `${withRule} of ${files.length} entity files`);
  console.log(`        ${withRule} entity files gate rows on \`$in {{user.property_access}}\``);
  console.log("        there is no `$in null`, so a null grant matches no row there either —");
  console.log("        the same sentinel would break the hosted path if it were ever redeployed.");
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(72)}`);
console.log("VERDICT");
console.log("  LATENT handleLocalAuthRegister stores null for a legacy local install's first owner;");
console.log("         Users.jsx labels that full grant \"None\" and one save turns it into [].");
console.log("  LATENT handleLocalUserAdmin stores the literal 'all' — two writers, two spellings.");
console.log("  LATENT Base44 function entry handlers ('all' -> null) are not deployed (.env.production).");
console.log("  MASKED the null lockout is indistinguishable from LAUNCH_POLICY_V1 today; lifting");
console.log("         that gate without fixing the sentinel turns it into a real lockout.");
console.log("  => ONE representation for property_access. Do not carry null into a D1 schema.");
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  • ${f}`));
}
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
