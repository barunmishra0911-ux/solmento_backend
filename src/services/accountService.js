import bcrypt from "bcrypt";
import { pool } from "../config/database.js";
import { HttpError } from "../utils/http.js";
import { publicUser } from "./authService.js";

async function ensureEmailAvailable(connection, email) {
  const [rows] = await connection.execute(
    "SELECT id FROM users WHERE email = ? LIMIT 1",
    [email.toLowerCase()],
  );
  if (rows.length) throw new HttpError(409, "An account with this email already exists.");
}

export async function createAdmin({ name, email, password, companyName, createdByUserId }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const normalizedEmail = email.toLowerCase();
    await ensureEmailAvailable(connection, normalizedEmail);
    const slugBase =
      companyName
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 160) || "workspace";
    let slug = slugBase;
    for (let suffix = 2; ; suffix += 1) {
      const [existing] = await connection.execute(
        "SELECT id FROM tenants WHERE slug = ? LIMIT 1",
        [slug],
      );
      if (!existing.length) break;
      slug = `${slugBase.slice(0, 155)}-${suffix}`;
    }
    const [tenantResult] = await connection.execute(
      "INSERT INTO tenants (name, company_name, slug, status) VALUES (?, ?, ?, 'ACTIVE')",
      [companyName.trim(), companyName.trim(), slug],
    );
    const passwordHash = await bcrypt.hash(password, 12);
    const [userResult] = await connection.execute(
      "INSERT INTO users (tenant_id, created_by_user_id, name, email, password_hash, role, status, email_verified_at) VALUES (?, ?, ?, ?, ?, 'ADMIN', 'ACTIVE', UTC_TIMESTAMP())",
      [tenantResult.insertId, createdByUserId, name.trim(), normalizedEmail, passwordHash],
    );
    await connection.commit();
    return await publicUser({
      id: userResult.insertId,
      tenant_id: tenantResult.insertId,
      name: name.trim(),
      email: normalizedEmail,
      role: "ADMIN",
      status: "ACTIVE",
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function createTeamMember({
  name,
  email,
  password,
  role,
  roleId,
  adminUserId,
  tenantId,
}) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const normalizedEmail = email.toLowerCase();
    await ensureEmailAvailable(connection, normalizedEmail);

    const [admins] = await connection.execute(
      "SELECT id, tenant_id FROM users WHERE id = ? AND role = 'ADMIN' AND status = 'ACTIVE' LIMIT 1",
      [adminUserId],
    );
    if (!admins.length || Number(admins[0].tenant_id) !== Number(tenantId)) {
      throw new HttpError(403, "The admin account is not linked to this workspace.");
    }

    let systemRole = "COUNSELLOR";
    let customRoleId = null;
    let resolvedRoleName = role || "Counsellor";

    // If roleId provided, verify it exists and belongs to tenant
    if (roleId) {
      const [roles] = await connection.execute(
        "SELECT id, name, type FROM roles WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL) LIMIT 1",
        [roleId, tenantId],
      );

      if (!roles.length) {
        throw new HttpError(404, "Selected role not found.");
      }

      const roleRecord = roles[0];
      resolvedRoleName = roleRecord.name;
      customRoleId = roleRecord.id;

      if (roleRecord.type === "SYSTEM") {
        if (roleRecord.name.toLowerCase().includes("head")) {
          systemRole = "HEAD_COUNSELLOR";
        } else if (roleRecord.name.toLowerCase().includes("admin")) {
          systemRole = "ADMIN";
        } else {
          systemRole = "COUNSELLOR";
        }
      } else {
        systemRole = "COUNSELLOR";
      }
    } else if (role) {
      const normalizedRole = role.trim();
      if (
        normalizedRole === "HEAD_COUNSELLOR" ||
        normalizedRole === "Head Counsellor" ||
        normalizedRole === "Head Consultant"
      ) {
        systemRole = "HEAD_COUNSELLOR";
        resolvedRoleName = "Head Counsellor";
      } else if (normalizedRole === "ADMIN" || normalizedRole === "Admin") {
        systemRole = "ADMIN";
        resolvedRoleName = "Admin";
      } else if (
        normalizedRole === "COUNSELLOR" ||
        normalizedRole === "Counsellor" ||
        normalizedRole === "Consultant"
      ) {
        systemRole = "COUNSELLOR";
        resolvedRoleName = "Counsellor";
      } else {
        // Try finding custom role by name (prioritizing tenant custom role)
        const [roles] = await connection.execute(
          "SELECT id, name, type FROM roles WHERE (tenant_id = ? OR tenant_id IS NULL) AND LOWER(name) = LOWER(?) ORDER BY (tenant_id IS NOT NULL) DESC, id DESC LIMIT 1",
          [tenantId, normalizedRole],
        );
        if (roles.length) {
          customRoleId = roles[0].id;
          resolvedRoleName = roles[0].name;
          systemRole = roles[0].type === "SYSTEM" ? (roles[0].name.toLowerCase().includes("head") ? "HEAD_COUNSELLOR" : "COUNSELLOR") : "COUNSELLOR";
        }
      }

      if (!customRoleId) {
        // Link system role template id
        const [sysRole] = await connection.execute(
          "SELECT id FROM roles WHERE tenant_id IS NULL AND name = ? AND type = 'SYSTEM' LIMIT 1",
          [resolvedRoleName],
        );
        if (sysRole.length) customRoleId = sysRole[0].id;
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const [userResult] = await connection.execute(
      "INSERT INTO users (tenant_id, created_by_user_id, name, email, password_hash, role, custom_role_id, status, email_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', UTC_TIMESTAMP())",
      [tenantId, adminUserId, name.trim(), normalizedEmail, passwordHash, systemRole, customRoleId],
    );

    const newUserId = userResult.insertId;

    if (customRoleId) {
      await connection.execute(
        "INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)",
        [newUserId, customRoleId],
      );
    }

    await connection.commit();
    return await publicUser({
      id: newUserId,
      tenant_id: tenantId,
      name: name.trim(),
      email: normalizedEmail,
      role: systemRole,
      role_name: resolvedRoleName,
      custom_role_id: customRoleId,
      status: "ACTIVE",
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function listTeamMembers(adminUserId, tenantId) {
  const [rows] = await pool.execute(
    `SELECT u.id, u.name, u.email, u.role, u.custom_role_id AS customRoleId,
            COALESCE(r.name, CASE u.role WHEN 'HEAD_COUNSELLOR' THEN 'Head Counsellor' WHEN 'COUNSELLOR' THEN 'Counsellor' ELSE u.role END) AS roleName,
            r.type AS roleType,
            r.icon_key AS iconKey,
            u.status,
            u.created_at AS createdAt
       FROM users u
       LEFT JOIN roles r ON r.id = u.custom_role_id
      WHERE u.role IN ('HEAD_COUNSELLOR','COUNSELLOR') AND u.tenant_id = ? AND u.created_by_user_id = ?
      ORDER BY u.created_at DESC`,
    [tenantId, adminUserId],
  );
  return rows;
}

export async function listAdmins() {
  const [rows] = await pool.execute(
    "SELECT u.id, u.name, u.email, u.role, u.status, u.tenant_id AS tenantId, COALESCE(t.company_name, t.name) AS companyName, u.created_at AS createdAt FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.role = 'ADMIN' ORDER BY u.created_at DESC",
  );
  return rows;
}
