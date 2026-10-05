import { HttpError, ok } from "../utils/http.js";
import {
  getWhatsAppConfig,
  saveWhatsAppConfig,
  disconnectWhatsApp,
  getWhatsAppLeads,
  sendWhatsAppMessage,
  getWhatsAppBroadcasts,
  handleWhatsAppWebhook,
} from "../services/whatsappService.js";
import { pool } from "../config/database.js";
import { notifyAdminsOfTenant } from "../services/notificationService.js";

export async function getWhatsAppConfigController(req, res, next) {
  try {
    const config = await getWhatsAppConfig(req.auth.tenantId);
    return ok(res, config);
  } catch (error) {
    return next(error);
  }
}

export async function saveWhatsAppConfigController(req, res, next) {
  try {
    const config = await saveWhatsAppConfig(req.auth.tenantId, req.body);
    return ok(res, config);
  } catch (error) {
    return next(error);
  }
}

export async function disconnectWhatsAppController(req, res, next) {
  try {
    const result = await disconnectWhatsApp(req.auth.tenantId);
    notifyAdminsOfTenant({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      type: "WHATSAPP_DISCONNECTED",
      title: "WhatsApp Disconnected",
      message: "WhatsApp API connection was disconnected. Incoming messages may be delayed.",
      module: "WhatsApp",
      priority: "URGENT",
    }).catch(() => {});
    return ok(res, result);
  } catch (error) {
    return next(error);
  }
}

export async function getWhatsAppLeadsController(req, res, next) {
  try {
    const leads = await getWhatsAppLeads(req.auth.tenantId);
    return ok(res, leads);
  } catch (error) {
    return next(error);
  }
}

export async function sendWhatsAppMessageController(req, res, next) {
  try {
    const userId = req.auth.userId || req.auth.sub;
    const result = await sendWhatsAppMessage(req.auth.tenantId, userId, req.body);
    return ok(res, result);
  } catch (error) {
    return next(error);
  }
}

export async function getWhatsAppBroadcastsController(req, res, next) {
  try {
    const broadcasts = await getWhatsAppBroadcasts(
      req.auth.tenantId,
      req.query.limit,
    );
    return ok(res, broadcasts);
  } catch (error) {
    return next(error);
  }
}

export async function verifyWebhookController(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token) {
    // Check if token matches any tenant's webhook_verify_token or default token
    const [rows] = await pool.execute(
      "SELECT id FROM whatsapp_configs WHERE webhook_verify_token = ? LIMIT 1",
      [token],
    );

    if (rows.length > 0 || token === "solmento_whatsapp_verify_token") {
      return res.status(200).send(challenge);
    }
  }

  return res.status(403).send("Verification failed");
}

export async function postWebhookController(req, res, next) {
  try {
    console.log("[WA DEBUG] WEBHOOK_RECEIVED", {
      timestamp: new Date().toISOString(),
      entriesCount: req.body?.entry?.length || 0,
      object: req.body?.object,
    });

    // Immediately acknowledge Meta with 200 OK to prevent webhook retry timeouts
    res.status(200).json({ success: true });

    // Process delivery status receipts and incoming user messages
    handleWhatsAppWebhook(req.body).catch((err) => {
      console.error("[WhatsApp Webhook Async Error]:", err);
    });
  } catch (error) {
    console.error("[WhatsApp Webhook Controller Error]:", error);
    if (!res.headersSent) {
      return res.status(200).json({ success: true });
    }
  }
}
