import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createCredential } from "../worker/password-credential.js";
import { ownerPermissionsJson } from "../worker/session-permissions.js";


function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function ask(rl, label) {
  return new Promise((resolve) => rl.question(label, (answer) => resolve(answer.trim())));
}

function askHidden(label) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error("A real interactive terminal is required.");
  process.stdout.write(label);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onKey = (character, key) => {
      if (key?.ctrl && key.name === "c") return finish(new Error("Cancelled."));
      if (key?.name === "return" || key?.name === "enter") return finish();
      if (key?.name === "backspace") { value = value.slice(0, -1); return; }
      if (character && !key?.ctrl && !key?.meta) value += character;
    };
    process.stdin.on("keypress", onKey);
  });
}

const database = process.argv[2];
const config = process.argv[3] || "wrangler.jsonc";
if (!database) throw new Error("Usage: node scripts/provision-production-owner.mjs <database-name> [wrangler-config]");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const username = await ask(rl, "New production owner username: ");
const email = (await ask(rl, "New production owner email: ")).toLowerCase();
const displayName = await ask(rl, "New production owner display name: ");
rl.close();
if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) throw new Error("Username must be 3-64 letters, digits, dots, underscores, or hyphens.");
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A valid email is required.");

const password = await askHidden("New production owner password (input hidden): ");
const confirmation = await askHidden("Confirm production owner password (input hidden): ");
if (password !== confirmation) throw new Error("Passwords did not match.");
if (password.length < 14 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
  throw new Error("Password must be 14+ characters with upper, lower, number, and symbol.");
}

const pepper = String(process.env.PASSWORD_PEPPER_V1 || "");
if (pepper.length < 32) throw new Error("PASSWORD_PEPPER_V1 must be supplied securely to provision a versioned credential.");
const credential = await createCredential(password, pepper);
const now = new Date().toISOString();
const accountId = randomUUID();
const userId = randomUUID();
const ownerPermissions = ownerPermissionsJson();
const tempRoot = await mkdtemp(path.join(tmpdir(), "rri-owner-"));
const sqlPath = path.join(tempRoot, "owner.sql");
try {
  const statement = [
    // Wrangler's remote D1 file importer owns the atomic transaction and rolls
    // the file back on failure. Explicit BEGIN/COMMIT are rejected by D1.
    `INSERT INTO account (id,name,created_date) VALUES (${sql(accountId)},${sql("RRI Executive")},${sql(now)});`,
    "INSERT INTO user (id,account_id,username,display_name,email,role,property_access_mode,permissions,is_active,is_locked,must_change_password,mfa_enabled,email_confirmed,password_hash,salt,failed_login_count,created_date,updated_date) VALUES " +
      `(${sql(userId)},${sql(accountId)},${sql(username)},${sql(displayName)},${sql(email)},'owner','all',${sql(ownerPermissions)},1,0,0,0,1,${sql(credential.encoded)},${sql(credential.salt)},0,${sql(now)},${sql(now)});`,
  ].join("\n");
  await writeFile(sqlPath, statement, { encoding: "utf8", mode: 0o600 });
  // Node cannot spawn a .cmd file directly with shell:false on Windows: it
  // returns status=null/error=EINVAL. Execute npm's JS entry through node.exe
  // instead, preserving the no-shell boundary and argument separation.
  const npxCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  const command = process.platform === "win32" ? process.execPath : "npx";
  const args = process.platform === "win32"
    ? [npxCli, "wrangler", "d1", "execute", database, "--remote", "--config", config, "--file", sqlPath]
    : ["wrangler", "d1", "execute", database, "--remote", "--config", config, "--file", sqlPath];
  if (process.platform === "win32" && !existsSync(npxCli)) throw new Error("Cannot locate npm's npx CLI beside node.exe.");
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw new Error(`Owner provisioning process failed to start (${result.error.code || result.error.name}).`);
  if (result.signal) throw new Error(`Owner provisioning process ended by signal ${result.signal}.`);
  if (result.status !== 0) throw new Error(`Owner provisioning failed with exit code ${result.status}.`);
  process.stdout.write("Production owner credential stored in the versioned Worker-compatible format. Plaintext was not persisted.\n");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
