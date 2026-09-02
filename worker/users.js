import { queryAll, queryFirst } from "./db.js";
import { createCredentialForEnv, verifyCredentialForEnv } from "./password-credential.js";
import {
  generateTemporaryPassword,
  isValidEmail,
  isValidUsername,
  validatePasswordStrength,
} from "./password-policy.js";

const ADMIN_ROLES = new Set(["owner", "admin", "gm"]);
const ASSIGNABLE_ROLES = new Set(["owner", "admin", "gm", "manager", "front_desk"]);

class UserRequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function requireAdmin(scope) {
  const role = String(scope.user.role || "").toLowerCase();
  let permissions = {};
  try { permissions = scope.user.permissions ? JSON.parse(scope.user.permissions) : {}; } catch { permissions = {}; }
  if (!ADMIN_ROLES.has(role) || (role !== "owner" && permissions.manage_users !== true)) {
    throw new UserRequestError("forbidden", 403);
  }
}

function isOwner(scope) {
  return String(scope.user.role || "").toLowerCase() === "owner";
}

function assertMayManageRole(scope, role) {
  if (String(role).toLowerCase() === "owner" && !isOwner(scope)) throw new UserRequestError("only an owner may manage an owner account", 403);
}

function mayReadRoster(scope) {
  return ["owner", "admin", "gm", "manager"].includes(String(scope.user.role || "").toLowerCase());
}

function project(row) {
  let permissions = {};
  try { permissions = row.permissions ? JSON.parse(String(row.permissions)) : {}; } catch { permissions = {}; }
  return {
    id: row.id, username: row.username, display_name: row.display_name, full_name: row.display_name,
    email: row.email, role: row.role,
    property_access: row.property_access_mode === "all" ? "all" : String(row.property_ids || "").split(",").filter(Boolean),
    permissions, is_active: row.is_active !== 0, is_locked: row.is_locked === 1,
    must_change_password: row.must_change_password === 1,
  };
}

async function listUsers(env, accountId, search = "") {
  const params = [accountId];
  let searchSql = "";
  if (search) { searchSql = " AND (lower(u.username) LIKE ? OR lower(u.email) LIKE ? OR lower(u.display_name) LIKE ?)"; params.push(...Array(3).fill(`%${search.toLowerCase()}%`)); }
  const rows = await queryAll(env, `SELECT u.id,u.username,u.display_name,u.email,u.role,u.property_access_mode,u.permissions,u.is_active,u.is_locked,u.must_change_password,GROUP_CONCAT(upa.property_id) property_ids FROM user u LEFT JOIN user_property_access upa ON upa.account_id=u.account_id AND upa.user_id=u.id WHERE u.account_id=?${searchSql} GROUP BY u.id ORDER BY lower(u.username)`, params);
  return rows.map(project);
}

async function assertProperties(env, accountId, ids) {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  const row = await queryFirst(env, `SELECT COUNT(*) count FROM property WHERE account_id=? AND id IN (${placeholders})`, [accountId, ...ids]);
  if (Number(row?.count || 0) !== ids.length) throw new UserRequestError("property assignment is outside account", 403);
}

async function bodyOf(request) {
  try { return await request.json(); } catch { throw new UserRequestError("invalid JSON body"); }
}

async function newCredential(env, password) {
  const passwordError = validatePasswordStrength(password);
  if (passwordError) throw new UserRequestError(passwordError);
  try {
    return await createCredentialForEnv(password, env);
  } catch {
    throw new UserRequestError("credential service unavailable", 503);
  }
}

function isUniqueConstraint(error) {
  let current = error;
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    if (/\b(UNIQUE constraint failed|PRIMARY KEY must be unique)\b/i.test(String(current?.message || current))) return true;
    current = typeof current === "object" ? current.cause : null;
  }
  return false;
}

export async function handleUsersRequest(request, env, scope, pathParts) {
  try {
    const id = pathParts[2] ? decodeURIComponent(pathParts[2]) : "";
    const passwordAction = pathParts[3] === "password" ? pathParts[4] : "";
    if (!id && request.method === "GET") {
      if (!mayReadRoster(scope)) throw new UserRequestError("forbidden", 403);
      return Response.json({ users: await listUsers(env, scope.accountId, new URL(request.url).searchParams.get("q") || "") });
    }
    if (id && request.method === "GET") {
      if (!mayReadRoster(scope)) throw new UserRequestError("forbidden", 403);
      const user = (await listUsers(env, scope.accountId)).find((item) => String(item.id) === id);
      return user ? Response.json({ user }) : Response.json({ error: "not found" }, { status: 404 });
    }
    if (id && passwordAction === "change" && request.method === "POST") {
      if (id !== String(scope.user.id) || !scope.sessionId) throw new UserRequestError("forbidden", 403);
      const input = await bodyOf(request);
      const currentPassword = input.currentPassword;
      const newPassword = input.newPassword;
      if (typeof currentPassword !== "string" || typeof newPassword !== "string") throw new UserRequestError("currentPassword and newPassword are required");
      const current = await queryFirst(env, "SELECT password_hash FROM user WHERE id=? AND account_id=?", [id, scope.accountId]);
      if (!current) throw new UserRequestError("not found", 404);
      const verification = await verifyCredentialForEnv(currentPassword, current.password_hash, env);
      if (!verification.ok) throw new UserRequestError("current password is incorrect", 403);
      const credential = await newCredential(env, newPassword);
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("UPDATE user SET password_hash=?,salt=?,must_change_password=0,updated_date=? WHERE id=? AND account_id=? AND password_hash=?")
          .bind(credential.encoded, credential.salt, now, id, scope.accountId, current.password_hash),
        env.DB.prepare("DELETE FROM app_session WHERE user_id=? AND id<>? AND EXISTS (SELECT 1 FROM user WHERE id=? AND account_id=? AND password_hash=?)")
          .bind(id, scope.sessionId, id, scope.accountId, credential.encoded),
        env.DB.prepare("DELETE FROM app_mfa_challenge WHERE user_id=? AND EXISTS (SELECT 1 FROM user WHERE id=? AND account_id=? AND password_hash=?)")
          .bind(id, id, scope.accountId, credential.encoded),
      ]);
      const changed = await queryFirst(env, "SELECT password_hash FROM user WHERE id=? AND account_id=?", [id, scope.accountId]);
      if (changed?.password_hash !== credential.encoded) throw new UserRequestError("password changed concurrently; retry", 409);
      return Response.json({ success: true });
    }

    requireAdmin(scope);

    if (id && ["reset", "set"].includes(passwordAction) && request.method === "POST") {
      if (id === String(scope.user.id)) throw new UserRequestError("use current-password verification to change your own password", 403);
      const target = await queryFirst(env, "SELECT id,role FROM user WHERE id=? AND account_id=?", [id, scope.accountId]);
      if (!target) throw new UserRequestError("not found", 404);
      assertMayManageRole(scope, target.role);
      const input = await bodyOf(request);
      const suppliedPassword = Object.prototype.hasOwnProperty.call(input, "newPassword");
      if (passwordAction === "set" && !suppliedPassword) throw new UserRequestError("newPassword is required");
      if (suppliedPassword && typeof input.newPassword !== "string") throw new UserRequestError("newPassword must be a string");
      const password = suppliedPassword ? input.newPassword : generateTemporaryPassword();
      const credential = await newCredential(env, password);
      const mustChangePassword = passwordAction === "reset" ? 1 : 0;
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("UPDATE user SET password_hash=?,salt=?,must_change_password=?,failed_login_count=0,locked_until=NULL,is_locked=0,updated_date=? WHERE id=? AND account_id=?")
          .bind(credential.encoded, credential.salt, mustChangePassword, now, id, scope.accountId),
        env.DB.prepare("DELETE FROM app_session WHERE user_id=?").bind(id),
        env.DB.prepare("DELETE FROM app_mfa_challenge WHERE user_id=?").bind(id),
      ]);
      return Response.json(
        { success: true, ...(!suppliedPassword ? { temporary_password: password } : {}) },
        { headers: { "cache-control": "no-store" } },
      );
    }

    if (!id && request.method === "POST") {
      const input = await bodyOf(request); const data = input.data || input;
      const username = String(data.username || "").trim();
      const email = String(data.email || "").trim().toLowerCase();
      if (!isValidUsername(username)) throw new UserRequestError("username must be 3-30 letters, numbers, or underscores");
      if (!isValidEmail(email)) throw new UserRequestError("invalid email address");
      const role = String(data.role || "front_desk").toLowerCase();
      if (!ASSIGNABLE_ROLES.has(role)) throw new UserRequestError("invalid role");
      assertMayManageRole(scope, role);
      const access = data.property_access === "all" ? "all" : "specific";
      const grants = access === "all" ? [] : [...new Set((Array.isArray(data.property_access) ? data.property_access : []).map(String))];
      if (["owner", "admin", "gm"].includes(role) && access !== "all") throw new UserRequestError("this role requires all-property access");
      await assertProperties(env, scope.accountId, grants);
      const duplicate = await queryFirst(env, "SELECT id FROM user WHERE lower(username)=lower(?) OR lower(email)=lower(?) LIMIT 1", [username, email]);
      if (duplicate) throw new UserRequestError("username or email already in use", 409);

      const suppliedPassword = Object.prototype.hasOwnProperty.call(data, "password");
      if (suppliedPassword && typeof data.password !== "string") throw new UserRequestError("password must be a string");
      const password = suppliedPassword ? data.password : generateTemporaryPassword();
      const credential = await newCredential(env, password);

      const userId = crypto.randomUUID();
      const now = new Date().toISOString();
      const mustChangePassword = suppliedPassword ? (data.must_change_password ? 1 : 0) : 1;
      const statements = [env.DB.prepare("INSERT INTO user (id,account_id,username,display_name,email,role,property_access_mode,permissions,is_active,is_locked,must_change_password,password_hash,salt,created_date,updated_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(userId, scope.accountId, username, data.display_name || data.full_name || null, email, role, access, JSON.stringify(data.permissions || {}), data.is_active === false ? 0 : 1, data.is_locked ? 1 : 0, mustChangePassword, credential.encoded, credential.salt, now, now)];
      for (const propertyId of grants) statements.push(env.DB.prepare("INSERT INTO user_property_access (account_id,user_id,property_id) VALUES (?,?,?)").bind(scope.accountId, userId, propertyId));
      try {
        await env.DB.batch(statements);
      } catch (error) {
        if (isUniqueConstraint(error)) throw new UserRequestError("username or email already in use", 409);
        throw error;
      }
      const user = (await listUsers(env, scope.accountId)).find((item) => item.id === userId);
      return Response.json(
        { user, ...(!suppliedPassword ? { temporary_password: password } : {}) },
        { status: 201, headers: { "cache-control": "no-store" } },
      );
    }
    if (id && request.method === "PATCH") {
      if (id === String(scope.user.id)) throw new UserRequestError("cannot modify your own account", 409);
      const current = await queryFirst(env, "SELECT * FROM user WHERE id=? AND account_id=?", [id, scope.accountId]);
      if (!current) throw new UserRequestError("not found", 404);
      const input = await bodyOf(request); const data = input.data || input;
      const username = String(data.username ?? current.username).trim();
      const email = String(data.email ?? current.email).trim().toLowerCase();
      if (!isValidUsername(username)) throw new UserRequestError("username must be 3-30 letters, numbers, or underscores");
      if (!isValidEmail(email)) throw new UserRequestError("invalid email address");
      const role = data.role == null ? current.role : String(data.role).toLowerCase();
      if (!ASSIGNABLE_ROLES.has(role)) throw new UserRequestError("invalid role");
      assertMayManageRole(scope, current.role);
      assertMayManageRole(scope, role);
      const requestedAccess = data.property_access === undefined ? current.property_access_mode : (data.property_access === "all" ? "all" : "specific");
      const grants = requestedAccess === "all" ? [] : [...new Set((Array.isArray(data.property_access) ? data.property_access : (await queryAll(env, "SELECT property_id FROM user_property_access WHERE account_id=? AND user_id=?", [scope.accountId,id])).map((row) => row.property_id)).map(String))];
      if (["owner", "admin", "gm"].includes(role) && requestedAccess !== "all") throw new UserRequestError("this role requires all-property access");
      await assertProperties(env, scope.accountId, grants);
      const active = data.is_active === undefined ? current.is_active : (data.is_active ? 1 : 0);
      const changingActiveOwner = current.role === "owner" && current.is_active !== 0 && (role !== "owner" || active === 0);
      const mutationTime = new Date().toISOString();
      const ownerGuard = changingActiveOwner
        ? " AND EXISTS (SELECT 1 FROM user other WHERE other.account_id=? AND other.role='owner' AND other.is_active<>0 AND other.id<>?)"
        : "";
      const updateParams = [username, data.display_name ?? data.full_name ?? current.display_name, email, role, requestedAccess, JSON.stringify(data.permissions ?? JSON.parse(current.permissions || "{}")), active, data.is_locked === undefined ? current.is_locked : (data.is_locked ? 1 : 0), data.must_change_password === undefined ? current.must_change_password : (data.must_change_password ? 1 : 0), mutationTime, id, scope.accountId, ...(changingActiveOwner ? [scope.accountId, id] : [])];
      const statements = [env.DB.prepare(`UPDATE user SET username=?,display_name=?,email=?,role=?,property_access_mode=?,permissions=?,is_active=?,is_locked=?,must_change_password=?,updated_date=? WHERE id=? AND account_id=?${ownerGuard}`).bind(...updateParams)];
      statements.push(env.DB.prepare("DELETE FROM user_property_access WHERE account_id=? AND user_id=? AND EXISTS (SELECT 1 FROM user WHERE id=? AND account_id=? AND updated_date=?)").bind(scope.accountId, id, id, scope.accountId, mutationTime));
      for (const propertyId of grants) statements.push(env.DB.prepare("INSERT INTO user_property_access (account_id,user_id,property_id) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM user WHERE id=? AND account_id=? AND updated_date=?)").bind(scope.accountId,id,propertyId,id,scope.accountId,mutationTime));
      let results;
      try { results = await env.DB.batch(statements); }
      catch (error) {
        if (isUniqueConstraint(error)) throw new UserRequestError("username or email already in use", 409);
        throw error;
      }
      if (Number(results?.[0]?.meta?.changes ?? results?.[0]?.changes ?? 0) !== 1) throw new UserRequestError("cannot remove or demote the last active owner", 409);
      return Response.json({ user: (await listUsers(env, scope.accountId)).find((item) => item.id === id) });
    }
    if (id && request.method === "DELETE") {
      if (id === String(scope.user.id)) throw new UserRequestError("cannot delete your own account", 409);
      const target = await queryFirst(env, "SELECT role,is_active FROM user WHERE id=? AND account_id=?", [id, scope.accountId]);
      if (!target) throw new UserRequestError("not found", 404);
      assertMayManageRole(scope, target.role);
      const result = await env.DB.prepare("DELETE FROM user WHERE id=? AND account_id=? AND (role<>'owner' OR is_active=0 OR EXISTS (SELECT 1 FROM user other WHERE other.account_id=? AND other.role='owner' AND other.is_active<>0 AND other.id<>?))").bind(id, scope.accountId, scope.accountId, id).run();
      if (Number(result?.meta?.changes ?? result?.changes ?? 0) !== 1) throw new UserRequestError("cannot delete the last active owner", 409);
      return Response.json({ success: true });
    }
    return Response.json({ error: "method not allowed" }, { status: 405 });
  } catch (error) {
    if (error instanceof UserRequestError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
