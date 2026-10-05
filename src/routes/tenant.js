import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { requireTenantContext } from "../middleware/tenant.js";
import { ok } from "../utils/http.js";

const router = Router();

router.get("/context", authenticate, requireTenantContext, (req, res) => ok(res, { tenantId: req.auth.tenantId }));

export default router;
