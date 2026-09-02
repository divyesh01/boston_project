import worker from "../worker/index.js";
import {
  assertEqual,
  generateRsaKey,
  makeDb,
  makeEnv,
  makeJwks,
  makeJwksFetch,
  makeRunner,
  seedProperties,
  seedUser,
  signRs256,
} from "./_worker-testkit.mjs";

const run = makeRunner("probe-worker-business-sync-route");
const AUD = "sync-aud";
const TEAM = "team.cloudflareaccess.com";
const ISS = `https://${TEAM}`;
const CTX = { waitUntil() {}, passThroughOnException() {} };
const key = await generateRsaKey("sync-kid");
const { fetchImpl } = makeJwksFetch(makeJwks(key.publicJwk));

function fixture(enabled) {
  const db = makeDb();
  seedProperties(db);
  seedUser(db, { id: "owner", email: "owner@sync.test", role: "owner", mode: "all" });
  seedUser(db, { id: "staff", email: "staff@sync.test", role: "staff", mode: "specific", grants: ["P_A"] });
  return makeEnv(db, {
    ENABLE_BUSINESS_SYNC_API: enabled ? "true" : "false",
    ACCESS_AUD: AUD,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_CERTS_URL: "https://synthetic.jwks/sync",
    FETCH: fetchImpl,
  });
}

async function token(email) {
  return signRs256({
    privateKey: key.privateKey,
    kid: key.kid,
    payload: { aud: AUD, iss: ISS, exp: Math.floor(Date.now() / 1000) + 3600, email, sub: email },
  });
}

await run.check("unauthenticated sync route is rejected before handler", async () => {
  const response = await worker.fetch(new Request("https://api.test/api/business-sync/snapshot?entity=Property"), fixture(true), CTX);
  assertEqual(response.status, 401);
});

await run.check("independent production sync kill switch fails closed", async () => {
  const response = await worker.fetch(new Request("https://api.test/api/business-sync/snapshot?entity=Property", { headers: { "Cf-Access-Jwt-Assertion": await token("owner@sync.test") } }), fixture(false), CTX);
  assertEqual(response.status, 404);
  assertEqual((await response.json()).error, "business-data sync is disabled");
});

await run.check("enabled route reports no active dataset without touching local data", async () => {
  const response = await worker.fetch(new Request("https://api.test/api/business-sync/snapshot?entity=Property", { headers: { "Cf-Access-Jwt-Assertion": await token("owner@sync.test") } }), fixture(true), CTX);
  assertEqual(response.status, 404);
  assertEqual((await response.json()).code, "no_active_dataset");
});

await run.check("non-owner migration attempt is forbidden through the real router", async () => {
  const manifest = { schema_version: 1, counts: { Property: 1 }, chunks: [{ index: 0, count: 1, hash: "x" }] };
  const response = await worker.fetch(new Request("https://api.test/api/business-sync/migration/start", {
    method: "POST",
    headers: {
      "Cf-Access-Jwt-Assertion": await token("staff@sync.test"),
      "content-type": "application/json",
      "Origin": "https://api.test",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify({ manifest, manifest_hash: "bad" }),
  }), fixture(true), CTX);
  assertEqual(response.status, 403);
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: business sync router/auth/kill-switch contract completed.");
