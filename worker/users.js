import { queryAll, queryFirst } from "./db.js";

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

export async function handleUsersRequest(request, env, scope, pathParts) {
  try {
    const id = pathParts[2] ? decodeURIComponent(pathParts[2]) : "";
    if (!id && request.method === "GET") {
      if (!mayReadRoster(scope)) throw new UserRequestError("forbidden", 403);
      return Response.json({ users: await listUsers(env, scope.accountId, new URL(request.url).searchParams.get("q") || "") });
    }
    if (id && request.method === "GET") {
      if (!mayReadRoster(scope)) throw new UserRequestError("forbidden", 403);
      const user = (await listUsers(env, scope.accountId)).find((item) => String(item.id) === id);
      return user ? Response.json({ user }) : Response.json({ error: "not found" }, { status: 404 });
    }
    requireAdmin(scope);
    if (!id && request.method === "POST") {
      const input = await bodyOf(request); const data = input.data || input;
      const role = String(data.role || "front_desk").toLowerCase();
      if (!ASSIGNABLE_ROLES.has(role)) throw new UserRequestError("invalid role");
      const access = data.property_access === "all" ? "all" : "specific";
      const grants = access === "all" ? [] : [...new Set((Array.isArray(data.property_access) ? data.property_access : []).map(String))];
      if (["owner", "admin", "gm"].includes(role) && access !== "all") throw new UserRequestError("this role requires all-property access");
      await assertProperties(env, scope.accountId, grants);
      const userId = crypto.randomUUID();
      const statements = [env.DB.prepare("INSERT INTO user (id,account_id,username,display_name,email,role,property_access_mode,permissions,is_active,is_locked,must_change_password,created_date,updated_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(userId, scope.accountId, String(data.username || "").trim(), data.display_name || data.full_name || null, String(data.email || "").trim().toLowerCase(), role, access, JSON.stringify(data.permissions || {}), data.is_active === false ? 0 : 1, data.is_locked ? 1 : 0, data.must_change_password ? 1 : 0, new Date().toISOString(), new Date().toISOString())];
      for (const propertyId of grants) statements.push(env.DB.prepare("INSERT INTO user_property_access (account_id,user_id,property_id) VALUES (?,?,?)").bind(scope.accountId, userId, propertyId));
      await env.DB.batch(statements);
      const user = (await listUsers(env, scope.accountId)).find((item) => item.id === userId);
      return Response.json({ user }, { status: 201 });
    }
    if (id && request.method === "PATCH") {
      if (id === String(scope.user.id)) throw new UserRequestError("cannot modify your own account", 409);
      const current = await queryFirst(env, "SELECT * FROM user WHERE id=? AND account_id=?", [id, scope.accountId]);
      if (!current) throw new UserRequestError("not found", 404);
      const input = await bodyOf(request); const data = input.data || input;
      const role = data.role == null ? current.role : String(data.role).toLowerCase();
      if (!ASSIGNABLE_ROLES.has(role)) throw new UserRequestError("invalid role");
      const requestedAccess = data.property_access === undefined ? current.property_access_mode : (data.property_access === "all" ? "all" : "specific");
      const grants = requestedAccess === "all" ? [] : [...new Set((Array.isArray(data.property_access) ? data.property_access : (await queryAll(env, "SELECT property_id FROM user_property_access WHERE account_id=? AND user_id=?", [scope.accountId,id])).map((row) => row.property_id)).map(String))];
      if (["owner", "admin", "gm"].includes(role) && requestedAccess !== "all") throw new UserRequestError("this role requires all-property access");
      await assertProperties(env, scope.accountId, grants);
      if (current.role === "owner" && (role !== "owner" || data.is_active === false)) {
        const owners = await queryFirst(env, "SELECT COUNT(*) count FROM user WHERE account_id=? AND role='owner' AND is_active<>0", [scope.accountId]);
        if (Number(owners?.count || 0) <= 1) throw new UserRequestError("cannot remove or demote the last active owner", 409);
      }
      const statements = [env.DB.prepare("UPDATE user SET username=?,display_name=?,email=?,role=?,property_access_mode=?,permissions=?,is_active=?,is_locked=?,must_change_password=?,updated_date=? WHERE id=? AND account_id=?").bind(data.username ?? current.username, data.display_name ?? data.full_name ?? current.display_name, String(data.email ?? current.email).toLowerCase(), role, requestedAccess, JSON.stringify(data.permissions ?? JSON.parse(current.permissions || "{}")), data.is_active === undefined ? current.is_active : (data.is_active ? 1 : 0), data.is_locked === undefined ? current.is_locked : (data.is_locked ? 1 : 0), data.must_change_password === undefined ? current.must_change_password : (data.must_change_password ? 1 : 0), new Date().toISOString(), id, scope.accountId), env.DB.prepare("DELETE FROM user_property_access WHERE account_id=? AND user_id=?").bind(scope.accountId,id)];
      for (const propertyId of grants) statements.push(env.DB.prepare("INSERT INTO user_property_access (account_id,user_id,property_id) VALUES (?,?,?)").bind(scope.accountId,id,propertyId));
      await env.DB.batch(statements);
      return Response.json({ user: (await listUsers(env, scope.accountId)).find((item) => item.id === id) });
    }
    if (id && request.method === "DELETE") {
      if (id === String(scope.user.id)) throw new UserRequestError("cannot delete your own account", 409);
      const target = await queryFirst(env, "SELECT role,is_active FROM user WHERE id=? AND account_id=?", [id, scope.accountId]);
      if (!target) throw new UserRequestError("not found", 404);
      if (target.role === "owner" && target.is_active !== 0) {
        const owners = await queryFirst(env, "SELECT COUNT(*) count FROM user WHERE account_id=? AND role='owner' AND is_active<>0", [scope.accountId]);
        if (Number(owners?.count || 0) <= 1) throw new UserRequestError("cannot delete the last active owner", 409);
      }
      await env.DB.prepare("DELETE FROM user WHERE id=? AND account_id=?").bind(id, scope.accountId).run();
      return Response.json({ success: true });
    }
    return Response.json({ error: "method not allowed" }, { status: 405 });
  } catch (error) {
    if (error instanceof UserRequestError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
