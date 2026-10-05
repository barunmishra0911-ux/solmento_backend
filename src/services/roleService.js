import { pool } from "../config/database.js";
import { HttpError } from "../utils/http.js";

/**
 * List all roles accessible to a given tenant.
 * Includes global system roles (Admin, Head Counsellor, Counsellor) and tenant-specific custom roles.
 */
export async function listRoles(tenantId) {
  const [rows] = await pool.execute(
    `SELECT 
        r.id,
        r.tenant_id AS tenantId,
        r.name,
        r.description,
        r.type,
        r.icon_key AS iconKey,
        r.status,
        r.created_at AS createdAt,
        r.updated_at AS updatedAt,
        COUNT(DISTINCT u.id) AS userCount,
        COUNT(DISTINCT rp.permission_id) AS permissionCount
      FROM roles r
      LEFT JOIN users u ON (u.custom_role_id = r.id OR (r.type = 'SYSTEM' AND u.role = UPPER(REPLACE(r.name, ' ', '_')) AND (u.tenant_id = ? OR u.tenant_id IS NULL))) AND u.deleted_at IS NULL
      LEFT JOIN role_permissions rp ON rp.role_id = r.id
     WHERE (r.tenant_id IS NULL OR r.tenant_id = ?) AND r.deleted_at IS NULL
     GROUP BY r.id
     ORDER BY r.type ASC, r.created_at ASC`,
    [tenantId, tenantId],
  );

  return rows.map((row) => ({
    id: String(row.id),
    tenantId: row.tenantId ? String(row.tenantId) : null,
    name: row.name,
    description: row.description || "",
    type: row.type,
    badge: row.type === "SYSTEM" ? "System" : "Custom",
    iconKey: row.iconKey || "users",
    status: row.status,
    userCount: Number(row.userCount || 0),
    permissionCount: Number(row.permissionCount || 0),
    isSystem: row.type === "SYSTEM",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

/**
 * Get single role details with attached permission keys and permission IDs.
 */
export async function getRoleById(roleId, tenantId) {
  const [roles] = await pool.execute(
    `SELECT id, tenant_id AS tenantId, name, description, type, icon_key AS iconKey, status, created_at AS createdAt, updated_at AS updatedAt
       FROM roles
      WHERE id = ? AND (tenant_id IS NULL OR tenant_id = ?) AND deleted_at IS NULL
      LIMIT 1`,
    [roleId, tenantId],
  );

  if (!roles.length) {
    throw new HttpError(404, "Role not found.");
  }

  const role = roles[0];

  const [permissions] = await pool.execute(
    `SELECT p.id, p.module, p.action, p.permission_key AS permissionKey, p.label
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ?
      ORDER BY p.module ASC, p.id ASC`,
    [roleId],
  );

  return {
    id: String(role.id),
    tenantId: role.tenantId ? String(role.tenantId) : null,
    name: role.name,
    description: role.description || "",
    type: role.type,
    badge: role.type === "SYSTEM" ? "System" : "Custom",
    iconKey: role.iconKey || "users",
    status: role.status,
    isSystem: role.type === "SYSTEM",
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
    permissions: permissions.map((p) => ({
      id: String(p.id),
      module: p.module,
      action: p.action,
      permissionKey: p.permissionKey,
      label: p.label,
    })),
    permissionKeys: permissions.map((p) => p.permissionKey),
    permissionIds: permissions.map((p) => String(p.id)),
  };
}

/**
 * List full catalog of permissions grouped by module.
 */
export async function listPermissions() {
  const [rows] = await pool.execute(
    `SELECT id, module, action, permission_key AS permissionKey, label
       FROM permissions
      ORDER BY id ASC`,
  );

  const modulesMap = new Map();

  for (const row of rows) {
    if (!modulesMap.has(row.module)) {
      modulesMap.set(row.module, {
        id: row.module,
        label: row.module
          .split("_")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" "),
        permissions: [],
      });
    }

    modulesMap.get(row.module).permissions.push({
      id: String(row.id),
      action: row.action,
      permissionKey: row.permissionKey,
      label: row.label,
    });
  }

  return {
    raw: rows.map((r) => ({
      id: String(r.id),
      module: r.module,
      action: r.action,
      permissionKey: r.permissionKey,
      label: r.label,
    })),
    modules: Array.from(modulesMap.values()),
  };
}

/**
 * Create a new custom role with permissions (transaction safe).
 */
export async function createRole({ tenantId, name, description, iconKey = "users", permissionKeys = [], permissionIds = [] }) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const trimmedName = name.trim();
    if (!trimmedName) throw new HttpError(422, "Role name is required.");

    // Check duplicate name for this tenant's custom roles
    const [existing] = await connection.execute(
      "SELECT id FROM roles WHERE tenant_id = ? AND type = 'CUSTOM' AND LOWER(name) = LOWER(?) LIMIT 1",
      [tenantId, trimmedName],
    );

    if (existing.length) {
      throw new HttpError(409, `A custom role named "${trimmedName}" already exists.`);
    }

    // Insert custom role
    const [result] = await connection.execute(
      `INSERT INTO roles (tenant_id, name, description, type, icon_key, status)
       VALUES (?, ?, ?, 'CUSTOM', ?, 'ACTIVE')`,
      [tenantId, trimmedName, description?.trim() || null, iconKey || "users"],
    );

    const roleId = result.insertId;

    // Resolve permission IDs to insert
    const targetPermIds = await resolvePermissionIds(connection, { permissionKeys, permissionIds });

    for (const permId of targetPermIds) {
      await connection.execute(
        "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)",
        [roleId, permId],
      );
    }

    await connection.commit();

    return await getRoleById(roleId, tenantId);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Update custom role details and permissions (transaction safe).
 */
export async function updateRole(roleId, tenantId, { name, description, iconKey, permissionKeys = [], permissionIds = [] }) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // Verify role existence and system protection
    const [existing] = await connection.execute(
      "SELECT id, tenant_id, type, name FROM roles WHERE id = ? AND (tenant_id IS NULL OR tenant_id = ?) LIMIT 1",
      [roleId, tenantId],
    );

    if (!existing.length) {
      throw new HttpError(404, "Role not found.");
    }

    const currentRole = existing[0];

    if (currentRole.type === "SYSTEM") {
      throw new HttpError(403, "System roles cannot be modified.");
    }

    if (Number(currentRole.tenant_id) !== Number(tenantId)) {
      throw new HttpError(403, "You do not have permission to edit roles belonging to another workspace.");
    }

    const trimmedName = name ? name.trim() : currentRole.name;

    if (trimmedName && trimmedName.toLowerCase() !== currentRole.name.toLowerCase()) {
      const [duplicate] = await connection.execute(
        "SELECT id FROM roles WHERE tenant_id = ? AND type = 'CUSTOM' AND LOWER(name) = LOWER(?) AND id != ? LIMIT 1",
        [tenantId, trimmedName, roleId],
      );

      if (duplicate.length) {
        throw new HttpError(409, `A custom role named "${trimmedName}" already exists.`);
      }
    }

    // Update role
    await connection.execute(
      `UPDATE roles
          SET name = ?, description = ?, icon_key = COALESCE(?, icon_key)
        WHERE id = ? AND tenant_id = ?`,
      [trimmedName, description !== undefined ? description.trim() : null, iconKey || null, roleId, tenantId],
    );

    // Update permissions if provided
    if (Array.isArray(permissionKeys) || Array.isArray(permissionIds)) {
      await connection.execute("DELETE FROM role_permissions WHERE role_id = ?", [roleId]);

      const targetPermIds = await resolvePermissionIds(connection, { permissionKeys, permissionIds });

      for (const permId of targetPermIds) {
        await connection.execute(
          "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)",
          [roleId, permId],
        );
      }
    }

    await connection.commit();

    return await getRoleById(roleId, tenantId);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Delete custom role (transaction safe).
 */
export async function deleteRole(roleId, tenantId, actorUserId) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [existing] = await connection.execute(
      "SELECT id, tenant_id, type, name FROM roles WHERE id = ? AND (tenant_id IS NULL OR tenant_id = ?) AND deleted_at IS NULL LIMIT 1",
      [roleId, tenantId],
    );

    if (!existing.length) {
      throw new HttpError(404, "Role not found.");
    }

    const currentRole = existing[0];

    if (currentRole.type === "SYSTEM") {
      throw new HttpError(403, "System roles cannot be deleted.");
    }

    if (Number(currentRole.tenant_id) !== Number(tenantId)) {
      throw new HttpError(403, "You do not have permission to delete roles belonging to another workspace.");
    }

    // Unassign active users using this custom role so permissions are revoked
    await connection.execute("UPDATE users SET custom_role_id = NULL WHERE custom_role_id = ?", [roleId]);

    // Soft delete custom role
    await connection.execute(
      `UPDATE roles
          SET deleted_at = CURRENT_TIMESTAMP,
              deleted_by_user_id = ?
        WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
      [actorUserId || null, roleId, tenantId],
    );

    await connection.commit();

    return { success: true, message: `Role "${currentRole.name}" deleted successfully.` };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function restoreRole(roleId, tenantId) {
  const [existing] = await pool.execute(
    "SELECT id, name FROM roles WHERE id = ? AND tenant_id = ? AND deleted_at IS NOT NULL LIMIT 1",
    [roleId, tenantId],
  );
  if (!existing.length) throw new HttpError(404, "Deleted role not found.");

  await pool.execute(
    `UPDATE roles
        SET deleted_at = NULL,
            deleted_by_user_id = NULL
      WHERE id = ? AND tenant_id = ?`,
    [roleId, tenantId],
  );

  return await getRoleById(roleId, tenantId);
}

/**
 * Update permissions for a specific role.
 */
export async function updateRolePermissions(roleId, tenantId, { permissionKeys = [], permissionIds = [] }) {
  return await updateRole(roleId, tenantId, { permissionKeys, permissionIds });
}

/**
 * Helper to convert array of permission keys or permission IDs to validated numeric permission IDs.
 */
async function resolvePermissionIds(connection, { permissionKeys = [], permissionIds = [] }) {
  const resultSet = new Set();

  if (permissionIds.length > 0) {
    for (const pid of permissionIds) {
      const parsed = Number(pid);
      if (!isNaN(parsed)) resultSet.add(parsed);
    }
  }

  if (permissionKeys.length > 0) {
    const placeholders = permissionKeys.map(() => "?").join(",");
    const [rows] = await connection.execute(
      `SELECT id FROM permissions WHERE permission_key IN (${placeholders})`,
      permissionKeys,
    );

    for (const r of rows) {
      resultSet.add(r.id);
    }
  }

  return Array.from(resultSet);
}
