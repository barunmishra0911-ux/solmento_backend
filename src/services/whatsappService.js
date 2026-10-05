import { randomUUID } from "node:crypto";
import { pool } from "../config/database.js";
import { HttpError } from "../utils/http.js";
import { generateMockResponse } from "./mockResponseProvider.js";
import { notifyAdminsOfTenant } from "./notificationService.js";

const processedInboundIds = new Set();
function isDuplicateInbound(msgId) {
  return Boolean(msgId && processedInboundIds.has(msgId));
}
function markInboundProcessed(msgId) {
  if (!msgId) return;
  processedInboundIds.add(msgId);
  if (processedInboundIds.size > 2000) {
    const firstItem = processedInboundIds.values().next().value;
    processedInboundIds.delete(firstItem);
  }
}

const META_GRAPH_VERSION = "v21.0";
const META_GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

function parseJsonSafe(val, fallback = {}) {
  if (val === null || val === undefined) return fallback;
  if (typeof val !== "string") return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

function cleanPhoneNumber(rawPhone) {
  if (!rawPhone) return "";
  let digits = String(rawPhone).replace(/\D/g, "");
  if (digits.startsWith("0")) {
    digits = digits.replace(/^0+/, "");
  }
  if (digits.startsWith("910") && digits.length === 13) {
    digits = `91${digits.slice(3)}`;
  }
  // If Indian 10-digit number without country code, prepend 91
  if (digits.length === 10) {
    digits = `91${digits}`;
  }
  return digits;
}

export async function getWhatsAppConfig(tenantId) {
  const [rows] = await pool.execute(
    `SELECT id, tenant_id, business_name, phone_number, phone_number_id, waba_id,
            access_token, webhook_verify_token, status, created_at, updated_at
       FROM whatsapp_configs
      WHERE tenant_id = ?
      LIMIT 1`,
    [tenantId],
  );

  const config = rows[0];
  if (!config) {
    return {
      connected: false,
      status: "DISCONNECTED",
      businessName: "",
      phoneNumber: "",
      phoneNumberId: "",
      wabaId: "",
      maskedToken: "",
      webhookVerifyToken: "",
    };
  }

  const rawToken = config.access_token || "";
  const maskedToken =
    rawToken.length > 8
      ? `${"•".repeat(Math.min(rawToken.length - 4, 20))}${rawToken.slice(-4)}`
      : "";

  return {
    connected: config.status === "CONNECTED",
    status: config.status,
    businessName: config.business_name || "",
    phoneNumber: config.phone_number || "",
    phoneNumberId: config.phone_number_id || "",
    wabaId: config.waba_id || "",
    maskedToken,
    hasToken: Boolean(rawToken),
    webhookVerifyToken: config.webhook_verify_token || "",
    updatedAt: config.updated_at,
  };
}

export async function saveWhatsAppConfig(tenantId, payload) {
  const businessName = String(payload.businessName || "").trim();
  const phoneNumber = String(payload.phoneNumber || "").trim();
  const phoneNumberId = String(payload.phoneNumberId || "").trim();
  const wabaId = String(payload.wabaId || "").trim();
  let accessToken = String(payload.accessToken || "").trim();
  const webhookVerifyToken = String(payload.webhookVerifyToken || "").trim();

  if (!businessName) {
    throw new HttpError(422, "Business Name is required.");
  }
  if (!phoneNumber) {
    throw new HttpError(422, "Phone number is required.");
  }
  if (!phoneNumberId) {
    throw new HttpError(422, "Phone Number ID is required.");
  }

  // If accessToken not provided, check if existing token is stored
  if (!accessToken) {
    const [existing] = await pool.execute(
      "SELECT access_token FROM whatsapp_configs WHERE tenant_id = ? LIMIT 1",
      [tenantId],
    );
    if (existing[0]?.access_token) {
      accessToken = existing[0].access_token;
    } else {
      throw new HttpError(422, "Meta Permanent Access Token is required.");
    }
  }

  // Verify credentials directly with Meta Graph API
  let verifiedInfo = null;
  try {
    const metaCheckUrl = `${META_GRAPH_BASE}/${encodeURIComponent(phoneNumberId)}?fields=verified_name,display_phone_number,quality_rating,code_verification_status`;
    const response = await fetch(metaCheckUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      const errorMsg =
        data?.error?.message ||
        `Meta API returned status ${response.status}: Verification failed.`;
      throw new HttpError(
        400,
        `Meta WhatsApp Cloud API verification failed: ${errorMsg}`,
      );
    }
    verifiedInfo = data;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      400,
      `Failed to verify credentials with Meta Cloud API: ${err.message}`,
    );
  }

  const finalBusinessName =
    verifiedInfo?.verified_name || businessName;
  const finalPhoneNumber =
    verifiedInfo?.display_phone_number || phoneNumber;

  await pool.execute(
    `INSERT INTO whatsapp_configs
       (tenant_id, business_name, phone_number, phone_number_id, waba_id, access_token, webhook_verify_token, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'CONNECTED')
     ON DUPLICATE KEY UPDATE
       business_name = VALUES(business_name),
       phone_number = VALUES(phone_number),
       phone_number_id = VALUES(phone_number_id),
       waba_id = VALUES(waba_id),
       access_token = VALUES(access_token),
       webhook_verify_token = VALUES(webhook_verify_token),
       status = 'CONNECTED',
       updated_at = CURRENT_TIMESTAMP`,
    [
      tenantId,
      finalBusinessName,
      finalPhoneNumber,
      phoneNumberId,
      wabaId || null,
      accessToken,
      webhookVerifyToken || null,
    ],
  );

  return getWhatsAppConfig(tenantId);
}

export async function disconnectWhatsApp(tenantId) {
  await pool.execute(
    "UPDATE whatsapp_configs SET status = 'DISCONNECTED', updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?",
    [tenantId],
  );
  return { success: true, message: "WhatsApp disconnected successfully." };
}

export async function getWhatsAppLeads(tenantId) {
  const [rows] = await pool.execute(
    `SELECT id, public_id, tenant_id, source, fields_json, status, created_at
       FROM leads
      WHERE tenant_id = ? AND deleted_at IS NULL
      ORDER BY id DESC`,
    [tenantId],
  );

  const leads = [];
  for (const row of rows) {
    const fields = parseJsonSafe(row.fields_json, {});
    const rawPhone =
      fields.phone || fields.phoneNumber || fields.mobile || "";
    const cleanPhone = cleanPhoneNumber(rawPhone);

    const name =
      fields.name ||
      fields.fullName ||
      fields.student_name ||
      "Student Lead";
    const email = fields.email || fields.emailAddress || "";
    const courses =
      fields.coursesInterested ||
      fields.courses_interested ||
      fields.course ||
      [];

    leads.push({
      id: row.id,
      publicId: row.public_id,
      name,
      phone: rawPhone,
      cleanPhone,
      email,
      courses: Array.isArray(courses) ? courses : [courses].filter(Boolean),
      status: row.status,
      hasValidPhone: cleanPhone.length >= 10,
      createdAt: row.created_at,
    });
  }

  return leads;
}

export async function sendWhatsAppMessage(tenantId, userId, payload) {
  const messageText = String(payload.messageText || "").trim();
  const recipientMode = payload.recipientMode === "ALL" ? "ALL" : "SELECTED";
  const selectedLeadIds = Array.isArray(payload.leadIds)
    ? payload.leadIds.map(Number).filter(Boolean)
    : [];

  if (!messageText) {
    throw new HttpError(422, "Message text is required.");
  }

  // 1. Get active WhatsApp credentials
  const [cfgRows] = await pool.execute(
    `SELECT id, phone_number_id, access_token, status, business_name, phone_number
       FROM whatsapp_configs
      WHERE tenant_id = ? AND status = 'CONNECTED'
      LIMIT 1`,
    [tenantId],
  );

  const config = cfgRows[0];
  if (!config || !config.phone_number_id || !config.access_token) {
    throw new HttpError(
      400,
      "WhatsApp Business Account is not connected. Please connect with your Meta credentials first.",
    );
  }

  // 2. Fetch leads to send to
  const allLeads = await getWhatsAppLeads(tenantId);
  let targetLeads = [];

  if (recipientMode === "ALL") {
    targetLeads = allLeads.filter((lead) => lead.hasValidPhone);
  } else {
    const selectedSet = new Set(selectedLeadIds);
    targetLeads = allLeads.filter(
      (lead) => selectedSet.has(lead.id) && lead.hasValidPhone,
    );
  }

  if (!targetLeads.length) {
    throw new HttpError(
      422,
      "No valid recipients selected. Please select at least one lead with a valid phone number.",
    );
  }

  // 3. Create broadcast record in DB
  const [broadcastResult] = await pool.execute(
    `INSERT INTO whatsapp_broadcasts
       (tenant_id, created_by_user_id, message_text, recipient_mode, total_recipients, sent_count, delivered_count, failed_count)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0)`,
    [tenantId, userId || null, messageText, recipientMode, targetLeads.length],
  );
  const broadcastId = broadcastResult.insertId;

  // 4. Send messages sequentially using real Meta Cloud API with isolated per-recipient error boundaries
  let sentCount = 0;
  let failedCount = 0;
  const recipientLogs = [];

  for (const lead of targetLeads) {
    const recipientPhone = lead.cleanPhone;
    let providerMessageId = null;
    let deliveryStatus = "FAILED";
    let errorMessage = null;

    try {
      if (!recipientPhone || recipientPhone.length < 10) {
        throw new Error("Invalid or missing recipient phone number.");
      }

      const sendRes = await sendMetaWhatsAppTextMessage({
        phoneNumberId: config.phone_number_id,
        accessToken: config.access_token,
        to: recipientPhone,
        text: messageText,
      });

      if (sendRes.success) {
        providerMessageId = sendRes.messageId;
        deliveryStatus = "SENT";
        sentCount++;
      } else {
        errorMessage = sendRes.error || "Meta delivery failed";
        failedCount++;
      }
    } catch (recipientErr) {
      console.error(
        `[WhatsApp Broadcast] Error sending to recipient ${lead.id} (${recipientPhone}):`,
        recipientErr.message || recipientErr,
      );
      errorMessage =
        recipientErr.message || "Failed to deliver message to recipient.";
      failedCount++;
    }

    try {
      // Insert log record per recipient
      const [logResult] = await pool.execute(
        `INSERT INTO whatsapp_message_logs
           (broadcast_id, tenant_id, lead_id, recipient_phone, recipient_name, provider_message_id, status, error_message, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          broadcastId,
          tenantId,
          lead.id,
          lead.phone || recipientPhone,
          lead.name,
          providerMessageId,
          deliveryStatus,
          errorMessage,
          deliveryStatus === "SENT" ? new Date() : null,
        ],
      );

      recipientLogs.push({
        id: logResult.insertId,
        leadId: lead.id,
        name: lead.name,
        phone: lead.phone || recipientPhone,
        providerMessageId,
        status: deliveryStatus,
        errorMessage,
        sentAt: deliveryStatus === "SENT" ? new Date() : null,
      });
    } catch (dbLogErr) {
      console.error(
        `[WhatsApp Broadcast] Failed to save recipient log for lead ${lead.id}:`,
        dbLogErr,
      );
      recipientLogs.push({
        id: null,
        leadId: lead.id,
        name: lead.name,
        phone: lead.phone || recipientPhone,
        providerMessageId,
        status: deliveryStatus,
        errorMessage,
        sentAt: deliveryStatus === "SENT" ? new Date() : null,
      });
    }
  }

  // 5. Update broadcast aggregate counts
  await pool.execute(
    "UPDATE whatsapp_broadcasts SET sent_count = ?, failed_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [sentCount, failedCount, broadcastId],
  );

  return {
    broadcastId,
    messageText,
    totalRecipients: targetLeads.length,
    sentCount,
    deliveredCount: 0,
    failedCount,
    createdAt: new Date(),
    recipients: recipientLogs,
  };
}

export async function getWhatsAppBroadcasts(tenantId, limit = 20) {
  const [broadcastRows] = await pool.execute(
    `SELECT id, tenant_id, message_text, recipient_mode, total_recipients,
            sent_count, delivered_count, failed_count, created_at, updated_at
       FROM whatsapp_broadcasts
      WHERE tenant_id = ?
      ORDER BY id DESC
      LIMIT ?`,
    [tenantId, Number(limit) || 20],
  );

  if (!broadcastRows.length) {
    return [];
  }

  const broadcastIds = broadcastRows.map((b) => b.id);
  const placeholders = broadcastIds.map(() => "?").join(",");

  const [logRows] = await pool.execute(
    `SELECT id, broadcast_id, tenant_id, lead_id, recipient_phone, recipient_name,
            provider_message_id, status, error_message, sent_at, delivered_at, read_at, created_at
       FROM whatsapp_message_logs
      WHERE broadcast_id IN (${placeholders})
      ORDER BY id DESC`,
    broadcastIds,
  );

  const logsByBroadcast = new Map();
  for (const log of logRows) {
    if (!logsByBroadcast.has(log.broadcast_id)) {
      logsByBroadcast.set(log.broadcast_id, []);
    }
    logsByBroadcast.get(log.broadcast_id).push({
      id: log.id,
      leadId: log.lead_id,
      recipientPhone: log.recipient_phone,
      recipientName: log.recipient_name,
      providerMessageId: log.provider_message_id,
      status: log.status,
      errorMessage: log.error_message,
      sentAt: log.sent_at,
      deliveredAt: log.delivered_at,
      readAt: log.read_at,
      createdAt: log.created_at,
    });
  }

  return broadcastRows.map((b) => ({
    id: b.id,
    messageText: b.message_text,
    recipientMode: b.recipient_mode,
    totalRecipients: b.total_recipients,
    sentCount: b.sent_count,
    deliveredCount: b.delivered_count,
    failedCount: b.failed_count,
    createdAt: b.created_at,
    recipients: logsByBroadcast.get(b.id) || [],
  }));
}

export async function handleWhatsAppWebhook(body) {
  if (!body || !Array.isArray(body.entry)) return { processed: 0 };

  let processedCount = 0;
  for (const entry of body.entry) {
    if (!Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      const value = change.value;
      if (!value) continue;

      // Handle delivery status updates
      if (Array.isArray(value.statuses)) {
        for (const statusObj of value.statuses) {
          const providerMessageId = statusObj.id;
          const statusName = String(statusObj.status || "").toLowerCase();
          const timestamp = statusObj.timestamp
            ? new Date(Number(statusObj.timestamp) * 1000)
            : new Date();

          let newStatus = null;
          let dateField = null;

          if (statusName === "sent") {
            newStatus = "SENT";
            dateField = "sent_at";
          } else if (statusName === "delivered") {
            newStatus = "DELIVERED";
            dateField = "delivered_at";
          } else if (statusName === "read") {
            newStatus = "READ";
            dateField = "read_at";
          } else if (statusName === "failed") {
            newStatus = "FAILED";
          }

          if (newStatus && providerMessageId) {
            let updateQuery = "UPDATE whatsapp_message_logs SET status = ?";
            const updateParams = [newStatus];

            if (dateField) {
              updateQuery += `, ${dateField} = COALESCE(${dateField}, ?)`;
              updateParams.push(timestamp);
            }
            if (newStatus === "FAILED" && Array.isArray(statusObj.errors)) {
              updateQuery += ", error_message = ?";
              updateParams.push(statusObj.errors[0]?.message || "Delivery failed");
            }

            updateQuery += " WHERE provider_message_id = ?";
            updateParams.push(providerMessageId);

            const [updateRes] = await pool.execute(updateQuery, updateParams);
            if (updateRes.affectedRows > 0) {
              processedCount++;

              // Recalculate delivered/failed counts for parent broadcast
              const [findBroadcast] = await pool.execute(
                "SELECT broadcast_id FROM whatsapp_message_logs WHERE provider_message_id = ? LIMIT 1",
                [providerMessageId],
              );
              const broadcastId = findBroadcast[0]?.broadcast_id;
              if (broadcastId) {
                await pool.execute(
                  `UPDATE whatsapp_broadcasts b
                      SET delivered_count = (
                            SELECT COUNT(*) FROM whatsapp_message_logs
                             WHERE broadcast_id = b.id AND status IN ('DELIVERED', 'READ')
                          ),
                          failed_count = (
                            SELECT COUNT(*) FROM whatsapp_message_logs
                             WHERE broadcast_id = b.id AND status = 'FAILED'
                          ),
                          updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?`,
                  [broadcastId],
                );
              }
            }
          }
        }
      }

      // Handle incoming user messages (Phase 2)
      if (Array.isArray(value.messages)) {
        for (const msg of value.messages) {
          try {
            await processIncomingWhatsAppMessage({
              msg,
              metadata: value.metadata,
              contacts: value.contacts,
            });
            processedCount++;
          } catch (msgErr) {
            console.error(
              "[WhatsApp Webhook] Error processing incoming user message:",
              msgErr,
            );
          }
        }
      }
    }
  }

  return { processed: processedCount };
}

export async function sendMetaWhatsAppTextMessage({
  phoneNumberId,
  accessToken,
  to,
  text,
}) {
  const metaSendUrl = `${META_GRAPH_BASE}/${encodeURIComponent(phoneNumberId)}/messages`;
  const tokenToUse = (process.env.META_ACCESS_TOKEN || accessToken || "").trim();
  try {
    const response = await fetch(metaSendUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenToUse}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: {
          preview_url: false,
          body: text,
        },
      }),
    });

    const data = await response.json();
    if (response.ok && Array.isArray(data.messages) && data.messages[0]?.id) {
      return {
        success: true,
        messageId: data.messages[0].id,
      };
    }

    const errorMessage =
      data?.error?.message ||
      `HTTP ${response.status}: Failed to deliver message.`;
    return {
      success: false,
      error: errorMessage,
      errorCode: data?.error?.code,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || "Network error while calling Meta API.",
    };
  }
}

export function getWhatsAppConversationalReply(text, chatbotDisplayName = "Barun AI", history = []) {
  const raw = String(text || "").trim();
  const normalized = raw
    .toLowerCase()
    .replace(/(.)\1{2,}/g, "$1$1")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return null;

  // Helper course flags
  const mentionsBTech =
    normalized.includes("btech") ||
    normalized.includes("b tech") ||
    normalized.includes("b.tech");
  const mentionsMBA = normalized.includes("mba");
  const mentionsBBA = normalized.includes("bba");
  const mentionsBCA = normalized.includes("bca");
  const mentionsMCA = normalized.includes("mca");
  const mentionsCourse =
    mentionsBTech || mentionsMBA || mentionsBBA || mentionsBCA || mentionsMCA;

  // 1. EXTERNAL_ACTION_REQUEST (Highest priority for call/contact requests to third parties/parents)
  const isExternalAction =
    normalized.includes("call my dad") ||
    normalized.includes("call my father") ||
    normalized.includes("call my mom") ||
    normalized.includes("call my mother") ||
    normalized.includes("call my parent") ||
    normalized.includes("call my parents") ||
    normalized.includes("contact my father") ||
    normalized.includes("contact my dad") ||
    normalized.includes("contact my parent") ||
    normalized.includes("contact my mom") ||
    normalized.includes("send this to my dad") ||
    normalized.includes("call someone for me") ||
    normalized.includes("call my brother") ||
    normalized.includes("call my sister") ||
    normalized.includes("call my guardian") ||
    normalized.includes("talk to my dad") ||
    normalized.includes("talk to my father") ||
    normalized.includes("inform my dad") ||
    normalized.includes("inform my father") ||
    normalized.includes("can you call my father") ||
    normalized.includes("can you call my dad") ||
    normalized.includes("could you contact my dad") ||
    normalized.includes("please call my parents") ||
    normalized.includes("can you talk to my father");

  if (isExternalAction) {
    if (mentionsMBA) {
      return `Sorry, I can't make calls or contact someone on your behalf. Regarding MBA, it is a 2-year postgraduate management program. I can help share fee details, eligibility, or arrange an admissions counsellor call.`;
    }
    if (mentionsBTech) {
      return `Sorry, I can't make calls or contact someone on your behalf. Regarding B.Tech, it is a 4-year undergraduate engineering program. I can help share fee details, eligibility, or arrange an admissions counsellor call.`;
    }
    return `Sorry, I can't make calls or contact someone on your behalf. I can help you with courses, admissions, fees, scholarships and other education-related queries.`;
  }

  // 2. BOT_IDENTITY (Highest Priority for identity questions, even if mixed with "hi" or "sir")
  const isBotIdentity =
    normalized.includes("who are you") ||
    normalized.includes("who are u") ||
    normalized.includes("who r u") ||
    normalized.includes("what are you") ||
    normalized.includes("what is your name") ||
    normalized.includes("what s your name") ||
    normalized.includes("who is this") ||
    normalized.includes("are you a bot") ||
    normalized.includes("are you bot") ||
    normalized.includes("are you ai") ||
    normalized.includes("are u ai") ||
    normalized.includes("are u a bot") ||
    normalized.includes("tell me about yourself") ||
    normalized.includes("tell me about you") ||
    normalized.includes("who made you") ||
    normalized.includes("aap kaun ho") ||
    normalized.includes("koun ho aap") ||
    normalized.includes("tum kaun ho") ||
    normalized.includes("who am i talking to") ||
    normalized.includes("what bot is this");

  if (isBotIdentity) {
    if (
      normalized.includes("are you ai") ||
      normalized.includes("are you a bot") ||
      normalized.includes("are you bot") ||
      normalized.includes("are u ai")
    ) {
      return `Yes, I'm ${chatbotDisplayName}, your virtual AI assistant. I'm here to help you with courses, admissions, fees and other education-related queries.`;
    }
    return `Hi! I'm ${chatbotDisplayName}, your virtual AI assistant. I can help you with courses, admissions, fees, scholarships, placements and other education-related queries. How may I assist you today?`;
  }

  // 3. HUMAN_COUNSELLOR_REQUEST
  const isCounsellorRequest =
    normalized.includes("counsellor") ||
    normalized.includes("counselor") ||
    normalized.includes("talk to human") ||
    normalized.includes("human agent") ||
    normalized.includes("talk to someone") ||
    normalized.includes("speak to human") ||
    normalized.includes("speak to counsellor") ||
    normalized.includes("speak to counselor") ||
    normalized.includes("talk to a counsellor") ||
    normalized.includes("talk to a counselor") ||
    normalized.includes("call me") ||
    normalized.includes("counselling") ||
    normalized.includes("counseling");

  if (isCounsellorRequest) {
    return "I can help connect you with an admissions counsellor. Please share what you'd like assistance with or your preferred call time, and our team will get in touch.";
  }

  // 4. DISCOUNT / CONCESSION
  const isDiscount =
    normalized.includes("discount") ||
    normalized.includes("concession") ||
    normalized.includes("fee reduction") ||
    normalized.includes("reduce the fees") ||
    normalized.includes("fees kam ho sakti hai") ||
    normalized.includes("fee waiver") ||
    normalized.includes("special offer");

  if (isDiscount) {
    if (mentionsBTech) {
      return `Sorry, I can't provide or approve discounts directly for B.Tech. Admission fees are fixed by the institution. I can help you with B.Tech fee structure, merit scholarships, or financial assistance options.`;
    }
    if (mentionsMBA) {
      return `Sorry, I can't provide or approve discounts directly for MBA. Admission fees are fixed by the institution. I can help you with MBA fee structure, merit scholarships, or financial assistance options.`;
    }
    return `Sorry, I can't provide or approve discounts directly. Admission fees are fixed by the institution. I can help you with fee details, scholarships or available financial-assistance options.`;
  }

  // 5. GREETING (pure greetings only)
  const isFeeQuery =
    normalized.includes("fee") ||
    normalized.includes("fees") ||
    normalized.includes("cost") ||
    normalized.includes("tuition");

  const isAdmissionQuery =
    normalized.includes("admission") ||
    normalized.includes("apply") ||
    normalized.includes("eligibility") ||
    normalized.includes("process");

  const greetingPhrases = [
    "hi",
    "hii",
    "hiii",
    "hello",
    "helo",
    "helloo",
    "hey",
    "heyy",
    "good morning",
    "good afternoon",
    "good evening",
    "namaste",
    "namaskar",
  ];

  const isPureGreeting =
    (greetingPhrases.includes(normalized) ||
      normalized.startsWith("hi ") ||
      normalized.startsWith("hello ") ||
      normalized.startsWith("hey ")) &&
    !isFeeQuery &&
    !isAdmissionQuery &&
    !mentionsCourse;

  if (isPureGreeting) {
    return `Hi! 👋 Welcome to ${chatbotDisplayName}. How can I help you today?`;
  }

  // 6. THANKS
  const isThanks =
    normalized === "thanks" ||
    normalized === "thank you" ||
    normalized === "thankyou" ||
    normalized === "thx" ||
    normalized === "okay thanks" ||
    normalized === "ok thanks" ||
    normalized === "many thanks" ||
    normalized.startsWith("thanks") ||
    normalized.startsWith("thank you");

  if (isThanks) {
    return "You're welcome! 😊 Let me know if you need help with anything.";
  }

  // 7. GOODBYE
  const isGoodbye =
    normalized === "bye" ||
    normalized === "goodbye" ||
    normalized === "see you" ||
    normalized === "take care" ||
    normalized === "cya" ||
    normalized === "byee" ||
    normalized.startsWith("bye ");

  if (isGoodbye) {
    return "Goodbye! Feel free to message me whenever you need help. Have a great day!";
  }

  // 8. Specific course & fee responses for natural queries
  if (mentionsBTech) {
    if (isFeeQuery) {
      return "B.Tech tuition fee structure varies by specialization (Computer Science, IT, Core Engineering). I can guide you through the annual fees, installment options, and scholarship criteria.";
    }
    if (normalized.includes("eligibility") || normalized.includes("qualification")) {
      return "B.Tech eligibility requires completion of 10+2 (Higher Secondary) with Physics, Chemistry, and Mathematics (PCM) from a recognized board with minimum aggregate marks.";
    }
    if (normalized.includes("placement") || normalized.includes("job") || normalized.includes("salary")) {
      return "B.Tech graduates receive strong campus placement support with top IT and engineering recruiters. Career guidance and internship opportunities are provided from the pre-final year.";
    }
  }

  if (mentionsMBA) {
    if (isFeeQuery) {
      return "MBA tuition fee structure depends on the specialization format and intake. I can guide you through the fee breakup, hostel charges, and scholarship criteria.";
    }
    if (normalized.includes("eligibility") || normalized.includes("qualification")) {
      return "MBA eligibility requires a Bachelor's Degree in any discipline from a recognized university with minimum aggregate marks.";
    }
    if (normalized.includes("placement") || normalized.includes("job") || normalized.includes("salary")) {
      return "MBA students receive dedicated placement assistance, corporate leadership seminars, and campus drives with leading MNCs and management firms.";
    }
  }

  // 9. SCHOLARSHIP / FINANCIAL ASSISTANCE
  if (
    normalized.includes("scholarship") ||
    normalized.includes("financial aid") ||
    normalized.includes("financial assistance")
  ) {
    return "Scholarship and financial-assistance options depend on academic merit and program eligibility. I can help guide you on eligibility criteria and application requirements.";
  }

  // 10. HOSTEL
  if (
    normalized.includes("hostel") ||
    normalized.includes("accommodation") ||
    normalized.includes("mess")
  ) {
    return "Hostel facilities and accommodation are available for students. Please let me know which program or campus you are considering for specific hostel details.";
  }

  // 11. PLACEMENT
  if (
    normalized.includes("placement") ||
    normalized.includes("placements") ||
    normalized.includes("career support")
  ) {
    return "Our placement cell provides career support, campus recruitment drives, and interview preparation across all major programs. Tell me which course you are considering for program-specific placement highlights.";
  }

  // 12. DOCUMENTS
  if (
    normalized.includes("document") ||
    normalized.includes("documents required") ||
    normalized.includes("required documents")
  ) {
    return "Common documents required for admission include 10th & 12th mark sheets, graduation certificates (for PG), ID proof (Aadhaar/Passport), passport photos, and migration certificates.";
  }

  // 13. ADMISSION PROCESS
  if (
    normalized.includes("admission process") ||
    normalized.includes("how to take admission") ||
    normalized.includes("how can i take admission") ||
    normalized.includes("how do i apply")
  ) {
    return "Our admission process is simple: choose your preferred program, check the eligibility criteria, fill out the application form, submit required documents, and confirm your seat.";
  }

  // 14. CONTACT / LOCATION
  if (
    normalized.includes("where is the college") ||
    normalized.includes("campus location") ||
    normalized.includes("office hours") ||
    normalized.includes("address")
  ) {
    return "You can visit our admissions office during working hours (9:00 AM - 5:00 PM, Mon-Sat) or share your query here for instant assistance.";
  }

  return null;
}

export async function sendWhatsAppTypingIndicator({
  phoneNumberId,
  incomingMessageId,
  accessToken,
}) {
  if (!phoneNumberId || !incomingMessageId || !accessToken) {
    return { success: false, error: "Missing required parameters" };
  }

  const metaUrl = `${META_GRAPH_BASE}/${encodeURIComponent(phoneNumberId)}/messages`;
  try {
    const response = await fetch(metaUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: incomingMessageId,
        typing_indicator: {
          type: "text",
        },
      }),
    });

    const data = await response.json();
    if (response.ok && data?.success !== false) {
      console.log("[WA DEBUG] TYPING_INDICATOR_SENT", {
        incomingMessageId,
      });
      return { success: true };
    }

    const errorMsg = data?.error?.message || `HTTP ${response.status}`;
    console.warn("[WA DEBUG] TYPING_INDICATOR_FAILED", {
      incomingMessageId,
      error: errorMsg,
      errorCode: data?.error?.code,
    });
    return { success: false, error: errorMsg };
  } catch (err) {
    console.warn("[WA DEBUG] TYPING_INDICATOR_FAILED", {
      incomingMessageId,
      error: err.message,
    });
    return { success: false, error: err.message };
  }
}

export async function processIncomingWhatsAppMessage({
  msg,
  metadata,
  contacts,
}) {
  const inboundMessageId = msg?.id;
  if (!inboundMessageId) return { processed: false, reason: "no_message_id" };

  // 1. Deduplication / loop protection
  if (isDuplicateInbound(inboundMessageId)) {
    console.log(
      `[WhatsApp Webhook] Duplicate inbound message ignored: ${inboundMessageId}`,
    );
    return { processed: false, reason: "duplicate_memory" };
  }
  markInboundProcessed(inboundMessageId);

  const [existingDbMsg] = await pool.execute(
    `SELECT id FROM conversation_messages WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.provider_message_id')) = ? LIMIT 1`,
    [inboundMessageId],
  );
  if (existingDbMsg.length > 0) {
    console.log(
      `[WhatsApp Webhook] Duplicate message in DB: ${inboundMessageId}`,
    );
    return { processed: false, reason: "duplicate_db" };
  }

  // 2. Extract message text
  let incomingText = "";
  if (msg.type === "text" && msg.text?.body) {
    incomingText = msg.text.body.trim();
  } else if (msg.type === "button" && msg.button?.text) {
    incomingText = msg.button.text.trim();
  } else if (msg.type === "interactive") {
    incomingText =
      msg.interactive?.button_reply?.title ||
      msg.interactive?.list_reply?.title ||
      "";
  }

  if (!incomingText) {
    console.log(`[WhatsApp Webhook] Unsupported message type: ${msg.type}`);
    return { processed: false, reason: "unsupported_type" };
  }

  const rawSenderPhone = msg.from;
  const senderPhone = cleanPhoneNumber(rawSenderPhone);
  const phoneNumberId = metadata?.phone_number_id;

  console.log("[WA DEBUG] INBOUND_MESSAGE_PARSED", {
    inboundMessageId,
    sender: rawSenderPhone,
    cleanedPhone: senderPhone,
    text: incomingText,
    phoneNumberId,
  });

  // 3. Resolve tenant & WhatsApp configuration
  let config = null;
  if (phoneNumberId) {
    const [cfgRows] = await pool.execute(
      `SELECT id, tenant_id, business_name, phone_number, phone_number_id, access_token, status
         FROM whatsapp_configs
        WHERE phone_number_id = ? AND status = 'CONNECTED'
        LIMIT 1`,
      [phoneNumberId],
    );
    config = cfgRows[0];
  }

  if (!config) {
    const [allCfg] = await pool.execute(
      `SELECT id, tenant_id, business_name, phone_number, phone_number_id, access_token, status
         FROM whatsapp_configs
        WHERE status = 'CONNECTED'
        ORDER BY id DESC LIMIT 1`,
    );
    config = allCfg[0];
  }

  if (!config || !config.access_token) {
    console.warn(
      `[WhatsApp Webhook] No connected WhatsApp configuration found.`,
    );
    return { processed: false, reason: "no_config" };
  }

  // Prevent self-loop if sender is our own business number
  if (
    senderPhone &&
    config.phone_number &&
    senderPhone === cleanPhoneNumber(config.phone_number)
  ) {
    console.log(
      `[WhatsApp Webhook] Ignored message from own business phone number: ${senderPhone}`,
    );
    return { processed: false, reason: "self_message" };
  }

  const tenantId = config.tenant_id;
  const contactName =
    contacts?.find((c) => c.wa_id === rawSenderPhone)?.profile?.name ||
    "Student";

  console.log("[WA DEBUG] TENANT_RESOLVED", {
    tenantId,
    businessName: config.business_name,
    businessPhone: config.phone_number,
  });

  // Immediately send native WhatsApp typing indicator (before rule engine and natural delay)
  try {
    await sendWhatsAppTypingIndicator({
      phoneNumberId: config.phone_number_id,
      incomingMessageId: inboundMessageId,
      accessToken: config.access_token,
    });
  } catch (typingErr) {
    console.warn("[WA DEBUG] TYPING_INDICATOR_FAILED", {
      error: typingErr.message,
    });
  }

  // 4. Resolve Chatbot for Tenant (2-step fetch to avoid MySQL sort_buffer_size limit on large JSON columns)
  let activeChatbot = null;
  let chatbotConfig = {};
  const [chatbotMetaRows] = await pool.execute(
    `SELECT id, public_id, name
       FROM chatbots
      WHERE tenant_id = ? AND status = 'ACTIVE' AND deleted_at IS NULL
      ORDER BY id DESC
      LIMIT 1`,
    [tenantId],
  );
  if (chatbotMetaRows.length > 0) {
    const meta = chatbotMetaRows[0];
    const [cfgRows] = await pool.execute(
      `SELECT published_config_json, config_json
         FROM chatbots
        WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [meta.id],
    );
    activeChatbot = {
      ...meta,
      published_config_json: cfgRows[0]?.published_config_json,
      config_json: cfgRows[0]?.config_json,
    };
    chatbotConfig = parseJsonSafe(
      cfgRows[0]?.published_config_json || cfgRows[0]?.config_json,
      {},
    );
  }
  if (!activeChatbot) {
    const [fallbackChatbot] = await pool.execute(
      `SELECT id, public_id, name FROM chatbots WHERE deleted_at IS NULL ORDER BY id ASC LIMIT 1`,
    );
    if (fallbackChatbot.length > 0) {
      activeChatbot = fallbackChatbot[0];
    }
  }

  const chatbotId = activeChatbot?.id;
  const chatbotPublicId = activeChatbot?.public_id || randomUUID();
  const chatbotName =
    activeChatbot?.name || config.business_name || "Admissions Team";

  console.log("[WA DEBUG] CHATBOT_RESOLVED", {
    chatbotId,
    chatbotName,
    hasPublishedConfig: Boolean(activeChatbot?.published_config_json),
  });

  // 5. Resolve / Create Lead in existing leads table using normalized phone matching
  let leadId = null;
  let visitorId = `wa_${senderPhone}`;
  const rawDigits = String(senderPhone || "").replace(/\D/g, "");
  const last10Digits = rawDigits.length >= 10 ? rawDigits.slice(-10) : rawDigits;
  const altVisitorId1 = `wa_${last10Digits}`;
  const altVisitorId2 = `wa_${rawDigits}`;

  const [leadRows] = await pool.execute(
    `SELECT id, public_id, visitor_id, fields_json
       FROM leads
      WHERE tenant_id = ? AND deleted_at IS NULL AND (
        fields_json LIKE ? OR 
        fields_json LIKE ? OR 
        fields_json LIKE ? OR 
        visitor_id = ? OR 
        visitor_id = ? OR 
        visitor_id = ?
      )
      ORDER BY id DESC LIMIT 1`,
    [
      tenantId,
      `%${senderPhone}%`,
      `%${rawDigits}%`,
      `%${last10Digits}%`,
      visitorId,
      altVisitorId1,
      altVisitorId2,
    ],
  );

  if (leadRows.length > 0) {
    leadId = leadRows[0].id;
    visitorId = leadRows[0].visitor_id || visitorId;
  } else {
    const newLeadPublicId = randomUUID();
    const [newLeadRes] = await pool.execute(
      `INSERT INTO leads
        (public_id, tenant_id, chatbot_id, chatbot_public_id, visitor_id, source, fields_json, status)
       VALUES (?, ?, ?, ?, ?, 'whatsapp', ?, 'NEW')`,
      [
        newLeadPublicId,
        tenantId,
        chatbotId,
        chatbotPublicId,
        visitorId,
        JSON.stringify({
          name: contactName,
          phone: senderPhone,
          leadSource: "WhatsApp",
          channel: "whatsapp",
        }),
      ],
    );
    leadId = newLeadRes.insertId;

    notifyAdminsOfTenant({
      tenantId,
      type: "NEW_LEAD",
      title: "New WhatsApp Lead Received",
      message: `New student lead received from ${contactName} (${senderPhone}) on WhatsApp.`,
      module: "WhatsApp",
      entityType: "lead",
      entityId: leadId,
      priority: "INFO",
    }).catch(() => {});
  }

  console.log("[WA DEBUG] LEAD_RESOLVED", {
    leadId,
    contactName,
    visitorId,
  });

  // 6. Resolve / Create Conversation
  let conversationId = null;
  const [convRows] = await pool.execute(
    `SELECT id, public_id, status FROM conversations
      WHERE tenant_id = ? AND visitor_id = ? AND channel = 'whatsapp'
      ORDER BY id DESC LIMIT 1`,
    [tenantId, visitorId],
  );

  if (convRows.length > 0) {
    conversationId = convRows[0].id;
  } else {
    const convPublicId = randomUUID();
    const [newConvRes] = await pool.execute(
      `INSERT INTO conversations
        (public_id, tenant_id, chatbot_id, chatbot_public_id, visitor_id, channel, status)
       VALUES (?, ?, ?, ?, ?, 'whatsapp', 'OPEN')`,
      [convPublicId, tenantId, chatbotId, chatbotPublicId, visitorId],
    );
    conversationId = newConvRes.insertId;
  }

  // 7. Store Inbound Message in conversation_messages
  const inboundTimestamp = msg.timestamp
    ? new Date(Number(msg.timestamp) * 1000)
    : new Date();
  const inboundMetadata = {
    provider: "meta",
    channel: "whatsapp",
    direction: "inbound",
    phone: senderPhone,
    provider_message_id: inboundMessageId,
    timestamp: inboundTimestamp.toISOString(),
  };

  await pool.execute(
    `INSERT INTO conversation_messages
      (conversation_id, tenant_id, chatbot_id, role, content, status, metadata_json, created_at)
     VALUES (?, ?, ?, 'USER', ?, 'SENT', ?, ?)`,
    [
      conversationId,
      tenantId,
      chatbotId,
      incomingText,
      JSON.stringify(inboundMetadata),
      inboundTimestamp,
    ],
  );
  await pool.execute(
    "UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [conversationId],
  );

  // 8. Retrieve Conversation Context / History
  const [historyRows] = await pool.execute(
    `SELECT role, content, created_at
       FROM conversation_messages
      WHERE conversation_id = ?
      ORDER BY id DESC
      LIMIT 6`,
    [conversationId],
  );
  const history = historyRows.reverse().map((r) => ({
    role: r.role === "USER" ? "user" : "bot",
    text: r.content,
    createdAt: r.created_at,
  }));

  // Context-aware enrichment: ONLY enrich with previous course if the current query is a genuine follow-up
  // (e.g. user asks "fees?", "what is the eligibility?", "hostel?") AND is NOT an identity/greeting query!
  let contextualQuery = incomingText;
  const lowerIncoming = incomingText.toLowerCase();
  const isFollowUpQuery =
    lowerIncoming.includes("fee") ||
    lowerIncoming.includes("fees") ||
    lowerIncoming.includes("eligibility") ||
    lowerIncoming.includes("hostel") ||
    lowerIncoming.includes("placement") ||
    lowerIncoming.includes("duration") ||
    lowerIncoming.includes("admission process") ||
    lowerIncoming.includes("scholarship");

  const mentionsCourse =
    lowerIncoming.includes("b.tech") ||
    lowerIncoming.includes("btech") ||
    lowerIncoming.includes("mba") ||
    lowerIncoming.includes("bba") ||
    lowerIncoming.includes("bca");

  if (isFollowUpQuery && !mentionsCourse && history.length > 1) {
    for (let i = history.length - 2; i >= 0; i--) {
      const prevText = String(history[i].text || "").toLowerCase();
      if (prevText.includes("b.tech") || prevText.includes("btech")) {
        contextualQuery = `${incomingText} (B.Tech)`;
        break;
      } else if (prevText.includes("mba")) {
        contextualQuery = `${incomingText} (MBA)`;
        break;
      } else if (prevText.includes("bba")) {
        contextualQuery = `${incomingText} (BBA)`;
        break;
      } else if (prevText.includes("bca")) {
        contextualQuery = `${incomingText} (BCA)`;
        break;
      }
    }
  }

  // 9. Generate Response:
  // First check WhatsApp-specific High-Priority Conversational Intent Layer (Barun AI identity, Greetings, Thanks, Counsellor, Discounts, Calls)
  let generatedReply = getWhatsAppConversationalReply(incomingText, "Barun AI", history);

  console.log("[WA DEBUG] RULE_ENGINE_START", {
    incomingText,
    contextualQuery,
    intentLayerMatched: Boolean(generatedReply),
    chatbotName: "Barun AI",
  });

  if (!generatedReply) {
    try {
      const responseObj = generateMockResponse({
        message: contextualQuery,
        chatbotName: "Barun AI",
      });
      const rawReply = responseObj?.reply || "";
      const lowerQuery = incomingText.toLowerCase();
      const mentionsMbaInQuery = lowerQuery.includes("mba");

      // Check if fallback returned an obviously mismatched MBA response for an unrelated query
      if (rawReply.includes("MBA is a postgraduate") && !mentionsMbaInQuery) {
        generatedReply =
          "I'm happy to help. Could you tell me whether you're asking about courses, fees, admissions, eligibility, scholarships or placements?";
      } else {
        generatedReply = rawReply;
      }
    } catch (err) {
      console.error("[WhatsApp Webhook] Rule-based engine error:", err);
      generatedReply =
        "Thank you for contacting us. Our admissions team will reach out to you shortly.";
    }
  }

  if (!generatedReply) {
    generatedReply =
      "I'm happy to help. Could you tell me whether you're asking about courses, fees, admissions, eligibility, scholarships or placements?";
  }

  console.log("[WA DEBUG] RULE_ENGINE_RESULT", {
    generatedReply,
  });

  // 10. Natural Response Delay: Wait ~2–3 seconds before sending
  console.log("[WA DEBUG] DELAY_START", "Waiting ~2.5s...");
  await new Promise((resolve) => setTimeout(resolve, 2500));

  // 11. Send Automatic WhatsApp Reply via Meta Cloud API
  console.log("[WA DEBUG] META_SEND_START", {
    to: senderPhone,
    textLength: generatedReply.length,
  });
  const sendResult = await sendMetaWhatsAppTextMessage({
    phoneNumberId: config.phone_number_id,
    accessToken: config.access_token,
    to: senderPhone,
    text: generatedReply,
  });

  if (sendResult.success) {
    console.log("[WA DEBUG] META_SEND_SUCCESS", {
      outboundWamid: sendResult.messageId,
    });
  } else {
    console.error("[WA DEBUG] META_SEND_FAILED", {
      error: sendResult.error,
      errorCode: sendResult.errorCode,
    });
  }

  // 12. Save Outbound Auto-Reply in Database
  const outboundWamid = sendResult.success ? sendResult.messageId : null;
  const outboundMetadata = {
    provider: "meta",
    channel: "whatsapp",
    direction: "outbound",
    phone: senderPhone,
    provider_message_id: outboundWamid,
    error: sendResult.error || null,
    timestamp: new Date().toISOString(),
  };

  await pool.execute(
    `INSERT INTO conversation_messages
      (conversation_id, tenant_id, chatbot_id, role, content, status, metadata_json)
     VALUES (?, ?, ?, 'ASSISTANT', ?, ?, ?)`,
    [
      conversationId,
      tenantId,
      chatbotId,
      generatedReply,
      sendResult.success ? "SENT" : "FAILED",
      JSON.stringify(outboundMetadata),
    ],
  );

  // Also record in whatsapp_message_logs for delivery tracking
  try {
    await pool.execute(
      `INSERT INTO whatsapp_message_logs
        (broadcast_id, tenant_id, lead_id, recipient_phone, recipient_name, provider_message_id, status, error_message, sent_at)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        tenantId,
        leadId,
        senderPhone,
        contactName,
        outboundWamid,
        sendResult.success ? "SENT" : "FAILED",
        sendResult.error || null,
      ],
    );
  } catch (logErr) {
    console.warn(
      "[WhatsApp Webhook] Could not insert into whatsapp_message_logs:",
      logErr.message,
    );
  }

  return {
    processed: true,
    inboundMessageId,
    outboundWamid,
    replySent: sendResult.success,
  };
}
