import { HttpError, ok } from "../utils/http.js";
import { createCampaignSchema, updateCampaignSchema } from "../validators/campaignValidator.js";
import {
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  restoreCampaign,
  updateCampaign,
} from "../services/campaignService.js";
import { recordAudit } from "../services/auditService.js";

export async function getCampaigns(req, res, next) {
  try {
    const tenantId = req.auth.tenantId;
    const status = req.query.status || null;
    const campaigns = await listCampaigns({ tenantId, status });
    return ok(res, { campaigns });
  } catch (error) {
    return next(error);
  }
}

export async function getCampaignById(req, res, next) {
  try {
    const tenantId = req.auth.tenantId;
    const id = req.params.id;
    const campaign = await getCampaign(id, tenantId);
    return ok(res, { campaign });
  } catch (error) {
    return next(error);
  }
}

export async function postCampaign(req, res, next) {
  try {
    const parsed = createCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, "Please provide valid campaign details.", parsed.error.flatten().fieldErrors);
    }

    const tenantId = req.auth.tenantId;
    const createdByUserId = req.auth.userId;

    const campaign = await createCampaign({
      tenantId,
      createdByUserId,
      ...parsed.data,
    });

    return ok(res, { campaign }, 201);
  } catch (error) {
    return next(error);
  }
}

export async function putCampaign(req, res, next) {
  try {
    const parsed = updateCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, "Please provide valid campaign details.", parsed.error.flatten().fieldErrors);
    }

    const tenantId = req.auth.tenantId;
    const id = req.params.id;

    const campaign = await updateCampaign(id, tenantId, parsed.data);
    return ok(res, { campaign });
  } catch (error) {
    return next(error);
  }
}

export async function destroyCampaign(req, res, next) {
  try {
    const tenantId = req.auth.tenantId;
    const id = req.params.id;

    await deleteCampaign(id, tenantId, req.auth.userId);

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: "Deleted",
      targetType: "Campaign",
      targetId: id,
      metadata: {
        userName: req.auth.email,
        userRole: req.auth.role === "ADMIN" ? "Admin" : "Counsellor",
        module: "Campaigns",
        page: "Campaigns",
        details: `Deleted campaign (ID: ${id})`,
        summaryTitle: "Campaign Deleted",
        summarySubtitle: "Campaign was removed",
      },
      ipAddress: req.ip,
    });

    return ok(res, { message: "Campaign deleted successfully" });
  } catch (error) {
    return next(error);
  }
}

export async function restoreCampaignController(req, res, next) {
  try {
    const tenantId = req.auth.tenantId;
    const id = req.params.id;

    const campaign = await restoreCampaign(id, tenantId);

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: "Restored",
      targetType: "Campaign",
      targetId: id,
      metadata: {
        userName: req.auth.email,
        userRole: req.auth.role === "ADMIN" ? "Admin" : "Counsellor",
        module: "Campaigns",
        page: "Campaigns",
        details: `Restored campaign "${campaign.name || id}" (ID: ${id})`,
        summaryTitle: "Campaign Restored",
        summarySubtitle: "Campaign was restored",
      },
      ipAddress: req.ip,
    });

    return ok(res, { campaign });
  } catch (error) {
    return next(error);
  }
}
