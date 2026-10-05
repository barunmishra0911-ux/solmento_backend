import { pool } from "../config/database.js";
import { HttpError } from "../utils/http.js";

export const ROLES = Object.freeze({
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN",
  HEAD_COUNSELLOR: "HEAD_COUNSELLOR",
  COUNSELLOR: "COUNSELLOR",
});

/**
 * Fetch all effective permission keys for a given user.
 */
export async function getUserPermissions(userIdOrUser) {
  if (!userIdOrUser) return [];

  let user;
  if (typeof userIdOrUser === "object" && userIdOrUser !== null) {
    user = userIdOrUser;
  } else {
    const [users] = await pool.execute(
      "SELECT id, tenant_id, role, custom_role_id, designation, status FROM users WHERE id = ? LIMIT 1",
      [userIdOrUser],
    );

    if (!users.length || users[0].status !== "ACTIVE") return [];
    user = users[0];
  }

  // Super Admin and Tenant Admin have full access
  if (user.role === "SUPER_ADMIN" || user.role === "ADMIN") {
    const [allPerms] = await pool.execute("SELECT permission_key FROM permissions");
    return allPerms.map((p) => p.permission_key);
  }

  // If user has an explicit custom role assigned
  if (user.custom_role_id) {
    const [perms] = await pool.execute(
      `SELECT p.permission_key
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = ?`,
      [user.custom_role_id],
    );
    return perms.map((p) => p.permission_key);
  }

  // If tenant has a custom role matching designation or role name
  const roleNameSearch = user.designation || (user.role === "HEAD_COUNSELLOR" ? "Head Counsellor" : "Counsellor");
  if (user.tenant_id) {
    const [tenantRoles] = await pool.execute(
      `SELECT id FROM roles WHERE tenant_id = ? AND LOWER(name) = LOWER(?) LIMIT 1`,
      [user.tenant_id, roleNameSearch]
    );
    if (tenantRoles.length > 0) {
      const tenantRoleId = tenantRoles[0].id;
      const [perms] = await pool.execute(
        `SELECT p.permission_key
           FROM role_permissions rp
           JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = ?`,
        [tenantRoleId],
      );
      return perms.map((p) => p.permission_key);
    }
  }

  // Fallback to global system role template
  const systemRoleName =
    user.role === "HEAD_COUNSELLOR"
      ? "Head Counsellor"
      : user.role === "COUNSELLOR"
      ? "Counsellor"
      : null;

  if (systemRoleName) {
    const [perms] = await pool.execute(
      `SELECT p.permission_key
         FROM roles r
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.tenant_id IS NULL AND r.name = ? AND r.type = 'SYSTEM'`,
      [systemRoleName],
    );
    return perms.map((p) => p.permission_key);
  }

  return [];
}

/**
 * Role-based authorization middleware (legacy compatibility).
 */
export function authorize(...allowedRoles) {
  return (req, _res, next) => {
    if (!req.auth || !allowedRoles.includes(req.auth.role)) {
      return next(new HttpError(403, "You do not have permission to access this resource."));
    }
    return next();
  };
}

/**
 * Dynamic permission enforcement middleware.
 * Verifies that the authenticated user possesses at least one of the required permission keys.
 * ADMIN and SUPER_ADMIN roles automatically bypass permission checks.
 */
export function requirePermission(...requiredPermissions) {
  return async (req, _res, next) => {
    if (!req.auth) {
      return next(new HttpError(401, "Authentication required."));
    }

    // Admins have unrestricted access
    if (req.auth.role === "SUPER_ADMIN" || req.auth.role === "ADMIN") {
      return next();
    }

    try {
      const userPermissions = await getUserPermissions(req.auth.userId || req.auth.sub);
      req.auth.permissions = userPermissions;

      const hasPermission = requiredPermissions.some((perm) =>
        userPermissions.includes(perm),
      );

      if (!hasPermission) {
        return next(
          new HttpError(
            403,
            `Access denied. Required permission: ${requiredPermissions.join(" or ")}`,
          ),
        );
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}
