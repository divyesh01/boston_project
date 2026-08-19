import { testWorld } from './probe-auth-hardening.mjs';

async function main() {
  const world = await testWorld();
  console.log("=== 1. Non-object filter causes 500 ===");
  const res1 = await world.invoke("audit_list", { filter: "not_an_object" }, world.auth.admin1);
  console.log("Response 1:", res1.status, await res1.text());

  console.log("\n=== 2. Admin restricted to prop1 queries prop2 ===");
  const res2 = await world.invoke("audit_list", { filter: { property_id: "prop2" } }, world.auth.admin1);
  console.log("Response 2:", res2.status, await res2.text());

  process.exit(0);
}
main();
