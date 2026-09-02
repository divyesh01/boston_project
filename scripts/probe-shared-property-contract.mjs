// End-to-end acceptance proof for the shared-data contract:
// Owner upload -> GM/Manager/Front Desk fresh requests -> the same D1 row.

import worker from "../worker/index.js";
import {
  makeDb,
  makeEnv,
  seedProperties,
  seedUser,
  generateRsaKey,
  makeJwks,
  makeJwksFetch,
  signRs256,
  makeRunner,
  assert,
  assertEqual,
} from "./_worker-testkit.mjs";

const r = makeRunner("probe-shared-property-contract");
const AUD = "aud-shared-contract";
const TEAM = "team.cloudflareaccess.com";
const ISS = `https://${TEAM}`;
const CERTS_URL = "https://synthetic.jwks/shared-contract";
const CTX = { waitUntil() {}, passThroughOnException() {} };
const key = await generateRsaKey("kid-shared");
const { fetchImpl } = makeJwksFetch(makeJwks(key.publicJwk));

const db = makeDb();
seedProperties(db, { accountId: "ACCOUNT_BOSTON", accountName: "Boston Hotel Group" });
seedUser(db, { id: "owner-1", accountId: "ACCOUNT_BOSTON", email: "owner@hotel.test", role: "owner", mode: "all" });
seedUser(db, { id: "gm-1", accountId: "ACCOUNT_BOSTON", email: "gm@hotel.test", role: "gm", mode: "all" });
seedUser(db, { id: "manager-1", accountId: "ACCOUNT_BOSTON", email: "manager@hotel.test", role: "manager", mode: "specific", grants: ["P_A"] });
seedUser(db, { id: "desk-1", accountId: "ACCOUNT_BOSTON", email: "desk@hotel.test", role: "front_desk", mode: "specific", grants: ["P_A"] });

db.prepare("INSERT INTO account (id, name, created_date) VALUES (?,?,?)").run("ACCOUNT_OTHER", "Other Hotel Group", "2026-01-01");
db.prepare("INSERT INTO property (id, account_id, code, name) VALUES (?,?,?,?)")
  .run("P_OTHER", "ACCOUNT_OTHER", "RRI-BOS", "Other Account Boston");
db.prepare("INSERT INTO property_id_map (account_id, local_numeric_id, code, server_id) VALUES (?,?,?,?)")
  .run("ACCOUNT_OTHER", 1, "RRI-BOS", "P_OTHER");
seedUser(db, { id: "other-owner", accountId: "ACCOUNT_OTHER", email: "other@hotel.test", role: "owner", mode: "all" });

const env = makeEnv(db, {
  ACCESS_AUD: AUD,
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_CERTS_URL: CERTS_URL,
  FETCH: fetchImpl,
});

async function tokenFor(email) {
  return signRs256({
    privateKey: key.privateKey,
    kid: "kid-shared",
    payload: {
      aud: AUD,
      iss: ISS,
      exp: Math.floor(Date.now() / 1000) + 3600,
      email,
      sub: `sub-${email}`,
    },
  });
}

async function api(email, path, init = {}) {
  const token = await tokenFor(email);
  const headers = {
    "Cf-Access-Jwt-Assertion": token,
    "X-Requested-With": "XMLHttpRequest",
    ...(init.headers || {}),
  };
  return worker.fetch(new Request(`https://api.test${path}`, { ...init, headers }), env, CTX);
}

await r.check("Owner uploads once into the account/property D1 partition", async () => {
  const res = await api("owner@hotel.test", "/api/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      import_id: "owner-upload-1",
      cursor: 0,
      final: true,
      rows: [{
        property_code: "RRI-BOS",
        occurrence: 0,
        date: "2026-08-31",
        time: "09:00:00",
        folio_number: "F-SHARED-1",
        transaction_code: "ROOM",
        amount: 321.45,
      }],
    }),
  });
  assertEqual(res.status, 200, "owner import must succeed");
  assertEqual((await res.json()).rows_inserted, 1, "exactly one authoritative row lands");
});

await r.check("the public D1 entity API preserves the same shared property row", async () => {
  const create = await api("owner@hotel.test", "/api/entities/OccupancyDay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: { property_id: "P_A", date: "2026-08-31", total_rooms: 120, rooms_sold: 40, room_revenue: 4000 } }),
  });
  assertEqual(create.status, 201, "Owner entity upload must succeed");
  const row = await create.json();
  for (const email of ["gm@hotel.test", "manager@hotel.test", "desk@hotel.test", "owner@hotel.test"]) {
    const read = await api(email, "/api/entities/OccupancyDay/query", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ filter: { id: row.id } }),
    });
    assertEqual(read.status, 200, `${email} must read the shared D1 entity row`);
    assertEqual((await read.json()).items.length, 1, `${email} sees the one shared entity row`);
  }
});

for (const [label, email] of [
  ["GM", "gm@hotel.test"],
  ["Manager", "manager@hotel.test"],
  ["Front Desk", "desk@hotel.test"],
]) {
  await r.check(`${label} fresh browser reads the same permitted property row without re-import`, async () => {
    const res = await api(email, "/api/transactions");
    assertEqual(res.status, 200, `${label} property read must succeed`);
    const body = await res.json();
    const shared = body.transactions.filter((row) => row.folio_number === "F-SHARED-1");
    assertEqual(shared.length, 1, `${label} sees the one Owner-uploaded row`);
    assertEqual(shared[0].property_id, "P_A", `${label} sees the shared property identity`);
    assertEqual(shared[0].amount, 321.45, `${label} sees the authoritative amount`);
  });
}

for (const email of ["owner@hotel.test", "gm@hotel.test", "manager@hotel.test", "desk@hotel.test"]) {
  await r.check(`${email} fresh browser gets server-backed account initialization`, async () => {
    const res = await api(email, "/api/account/status");
    assertEqual(res.status, 200, "account status must be readable");
    const body = await res.json();
    assertEqual(body.initialized, true, "an existing account never reports no users");
    assertEqual(body.user_count, 4, "the authoritative account roster has four users");
  });
}

await r.check("authorized management roles read one shared server-backed roster", async () => {
  for (const email of ["owner@hotel.test", "gm@hotel.test", "manager@hotel.test"]) {
    const res = await api(email, "/api/users");
    assertEqual(res.status, 200, `${email} can read the roster`);
    const body = await res.json();
    assertEqual(body.users.length, 4, `${email} sees all account users`);
    assert(body.users.some((user) => user.role === "front_desk"), "Front Desk assignment is server-backed");
  }
  const frontDesk = await api("desk@hotel.test", "/api/users");
  assertEqual(frontDesk.status, 403, "Front Desk cannot enumerate the roster");
});

await r.check("another account cannot infer the uploaded row even with the same property code", async () => {
  const res = await api("other@hotel.test", "/api/transactions");
  assertEqual(res.status, 200, "other account can read its own empty ledger");
  const body = await res.json();
  assertEqual(body.transactions.length, 0, "other account sees none of Boston account data");
});

await r.check("Front Desk role can read but cannot upload", async () => {
  const res = await api("desk@hotel.test", "/api/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ import_id: "desk-denied", cursor: 0, rows: [] }),
  });
  assertEqual(res.status, 403, "role controls the action, not a separate data copy");
});

r.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: shared-property server contract completed.");
