import { HttpError, ok } from "../utils/http.js";
import {
  createRole,
  deleteRole,
  getRoleById,
  listPermissions,
  listRoles,
  restoreRole,
  updateRole,
  updateRolePermissions,
} from "../services/roleService.js";
import { recordAudit } from "../services/auditService.js";

export async function getRolesController(req, res, next) {
  try {
    const roles = await listRoles(req.auth.tenantId);
    return ok(res, { roles });
  } catch (error) {
    return next(error);
  }
}

export async function getRoleByIdController(req, res, next) {
  try {
    const role = await getRoleById(req.params.id, req.auth.tenantId);
    return ok(res, { role });
  } catch (error) {
    return next(error);
  }
}

export async function getPermissionsCatalogController(_req, res, next) {
  try {
    const catalog = await listPermissions();
    return ok(res, catalog);
  } catch (error) {
    return next(error);
  }
}

export async function getRolePermissionsController(req, res, next) {
  try {
    const role = await getRoleById(req.params.id, req.auth.tenantId);
    return ok(res, {
      roleId: role.id,
      roleName: role.name,
      permissions: role.permissions,
      permissionKeys: role.permissionKeys,
      permissionIds: role.permissionIds,
    });
  } catch (error) {
    return next(error);
  }
}

export async function createRoleController(req, res, next) {
  try {
    const { name, description, iconKey, permissionKeys, permissionIds } = req.body || {};

    if (!name || typeof name !== "string" || !name.trim()) {
      throw new HttpError(422, "Please provide a valid role name.");
    }

    const role = await createRole({
      tenantId: req.auth.tenantId,
      name,
      description,
      iconKey,
      permissionKeys: Array.isArray(permissionKeys) ? permissionKeys : [],
      permissionIds: Array.isArray(permissionIds) ? permissionIds : [],
    });

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: "Created",
      targetType: "Roles & Permissions",
      targetId: role.id,
      metadata: {
        userName: req.auth.email,
        userRole: req.auth.role === "ADMIN" ? "Admin" : "Counsellor",
        module: "Roles & Permissions",
        page: "Edit Role",
        details: `Created custom role "${role.name}"`,
        summaryTitle: "Role Created",
        summarySubtitle: "Custom role was created",
      },
      ipAddress: req.ip,
    });

    return ok(res, { role }, 201);
  } catch (error) {
    return next(error);
  }
}

export async function updateRoleController(req, res, next) {
  try {
    const { name, description, iconKey, permissionKeys, permissionIds } = req.body || {};

    const role = await updateRole(req.params.id, req.auth.tenantId, {
      name,
      description,
      iconKey,
      permissionKeys: Array.isArray(permissionKeys) ? permissionKeys : [],
      permissionIds: Array.isArray(permissionIds) ? permissionIds : [],
    });

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: "Updated",
      targetType: "Roles & Permissions",
      targetId: role.id,
      metadata: {
        userName: req.auth.email,
        userRole: req.auth.role === "ADMIN" ? "Admin" : "Counsellor",
        module: "Roles & Permissions",
        page: "Edit Role",
        details: `Updated role "${role.name}" details`,
        summaryTitle: "Role Updated",
        summarySubtitle: "Custom role configuration was modified",
      },
      ipAddress: req.ip,
    });

    return ok(res, { role });
  } catch (error) {
    return next(error);
  }
}

export async function updateRolePermissionsController(req, res, next) {
  try {
    const { permissionKeys, permissionIds } = req.body || {};

    const role = await updateRolePermissions(req.params.id, req.auth.tenantId, {
      permissionKeys: Array.isArray(permissionKeys) ? permissionKeys : [],
      permissionIds: Array.isArray(permissionIds) ? permissionIds : [],
    });

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: "Updated",
      targetType: "Roles & Permissions",
      targetId: role.id,
      metadata: {
        userName: req.auth.email,
        userRole: req.auth.role === "ADMIN" ? "Admin" : "Counsellor",
        module: "Roles & Permissions",
        page: "Edit Role",
        details: `Updated role "${role.name}" permissions`,
        summaryTitle: "Role Permissions Updated",
        summarySubtitle: "Custom role access controls were modified",
      },
      ipAddress: req.ip,
    });

    return ok(res, { role });
  } catch (error) {
    return next(error);
  }
}

export async function deleteRoleController(req, res, next) {
  try {
    const result = await deleteRole(req.params.id, req.auth.tenantId, req.auth.userId);

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: "Deleted",
      targetType: "Roles & Permissions",
      targetId: req.params.id,
      metadata: {
        userName: req.auth.email,
        userRole: req.auth.role === "ADMIN" ? "Admin" : "Counsellor",
        module: "Roles & Permissions",
        page: "Roles & Permissions",
        details: `Deleted custom role (ID: ${req.params.id})`,
        summaryTitle: "Role Deleted",
        summarySubtitle: "Custom role was removed",
      },
      ipAddress: req.ip,
    });

    return ok(res, result);
  } catch (error) {
    return next(error);
  }
}

export async function restoreRoleController(req, res, next) {
  try {
    const role = await restoreRole(req.params.id, req.auth.tenantId);

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: "Restored",
      targetType: "Roles & Permissions",
      targetId: req.params.id,
      metadata: {
        userName: req.auth.email,
        userRole: req.auth.role === "ADMIN" ? "Admin" : "Counsellor",
        module: "Roles & Permissions",
        page: "Roles & Permissions",
        details: `Restored custom role "${role.name}" (ID: ${req.params.id})`,
        summaryTitle: "Role Restored",
        summarySubtitle: "Custom role was restored",
      },
      ipAddress: req.ip,
    });

    return ok(res, { role });
  } catch (error) {
    return next(error);
  }
}
