import { HttpError, ok } from "../utils/http.js";
import {
  createCounsellorSchema,
  updateCounsellorSchema,
} from "../validators/auth.js";
import {
  createCounsellor,
  deleteCounsellor,
  listCounsellors,
  restoreCounsellor,
  updateCounsellor,
} from "../services/counsellorService.js";
import { recordAudit } from "../services/auditService.js";
import { notifyAdminsOfTenant } from "../services/notificationService.js";

export async function getCounsellors(req, res, next) {
  try {
    return ok(res, { counsellors: await listCounsellors(req.auth.tenantId) });
  } catch (error) {
    return next(error);
  }
}

export async function postCounsellor(req, res, next) {
  try {
    const parsed = createCounsellorSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(
        422,
        "Please provide valid counsellor details.",
        parsed.error.flatten().fieldErrors,
      );
    }
    if (
      parsed.data.profilePhoto &&
      !/^data:image\/(jpeg|png|webp|gif);base64,/i.test(
        parsed.data.profilePhoto,
      )
    ) {
      throw new HttpError(
        422,
        "Profile photo must be a valid JPG, PNG, WEBP or GIF image.",
      );
    }
    const counsellor = await createCounsellor({
      ...parsed.data,
      adminUserId: req.auth.sub,
      tenantId: req.auth.tenantId,
    });

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: "Created",
      targetType: "Counsellor",
      targetId: counsellor.id,
      metadata: {
        userName: req.auth.email,
        userRole: req.auth.role === "ADMIN" ? "Admin" : "Counsellor",
        module: "Counsellor",
        page: "Create Counsellor",
        details: `Added new counsellor profile (${counsellor.name || counsellor.email})`,
        summaryTitle: "Counsellor Created",
        summarySubtitle: "New counsellor user account created",
      },
      ipAddress: req.ip,
    });

    notifyAdminsOfTenant({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      type: "COUNSELLOR_CREATED",
      title: "New Counsellor Added",
      message: `New counsellor account (${counsellor.name || counsellor.email}) was created.`,
      module: "Counsellors",
      entityType: "counsellor",
      entityId: counsellor.id,
      priority: "INFO",
    }).catch(() => { });

    return ok(res, { counsellor }, 201);
  } catch (error) {
    return next(error);
  }
}

export async function patchCounsellor(req, res, next) {
  try {
    const parsed = updateCounsellorSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(
        422,
        "Please provide valid counsellor details.",
        parsed.error.flatten().fieldErrors,
      );
    }
    if (
      parsed.data.profilePhoto &&
      !/^data:image\/(jpeg|png|webp|gif);base64,/i.test(
        parsed.data.profilePhoto,
      )
    ) {
      throw new HttpError(
        422,
        "Profile photo must be a valid JPG, PNG, WEBP or GIF image.",
      );
    }
    const counsellor = await updateCounsellor({
      ...parsed.data,
      id: req.params.id,
      tenantId: req.auth.tenantId,
    });

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: "Updated",
      targetType: "Counsellor",
      targetId: req.params.id,
      metadata: {
        userName: req.auth.email,
        userRole: req.auth.role === "ADMIN" ? "Admin" : "Counsellor",
        module: "Counsellor",
        page: "Edit Counsellor",
        details: `Updated counsellor details (ID: CNS-${req.params.id})`,
        summaryTitle: "Counsellor Updated",
        summarySubtitle: "Counsellor information was updated",
      },
      ipAddress: req.ip,
    });

    return ok(res, { counsellor });
  } catch (error) {
    return next(error);
  }
}

export async function destroyCounsellor(req, res, next) {
  try {
    const counsellor = await deleteCounsellor({
      id: req.params.id,
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
    });

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: "Deleted",
      targetType: "Counsellor",
      targetId: req.params.id,
      metadata: {
        userName: req.auth.email,
        userRole: req.auth.role === "ADMIN" ? "Admin" : "Counsellor",
        module: "Counsellor",
        page: "Counsellor List",
        details: `Deleted counsellor profile (ID: CNS-${req.params.id})`,
        summaryTitle: "Counsellor Deleted",
        summarySubtitle: "Counsellor profile was removed",
      },
      ipAddress: req.ip,
    });

    return ok(res, { counsellor });
  } catch (error) {
    return next(error);
  }
}

export async function restoreCounsellorController(req, res, next) {
  try {
    const counsellor = await restoreCounsellor({
      id: req.params.id,
      tenantId: req.auth.tenantId,
    });

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: "Restored",
      targetType: "Counsellor",
      targetId: req.params.id,
      metadata: {
        userName: req.auth.email,
        userRole: req.auth.role === "ADMIN" ? "Admin" : "Counsellor",
        module: "Counsellor",
        page: "Counsellor List",
        details: `Restored counsellor profile (ID: CNS-${req.params.id})`,
        summaryTitle: "Counsellor Restored",
        summarySubtitle: "Counsellor profile was restored",
      },
      ipAddress: req.ip,
    });

    notifyAdminsOfTenant({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      type: "COUNSELLOR_RESTORED",
      title: "Counsellor Restored",
      message: `Counsellor account (${counsellor.name || counsellor.email}) was restored.`,
      module: "Counsellors",
      entityType: "counsellor",
      entityId: counsellor.id,
      priority: "INFO",
    }).catch(() => { });

    return ok(res, { counsellor });
  } catch (error) {
    return next(error);
  }
}
