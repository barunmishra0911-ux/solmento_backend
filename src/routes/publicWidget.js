import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  getPublicWidgetConfigById,
  getPublicWidgetCallStatusById,
  postPublicWidgetCall,
  postPublicWidgetLead,
  postPublicWidgetMessage,
} from "../controllers/publicWidgetController.js";
import {
  verifyWebhookController,
  postWebhookController,
} from "../controllers/whatsappController.js";

const router = Router();
const messageRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many messages. Please try again shortly." },
});
const leadRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many lead submissions. Please try again shortly." },
});
const callRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many call requests. Please try again shortly." },
});

router.get("/widget/:publicId/config", getPublicWidgetConfigById);
router.post("/widget/:publicId/lead", leadRateLimit, postPublicWidgetLead);
router.post("/widget/:publicId/message", messageRateLimit, postPublicWidgetMessage);
router.post("/widget/:publicId/call", callRateLimit, postPublicWidgetCall);
router.get("/widget/:publicId/call/:callId/status", getPublicWidgetCallStatusById);

// WhatsApp Cloud API Webhook
router.get("/whatsapp/webhook", verifyWebhookController);
router.post("/whatsapp/webhook", postWebhookController);
router.get("/webhook", verifyWebhookController);
router.post("/webhook", postWebhookController);

export default router;

