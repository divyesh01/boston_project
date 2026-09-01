// scripts/probe-worker-integration.mjs — INDEPENDENT end-to-end proof of the
// worker/index.js request pipeline: auth (401) -> scope (403) -> scoped dispatch,
// exercised through the REAL default `fetch` export with a synthetic Access JWT
// and a node:sqlite shim over worker/schema.sql.
//
// Run: node scripts/probe-worker-integration.mjs   (exits non-zero on failure)

import worker from "../worker/index.js";
import {
  makeDb,
  makeEnv,
  seedProperties,
  seedUser,
  seedTxn,
  generateRsaKey,
  makeJwks,
  makeJwksFetch,
  signRs256,
  makeRunner,
  assert,
  assertEqual,
} from "./_worker-testkit.mjs";

const r = makeRunner("probe-worker-integration");

const AUD = "aud-synthetic-tag";
const TEAM = "team.cloudflareaccess.com";
const ISS = "https://team.cloudflareaccess.com";
const CERTS_URL = "https://synthetic.jwks/certs-int";
const CTX = { waitUntil() {}, passThroughOnException() {} };

const key = await generateRsaKey("kid-int");
const { fetchImpl } = makeJwksFetch(makeJwks(key.publicJwk));

function buildEnv() {
  const db = makeDb();
  seedProperties(db);
  seedUser(db, { id: "u-a", email: "a@hotel.example", role: "staff", mode: "specific", grants: ["P_A"] });
  seedTxn(db, { id: "t1", property_id: "P_A", date: "2026-01-02", amount: 100.0, folio: "F1", code: "RENT", dedupe_key: "k1" });
  seedTxn(db, { id: "t3", property_id: "P_B", date: "2026-01-02", amount: 999.99, folio: "F9", code: "RENT", dedupe_key: "k3" });
  const env = makeEnv(db, { ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_CERTS_URL: CERTS_URL, FETCH: fetchImpl });
  return { db, env };
}

async function tokenFor(email) {
  return signRs256({
    privateKey: key.privateKey,
    kid: "kid-int",
    payload: { aud: AUD, iss: ISS, exp: Math.floor(Date.now() / 1000) + 3600, email, sub: `sub-${email}` },
  });
}

await r.check("no credential => 401 before any handler runs", async () => {
  const { env } = buildEnv();
  const res = await worker.fetch(new Request("https://api.test/api/properties"), env, CTX);
  assertEqual(res.status, 401, "unauthenticated request must be 401");
});

await r.check("valid JWT but unprovisioned email => 403", async () => {
  const { env } = buildEnv();
  const token = await tokenFor("ghost@nobody.example");
  const req = new Request("https://api.test/api/properties", { headers: { "Cf-Access-Jwt-Assertion": token } });
  const res = await worker.fetch(req, env, CTX);
  assertEqual(res.status, 403, "unprovisioned caller must be 403");
});

await r.check("provisioned specific-P_A caller: /api/properties returns only P_A", async () => {
  const { env } = buildEnv();
  const token = await tokenFor("a@hotel.example");
  const req = new Request("https://api.test/api/properties", { headers: { "Cf-Access-Jwt-Assertion": token } });
  const res = await worker.fetch(req, env, CTX);
  assertEqual(res.status, 200, "authorized read must be 200");
  const body = await res.json();
  assertEqual(body.properties.length, 1, "only 1 property visible");
  assertEqual(body.properties[0].id, "P_A", "must be P_A only");
});

await r.check("provisioned specific-P_A caller: /api/transactions cannot read P_B rows", async () => {
  const { env } = buildEnv();
  const token = await tokenFor("a@hotel.example");
  const req = new Request("https://api.test/api/transactions", { headers: { "Cf-Access-Jwt-Assertion": token } });
  const res = await worker.fetch(req, env, CTX);
  assertEqual(res.status, 200, "authorized read must be 200");
  const body = await res.json();
  assert(body.transactions.every((t) => t.property_id === "P_A"), "no property-B transaction may leak");
  assertEqual(body.transactions.length, 1, "sees exactly its own 1 row");
});

await r.check("import to an out-of-scope property via the router => 403", async () => {
  const { db, env } = buildEnv();
  const token = await tokenFor("a@hotel.example");
  const chunk = {
    import_id: "imp-int",
    cursor: 0,
    rows: [{ property_code: "RRI-CAM", occurrence: 0, date: "2026-02-01", time: "10:00:00", folio_number: "X", transaction_code: "RENT", amount: 10.0 }],
  };
  const req = new Request("https://api.test/api/import", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": token, "content-type": "application/json" },
    body: JSON.stringify(chunk),
  });
  const res = await worker.fetch(req, env, CTX);
  assertEqual(res.status, 403, "cross-property import must be denied end-to-end");
  const landed = db.prepare("SELECT COUNT(*) c FROM transaction_line WHERE property_id = 'P_B'").get().c;
  assertEqual(landed, 1, "only the pre-seeded P_B row exists; import wrote nothing");
});

await r.check("non-/api/ path => 404 (this Worker owns /api/* only)", async () => {
  const { env } = buildEnv();
  const res = await worker.fetch(new Request("https://api.test/dashboard"), env, CTX);
  assertEqual(res.status, 404, "non-api path must be 404");
});

r.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: Worker router integration contract completed.");
