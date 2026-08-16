import { register } from "node:module";
register(new URL("./resolve-base44.mjs", import.meta.url));

const runtime = await import("./stubs/base44-runtime.mjs");
const registerFn = (await import("../base44/functions/custom_auth_register/entry.js")).default;

const sdk = await import("./stubs/base44-sdk.mjs");
const db = sdk.__installBackend({ users: [], sessions: [] });

const req = {
  headers: new Headers({
    "x-csrf-token": "test-csrf",
    "cookie": "__Host-csrf_token=test-csrf"
  }),
  json: async () => ({
    userData: {
      username: "owner1",
      email: "owner@example.com",
      password: "MySuperSecretPassword123!",
      role: "owner"
    }
  })
};

await registerFn(req);

const emails = db.__emails();
if (emails.length === 0) {
  console.error("FAIL: No welcome email sent.");
  process.exit(1);
}

const welcomeEmail = emails[0];
if (!welcomeEmail.body.includes("reset-password?token=") || welcomeEmail.body.includes("MySuperSecretPassword123!")) {
  console.error("FAIL: Email should contain reset link, not plaintext password");
  console.error("Body:", welcomeEmail.body);
  process.exit(1);
}

console.log("✓ Probe PASSED: Welcome email contains reset link and no plaintext password.");
