import bcrypt from "bcrypt";
import { pool } from "../config/database.js";
import { HttpError } from "../utils/http.js";
import { getUserPermissions } from "../middleware/rbac.js";

async function publicUser(user) {
  const permissions = user.permissions || (await getUserPermissions(user.id));
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    roleName: user.role_name || user.role,
    customRoleId: user.custom_role_id ?? user.customRoleId ?? null,
    status: user.status,
    tenantId: user.tenant_id ?? null,
    profilePhoto: user.profile_photo || "",
    profile_photo: user.profile_photo || "",
    createdAt: user.created_at || null,
    permissions,
  };
}

export async function authenticateUser(email, password) {
  const [rows] = await pool.execute(
    `SELECT u.id, u.tenant_id, u.created_by_user_id, u.name, u.email, u.password_hash, u.role, u.custom_role_id, u.status, u.email_verified_at, u.profile_photo, u.created_at,
            COALESCE(r.name, u.role) AS role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.custom_role_id
      WHERE u.email = ? AND u.deleted_at IS NULL LIMIT 1`,
    [email.toLowerCase()],
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    throw new HttpError(401, "Invalid email or password.");
  if (user.status !== "ACTIVE") throw new HttpError(403, "This account is inactive.");
  if (!user.email_verified_at)
    throw new HttpError(403, "Please verify your email before signing in.");
  if (user.role !== "SUPER_ADMIN" && !user.tenant_id)
    throw new HttpError(403, "This account is not linked to a workspace.");
  return await publicUser(user);
}

export async function authenticateSuperAdminUser(email, password) {
  const [rows] = await pool.execute(
    "SELECT id, tenant_id, created_by_user_id, name, email, password_hash, role, custom_role_id, status, email_verified_at, profile_photo, created_at FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1",
    [email.toLowerCase()],
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    throw new HttpError(401, "Invalid email or password.");
  if (user.role !== "SUPER_ADMIN")
    throw new HttpError(403, "Super Admin credentials are required.");
  if (user.status !== "ACTIVE") throw new HttpError(403, "This account is inactive.");
  if (!user.email_verified_at)
    throw new HttpError(403, "Please verify your email before signing in.");
  return await publicUser(user);
}

export async function findUserById(id) {
  const [rows] = await pool.execute(
    `SELECT u.id, u.tenant_id, u.created_by_user_id, u.name, u.email, u.role, u.custom_role_id, u.status, u.email_verified_at, u.profile_photo, u.created_at,
            COALESCE(r.name, u.role) AS role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.custom_role_id
      WHERE u.id = ? AND u.deleted_at IS NULL LIMIT 1`,
    [id],
  );
  const user = rows[0];
  if (!user) throw new HttpError(401, "User account no longer exists.");
  if (user.status !== "ACTIVE") throw new HttpError(403, "This account is inactive.");
  if (user.role !== "SUPER_ADMIN" && !user.tenant_id)
    throw new HttpError(403, "This account is not linked to a workspace.");
  return await publicUser(user);
}

export async function findSuperAdminById(id) {
  const [rows] = await pool.execute(
    "SELECT id, tenant_id, created_by_user_id, name, email, role, custom_role_id, status, email_verified_at, profile_photo FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1",
    [id],
  );
  const user = rows[0];
  if (!user || user.role !== "SUPER_ADMIN")
    throw new HttpError(401, "Super Admin account no longer exists.");
  if (user.status !== "ACTIVE") throw new HttpError(403, "This account is inactive.");
  return await publicUser(user);
}

export async function updateUserProfile(userId, { name, email, status }) {
  const [rows] = await pool.execute(
    "SELECT id, tenant_id, role, name, email, status FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1",
    [userId],
  );
  const user = rows[0];
  if (!user) throw new HttpError(404, "User account not found.");

  const updates = [];
  const params = [];

  if (typeof name === "string" && name.trim()) {
    updates.push("name = ?");
    params.push(name.trim());
  }

  if (typeof email === "string" && email.trim()) {
    const cleanEmail = email.trim().toLowerCase();
    const [existing] = await pool.execute(
      "SELECT id FROM users WHERE email = ? AND id != ? AND deleted_at IS NULL LIMIT 1",
      [cleanEmail, userId],
    );
    if (existing.length > 0) {
      throw new HttpError(409, "Email address is already in use by another account.");
    }
    updates.push("email = ?");
    params.push(cleanEmail);
  }

  if (status && (status === "ACTIVE" || status === "INACTIVE")) {
    updates.push("status = ?");
    params.push(status);
  }

  if (updates.length > 0) {
    params.push(userId);
    await pool.execute(
      `UPDATE users SET ${updates.join(", ")} WHERE id = ?`,
      params,
    );
  }

  return await findUserById(userId);
}

export { publicUser };

