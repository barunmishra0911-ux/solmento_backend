import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { requireTenantContext } from "../middleware/tenant.js";
import {
  destroyCampaign,
  getCampaignById,
  getCampaigns,
  postCampaign,
  putCampaign,
  restoreCampaignController,
} from "../controllers/campaignController.js";

const router = Router();

// Apply authentication & tenant scoping to all campaign endpoints
router.use(authenticate, requireTenantContext);

router.get("/", getCampaigns);
router.post("/", postCampaign);
router.get("/:id", getCampaignById);
router.put("/:id", putCampaign);
router.delete("/:id", destroyCampaign);
router.post("/:id/restore", restoreCampaignController);

export default router;
