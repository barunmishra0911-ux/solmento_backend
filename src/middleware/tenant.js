import { HttpError } from "../utils/http.js";

export function requireTenantContext(req, _res, next) {
  if (req.auth?.role === "SUPER_ADMIN") return next(new HttpError(403, "This endpoint is for tenant users only."));
  if (!req.auth?.tenantId) return next(new HttpError(403, "A tenant context is required."));
  return next();
}
