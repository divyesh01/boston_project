/**
 * Deterministic Worker settings contract against the real worker/schema.sql.
 * Covers global CAS monotonicity, atomic same-key races, property isolation,
 * permission overrides, and hostile value clamping.
 */
import { handleSettingsRequest } from "../worker/settings.js";
import { makeDb, makeEnv, seedProperties } from "./_worker-testkit.mjs";

const sqlite = makeDb();
seedProperties(sqlite);
const env = makeEnv(sqlite);
const url = new URL("https://example.test/api/settings");
const owner = { accountId: "A_1", all: true, propertyIds: ["P_A", "P_B"], user: { id: "U_OWNER", role: "owner", permissions: {} } };
const manager = {
  accountId: "A_1",
  all: false,
  propertyIds: ["P_A"],
  user: { id: "U_MANAGER", role: "manager", permissions: { manage_ota_commissions: true, manage_pricing: true } },
};

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function save(scope, body) {
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleSettingsRequest(request, env, scope, url, ["settings"]);
}

async function read(scope) {
  const request = new Request(url, { method: "GET" });
  return handleSettingsRequest(request, env, scope, url, ["settings"]);
}

const first = await save(owner, { key: "rri_cc_fee_rate", value: 0.03 });
check("first write owns revision 1", first.status === 200 && first.headers.get("x-settings-rev") === "1");

const second = await save(owner, { key: "rri_tax_config_v1", value: { taxRate: 0.12, taxEnabled: true }, expected_revision: 1 });
check("a different key advances the account revision to 2", second.status === 200 && second.headers.get("x-settings-rev") === "2");

const stale = await save(owner, { key: "rri_cc_fee_rate", value: 0.04, expected_revision: 1 });
check("a stale write conflicts even when its row had an older revision", stale.status === 409, `status=${stale.status}`);

const race = await Promise.all([
  save(owner, { key: "rri_cc_fee_rate", value: 0.041, expected_revision: 2 }),
  save(owner, { key: "rri_cc_fee_rate", value: 0.042, expected_revision: 2 }),
]);
const raceStatuses = race.map((response) => response.status).sort();
check("same-key concurrent CAS has one winner and one conflict", raceStatuses.join(",") === "200,409", raceStatuses.join(","));
const revisionThreeHistory = sqlite.prepare(
  "SELECT COUNT(*) AS n FROM app_setting_history WHERE account_id='A_1' AND setting_key='rri_cc_fee_rate' AND revision=3"
).get();
check("the losing race left no second history row", Number(revisionThreeHistory.n) === 1, `rows=${revisionThreeHistory.n}`);

const managerOwn = await save(manager, {
  key: "rri_commission_rates_v2",
  property_id: "P_A",
  value: { booking: { type: "fixed", rate: 50000, taxExempt: "false" } },
});
check("explicitly permitted manager can write an assigned property", managerOwn.status === 200, `status=${managerOwn.status}`);
const storedCommission = JSON.parse(sqlite.prepare(
  "SELECT value_json FROM app_setting WHERE account_id='A_1' AND setting_key='rri_commission_rates_v2' AND property_id='P_A'"
).get().value_json);
check("fixed commission is capped and string false stays false", storedCommission.booking.rate === 10000 && storedCommission.booking.taxExempt === false);

check("manager cannot write another property", (await save(manager, { key: "rri_cc_fee_rate", property_id: "P_B", value: 0.02 })).status === 403);
check("manager cannot write portfolio-global settings", (await save(manager, { key: "rri_cc_fee_rate", property_id: "*", value: 0.02 })).status === 403);
const strippedManager = { ...manager, user: { ...manager.user, permissions: { manage_ota_commissions: false, manage_pricing: false } } };
check("role name alone cannot restore an explicitly removed permission", (await save(strippedManager, { key: "rri_cc_fee_rate", property_id: "P_A", value: 0.02 })).status === 403);

const managerRevisionBeforeInvisibleWrite = Number((await read(manager)).headers.get("x-settings-rev"));
await save(owner, { key: "rri_pricing_config", property_id: "P_B", value: { minMultiplier: 0.8 } });
const managerAfterInvisibleWrite = await save(manager, {
  key: "rri_pricing_config",
  property_id: "P_A",
  value: { minMultiplier: 0.9 },
  expected_revision: managerRevisionBeforeInvisibleWrite,
});
check("an invisible-property revision cannot deadlock a scoped manager", managerAfterInvisibleWrite.status === 200, `status=${managerAfterInvisibleWrite.status}`);
const scopedRead = await read(manager);
const scopedBody = await scopedRead.json();
check("restricted GET includes global settings", scopedRead.status === 200 && scopedBody.settings.rri_cc_fee_rate !== undefined);
check("restricted GET includes assigned-property settings", scopedBody.settings._byProperty?.P_A?.rri_commission_rates_v2 !== undefined);
check("restricted GET excludes other-property settings", scopedBody.settings._byProperty?.P_B === undefined);

console.log(`\nprobe-worker-settings: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
else console.log("PASSED: All probe-worker-settings tests passed.");
