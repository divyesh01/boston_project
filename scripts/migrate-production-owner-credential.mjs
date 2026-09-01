// One-time, fail-closed migration of the existing production owner's verifier.
// The owner identity/account rows are never recreated. The password and pepper
// remain process-memory-only; only the versioned verifier is written to D1.

import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createCredential, verifyCredential } from "../worker/password-credential.js";
import { REPO_ROOT } from "./_repo-root.mjs";

const database = process.argv[2] || "boston-project-production-auth";
const config = path.resolve(REPO_ROOT, process.argv[3] || "wrangler.jsonc");
const workerName = process.argv[4] || "boston-project";
const npxCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
const work = await mkdtemp(path.join(tmpdir(), "rri-owner-migrate-"));
const updateFile = path.join(work, "update.sql");
const restoreFile = path.join(work, "restore.sql");
let password = "";
let pepper = "";

function sql(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function wrangler(args, options = {}) {
  const result = spawnSync(process.execPath, [npxCli, "wrangler", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw new Error(`Wrangler process failed to start (${result.error.code || result.error.name}).`);
  if (result.signal) throw new Error(`Wrangler process ended by signal ${result.signal}.`);
  if (result.status !== 0) throw new Error(`Wrangler failed with exit code ${result.status}: ${String(result.stderr || result.stdout).slice(-1000)}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}
function d1Rows(command) {
  const output = wrangler(["d1", "execute", database, "--remote", "--config", config, "--command", command, "--json"]);
  const parsed = JSON.parse(output.trim());
  return parsed?.[0]?.results || [];
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
function profileOf(row) {
  const { password_hash: _hash, salt: _salt, ...profile } = row;
  return profile;
}
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

if (!existsSync(config)) throw new Error(`Wrangler config not found: ${config}`);
try {
  const owners = d1Rows("SELECT u.*,a.name account_name,a.created_date account_created_date FROM user u JOIN account a ON a.id=u.account_id WHERE lower(u.role)='owner' ORDER BY u.id;");
  if (owners.length !== 1) throw new Error(`Expected exactly one owner; found ${owners.length}.`);
  const owner = owners[0];
  const legacyMatch = /^\$pbkdf2\$([a-f0-9]{64})$/i.exec(String(owner.password_hash || ""));
  if (!legacyMatch || !owner.salt) throw new Error("Existing owner credential is not the expected legacy 310000-iteration format; refusing migration.");
  const sessionCount = Number(d1Rows("SELECT COUNT(*) count FROM app_session;")?.[0]?.count || 0);
  if (sessionCount !== 0) throw new Error(`Expected zero sessions before migration; found ${sessionCount}.`);

  const timeTravel = wrangler(["d1", "time-travel", "info", database, "--config", config, "--timestamp", new Date().toISOString(), "--json"]);
  const bookmark = JSON.parse(timeTravel)?.bookmark || JSON.parse(timeTravel)?.result?.bookmark || "recorded";
  process.stdout.write(`Time Travel recovery point established (${bookmark}).\n`);

  password = await askHidden("Existing production owner password (input hidden): ");
  const legacyActual = pbkdf2Sync(password, String(owner.salt), 310_000, 32, "sha256");
  const legacyExpected = Buffer.from(legacyMatch[1], "hex");
  if (legacyActual.length !== legacyExpected.length || !timingSafeEqual(legacyActual, legacyExpected)) {
    throw new Error("The entered password does not match the existing owner verifier. No credential or secret was changed.");
  }

  pepper = randomBytes(48).toString("base64url");
  const credential = await createCredential(password, pepper);
  if (!await verifyCredential(password, credential.encoded, pepper)) throw new Error("New credential self-verification failed before migration.");

  wrangler(["versions", "secret", "put", "PASSWORD_PEPPER_V1", "--name", workerName, "--message", "Add password pepper for versioned owner credential (not deployed)"], { input: `${pepper}\n` });
  process.stdout.write("Versioned password pepper stored as an undeployed Cloudflare Worker secret version.\n");

  const update = `UPDATE user SET password_hash=${sql(credential.encoded)},salt=${sql(credential.salt)} WHERE id=${sql(owner.id)} AND account_id=${sql(owner.account_id)} AND password_hash=${sql(owner.password_hash)} AND salt=${sql(owner.salt)};`;
  const restore = `UPDATE user SET password_hash=${sql(owner.password_hash)},salt=${sql(owner.salt)} WHERE id=${sql(owner.id)} AND account_id=${sql(owner.account_id)} AND password_hash=${sql(credential.encoded)} AND salt=${sql(credential.salt)};`;
  await writeFile(updateFile, update, { mode: 0o600 });
  await writeFile(restoreFile, restore, { mode: 0o600 });
  wrangler(["d1", "execute", database, "--remote", "--config", config, "--file", updateFile, "--yes"]);

  const afterOwners = d1Rows("SELECT u.*,a.name account_name,a.created_date account_created_date FROM user u JOIN account a ON a.id=u.account_id WHERE lower(u.role)='owner' ORDER BY u.id;");
  const afterSessions = Number(d1Rows("SELECT COUNT(*) count FROM app_session;")?.[0]?.count || 0);
  const afterAccounts = Number(d1Rows("SELECT COUNT(*) count FROM account;")?.[0]?.count || 0);
  const beforeAccounts = Number(d1Rows(`SELECT COUNT(*) count FROM account WHERE id=${sql(owner.account_id)};`)?.[0]?.count || 0);
  const verified = afterOwners.length === 1
    && afterOwners[0].password_hash === credential.encoded
    && afterOwners[0].salt === credential.salt
    && sameJson(profileOf(afterOwners[0]), profileOf(owner))
    && afterSessions === 0
    && beforeAccounts === 1
    && afterAccounts === 1
    && await verifyCredential(password, afterOwners[0].password_hash, pepper);
  if (!verified) {
    wrangler(["d1", "execute", database, "--remote", "--config", config, "--file", restoreFile, "--yes"]);
    throw new Error("Post-migration verification failed; the previous owner verifier was restored.");
  }

  process.stdout.write("OWNER VERIFIER RE-DERIVED: PASS\n");
  process.stdout.write("OWNER ID PRESERVED: PASS\n");
  process.stdout.write("OWNER PROFILE PRESERVED: PASS\n");
  process.stdout.write("DUPLICATE OWNER RECORDS: NO\n");
  process.stdout.write("PLAINTEXT PASSWORD PERSISTED: NO\n");
  process.stdout.write("PRODUCTION WORKER DEPLOYED: NO\n");
} finally {
  password = "";
  pepper = "";
  await rm(work, { recursive: true, force: true });
}
