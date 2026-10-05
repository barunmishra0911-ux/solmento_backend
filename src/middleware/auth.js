import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { HttpError } from "../utils/http.js";

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, email: user.email, tenantId: user.tenantId ?? null, realm: "tenant-app" }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
    audience: "tenant-app",
    issuer: "solmento-ai",
  });
}

export function signSuperAdminToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, email: user.email, tenantId: null, realm: "super-admin" }, env.SUPER_ADMIN_JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
    audience: "super-admin",
    issuer: "solmento-ai",
  });
}

export function authenticate(req, _res, next) {
  const token = req.get("authorization")?.replace(/^Bearer\s+/i, "") || req.cookies?.access_token;
  if (!token) return next(new HttpError(401, "Authentication required."));
  try {
    req.auth = jwt.verify(token, env.JWT_SECRET, { audience: "tenant-app", issuer: "solmento-ai" });
    if (req.auth.role === "SUPER_ADMIN" || req.auth.realm !== "tenant-app") throw new Error("Wrong authentication realm");
    req.auth.userId = req.auth.sub;
    return next();
  } catch {
    return next(new HttpError(401, "Invalid or expired authentication token."));
  }
}

export function authenticateSuperAdmin(req, _res, next) {
  const token = req.cookies?.super_admin_access_token || req.get("x-super-admin-token");
  if (!token) return next(new HttpError(401, "Super Admin authentication required."));
  try {
    req.auth = jwt.verify(token, env.SUPER_ADMIN_JWT_SECRET, { audience: "super-admin", issuer: "solmento-ai" });
    if (req.auth.role !== "SUPER_ADMIN" || req.auth.realm !== "super-admin") throw new Error("Wrong authentication realm");
    return next();
  } catch {
    return next(new HttpError(401, "Invalid or expired Super Admin authentication token."));
  }
}
