import { HttpError, ok } from "../utils/http.js";
import { getTenantById, listTenants, updateTenant, getCompanyProfile, upsertCompanyProfile } from "../services/tenantService.js";
import { listAuditLogs, exportAuditLogs } from "../services/auditService.js";
import { z } from "zod";

const updateSchema = z.object({
  companyName: z.string().trim().min(2).max(160).optional(),
  companyDomain: z.string().trim().max(255).optional(),
  adminName: z.string().trim().min(2).max(120).optional(),
  adminEmail: z.string().trim().email().max(254).optional(),
  plan: z.string().trim().min(1).max(120).optional(),
  trialLength: z.enum(["7 days", "14 days", "30 days", "No trial"]).optional(),
  featureFlags: z.record(z.string(), z.boolean()).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
}).strict();

const companyProfileSchema = z.object({
  companyName: z.string().trim().min(1, "Company Name is required."),
  industry: z.string().trim().min(1, "Industry is required."),
  timezone: z.string().trim().min(1, "Timezone is required."),
  logoUrl: z.string().optional().nullable(),
  email: z.string().trim().email("Valid email address is required."),
  phone: z.string().trim().min(1, "Phone number is required."),
  website: z.string().trim().optional().nullable(),
  supportEmail: z.string().trim().email("Valid support email address.").optional().nullable().or(z.literal("")),
  addressLine1: z.string().trim().min(1, "Address Line 1 is required."),
  addressLine2: z.string().trim().optional().nullable(),
  city: z.string().trim().min(1, "City is required."),
  state: z.string().trim().min(1, "State is required."),
  pinCode: z.string().trim().min(1, "PIN Code is required."),
  country: z.string().trim().min(1, "Country is required."),
});

export async function getTenant(req, res, next) { try { return ok(res, { tenant: await getTenantById(req.params.id) }); } catch (error) { return next(error); } }
export async function getTenants(_req, res, next) { try { return ok(res, { tenants: await listTenants() }); } catch (error) { return next(error); } }
export async function patchTenant(req, res, next) {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(422, "Please provide valid admin values.", parsed.error.flatten().fieldErrors);
    return ok(res, { tenant: await updateTenant(req.params.id, parsed.data, req.auth.sub, req.ip) });
  } catch (error) { return next(error); }
}

export async function getAuditLogs(req, res, next) {
  try {
    return ok(res, await listAuditLogs(req.query));
  } catch (error) {
    return next(error);
  }
}

export async function getTenantAuditLogsController(req, res, next) {
  try {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) throw new HttpError(403, "Tenant context required.");
    const result = await listAuditLogs({
      tenantId,
      ...req.query,
    });
    return ok(res, result);
  } catch (error) {
    return next(error);
  }
}

export async function exportAuditLogsController(req, res, next) {
  try {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) throw new HttpError(403, "Tenant context required.");
    const csvContent = await exportAuditLogs({
      tenantId,
      ...req.query,
    });

    const d = new Date();
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    const filename = `solmento-audit-logs-${day}-${month}-${year}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(csvContent);
  } catch (error) {
    return next(error);
  }
}

export async function getCompanyProfileController(req, res, next) {
  try {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) throw new HttpError(403, "Tenant context required.");
    const profile = await getCompanyProfile(tenantId);
    return ok(res, { profile });
  } catch (error) {
    return next(error);
  }
}

export async function putCompanyProfileController(req, res, next) {
  try {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) throw new HttpError(403, "Tenant context required.");
    const parsed = companyProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, "Please provide valid company profile values.", parsed.error.flatten().fieldErrors);
    }
    const profile = await upsertCompanyProfile(
      tenantId,
      parsed.data,
      req.auth.userId,
      req.ip
    );
    return ok(res, { profile, message: "Company profile updated successfully." });
  } catch (error) {
    return next(error);
  }
}

