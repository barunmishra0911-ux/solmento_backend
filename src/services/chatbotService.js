import { pool } from "../config/database.js";
import { HttpError } from "../utils/http.js";
import { randomUUID } from "node:crypto";
import { getConversationContext, getConversationHistory, saveAssistantMessage, saveUserMessage, validateVisitorId } from "./publicConversationService.js";
import { generateMockResponse } from "./mockResponseProvider.js";
import { createExotelOutboundCall } from "./exotelService.js";
import { notifyAdminsOfTenant } from "./notificationService.js";
import { crawlWebsite } from "./crawlerService.js";
import {
  getChatbotKnowledgeStats,
  getCurrentSourceTopicInventory,
  saveCrawledPages,
  searchKnowledgeExcerpts,
} from "./chatbotKnowledgeService.js";
import { generateGroundedResponse, isGeminiConfigured } from "./geminiService.js";

const chatbotColumns = `id, public_id, tenant_id, name, description, status, start_mode, channels_json,
  config_json, published_config_json, conversations_this_month, created_at, updated_at`;

function parseChannels(value) {
  if (Array.isArray(value)) return value;
  try {
    const channels = JSON.parse(value || "[]");
    return Array.isArray(channels) ? channels : [];
  } catch {
    return [];
  }
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapChatbot(row) {
  return {
    id: String(row.id),
    publicId: row.public_id || null,
    name: row.name,
    description: row.description,
    status: row.status.toLowerCase(),
    startMode: row.start_mode.toLowerCase(),
    channels: parseChannels(row.channels_json),
    conversationsThisMonth: row.conversations_this_month,
    createdAt: row.created_at,
    lastEditedAt: row.updated_at,
  };
}

async function getChatbotOrThrow(id, tenantId, connection = pool) {
  const [rows] = await connection.execute(
    `SELECT ${chatbotColumns} FROM chatbots WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1`,
    [id, tenantId],
  );
  if (!rows.length) throw new HttpError(404, "Chatbot not found.");
  return rows[0];
}

async function listBuilderVersions(id, tenantId, connection = pool) {
  const [rows] = await connection.execute(
    `SELECT v.version_number, v.changes_json, v.created_at, u.name AS publisher
       FROM chatbot_versions v
       LEFT JOIN users u ON u.id = v.published_by_user_id
      WHERE v.chatbot_id = ? AND v.tenant_id = ?
      ORDER BY v.version_number DESC`,
    [id, tenantId],
  );
  return rows.map((row) => ({
    version: row.version_number,
    date: row.created_at,
    publisher: row.publisher || "Client Admin",
    changes: parseJson(row.changes_json, []).join(" · ") || "Configuration published",
  }));
}

export async function listChatbots(tenantId) {
  const [rows] = await pool.execute(
    `SELECT ${chatbotColumns} FROM chatbots WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC`,
    [tenantId],
  );
  return rows.map(mapChatbot);
}

export async function getChatbot(id, tenantId) {
  return mapChatbot(await getChatbotOrThrow(id, tenantId));
}

export async function createChatbot({ tenantId, userId, name, description, sitemapUrl, channels, status, startMode }) {
  const normalizedName = name.trim();
  try {
    const [result] = await pool.execute(
      `INSERT INTO chatbots
        (public_id, tenant_id, name, description, status, start_mode, channels_json, config_json, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), tenantId, normalizedName, description.trim(), status.toUpperCase(), startMode.toUpperCase(), JSON.stringify(channels), JSON.stringify(sitemapUrl ? { websiteUrl: sitemapUrl } : {}), userId],
    );
    return mapChatbot(await getChatbotOrThrow(result.insertId, tenantId));
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") {
      throw new HttpError(409, "A chatbot with this name already exists in your workspace.");
    }
    throw error;
  }
}

export async function updateChatbotStatus({ id, tenantId, status }) {
  await getChatbotOrThrow(id, tenantId);
  await pool.execute(
    "UPDATE chatbots SET status = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
    [status.toUpperCase(), id, tenantId],
  );
  return mapChatbot(await getChatbotOrThrow(id, tenantId));
}

export async function duplicateChatbot({ id, tenantId, userId }) {
  const source = await getChatbotOrThrow(id, tenantId);
  const baseName = `${source.name} (Copy)`;
  let copyName = baseName;
  let suffix = 2;

  while (true) {
    const [existing] = await pool.execute(
      "SELECT id FROM chatbots WHERE tenant_id = ? AND name = ? LIMIT 1",
      [tenantId, copyName],
    );
    if (!existing.length) break;
    copyName = `${baseName} ${suffix++}`;
  }

  const [result] = await pool.execute(
    `INSERT INTO chatbots
      (public_id, tenant_id, name, description, status, start_mode, channels_json, config_json, published_config_json, conversations_this_month, created_by_user_id)
     VALUES (?, ?, ?, ?, 'INACTIVE', ?, ?, ?, ?, 0, ?)`,
    [
      randomUUID(),
      tenantId,
      copyName,
      source.description,
      source.start_mode,
      JSON.stringify(parseChannels(source.channels_json)),
      source.config_json ? (typeof source.config_json === "string" ? source.config_json : JSON.stringify(source.config_json)) : null,
      source.published_config_json ? (typeof source.published_config_json === "string" ? source.published_config_json : JSON.stringify(source.published_config_json)) : null,
      userId || null,
    ],
  );
  return mapChatbot(await getChatbotOrThrow(result.insertId, tenantId));
}

export async function deleteChatbot({ id, tenantId, actorUserId }) {
  const chatbot = await getChatbotOrThrow(id, tenantId);
  const deletedName = `${chatbot.name}__deleted_${Date.now()}`;
  await pool.execute(
    `UPDATE chatbots
        SET deleted_at = CURRENT_TIMESTAMP,
            deleted_by_user_id = ?,
            name = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
    [actorUserId || null, deletedName, id, tenantId],
  );
  return mapChatbot(chatbot);
}

export async function restoreChatbot({ id, tenantId }) {
  const [rows] = await pool.execute(
    `SELECT ${chatbotColumns} FROM chatbots WHERE id = ? AND tenant_id = ? AND deleted_at IS NOT NULL LIMIT 1`,
    [id, tenantId],
  );
  if (!rows.length) throw new HttpError(404, "Deleted chatbot not found.");

  await pool.execute(
    `UPDATE chatbots
        SET deleted_at = NULL,
            deleted_by_user_id = NULL
      WHERE id = ? AND tenant_id = ?`,
    [id, tenantId],
  );
  return mapChatbot(rows[0]);
}

export async function getChatbotBuilder(id, tenantId) {
  const chatbot = await getChatbotOrThrow(id, tenantId);
  return {
    chatbot: mapChatbot(chatbot),
    draftConfig: parseJson(chatbot.config_json),
    publishedConfig: parseJson(chatbot.published_config_json),
    versions: await listBuilderVersions(chatbot.id, tenantId),
  };
}

async function handlePotentialSourceSwitch({ tenantId, chatbotId, config }) {
  const newTargetUrl = String(config?.websiteUrl || config?.sitemapUrl || "").trim();
  if (!newTargetUrl) return;

  const { computeSourceFingerprint } = await import("./chatbotKnowledgeService.js");
  const newFp = computeSourceFingerprint(newTargetUrl);

  const [existingStates] = await pool.execute(
    "SELECT source_fingerprint, active_source_fingerprint FROM chatbot_crawl_states WHERE tenant_id = ? AND chatbot_id = ? LIMIT 1",
    [tenantId, chatbotId],
  );

  let sourceChanged = false;
  if (existingStates.length > 0) {
    const existing = existingStates[0];
    if (existing.source_fingerprint && existing.source_fingerprint !== newFp) {
      sourceChanged = true;
      await pool.execute(
        `UPDATE chatbot_crawl_states
            SET website_url = ?,
                source_fingerprint = ?,
                last_check_status = 'RECONFIGURING',
                active_source_fingerprint = NULL
          WHERE tenant_id = ? AND chatbot_id = ?`,
        [newTargetUrl, newFp, tenantId, chatbotId],
      );
    }
  } else {
    sourceChanged = true;
    await pool.execute(
      `INSERT INTO chatbot_crawl_states
        (tenant_id, chatbot_id, website_url, source_fingerprint, last_check_status, active_source_fingerprint)
       VALUES (?, ?, ?, ?, 'RECONFIGURING', NULL)`,
      [tenantId, chatbotId, newTargetUrl, newFp],
    );
  }

  if (sourceChanged && !config?.customizedSuggestedQuestions) {
    const [[row]] = await pool.execute(
      "SELECT config_json, published_config_json FROM chatbots WHERE id = ? AND tenant_id = ? LIMIT 1",
      [chatbotId, tenantId],
    );
    if (row) {
      const cfg = parseJson(row.config_json, {});
      const pubCfg = parseJson(row.published_config_json, {});
      if (cfg) {
        cfg.suggestedQuestions = [];
        cfg.autoGeneratedQuestions = false;
      }
      if (pubCfg) {
        pubCfg.suggestedQuestions = [];
        pubCfg.autoGeneratedQuestions = false;
      }
      await pool.execute(
        "UPDATE chatbots SET config_json = ?, published_config_json = ? WHERE id = ? AND tenant_id = ?",
        [
          cfg ? JSON.stringify(cfg) : null,
          pubCfg ? JSON.stringify(pubCfg) : null,
          chatbotId,
          tenantId,
        ],
      );
    }
  }
}

export async function saveChatbotBuilderDraft({ id, tenantId, name, status, config }) {
  const chatbot = await getChatbotOrThrow(id, tenantId);
  const normalizedName = name.trim();
  try {
    await pool.execute(
      `UPDATE chatbots
          SET name = ?, status = ?, config_json = ?
        WHERE id = ? AND tenant_id = ?`,
      [normalizedName, status.toUpperCase(), JSON.stringify(config), chatbot.id, tenantId],
    );
    await handlePotentialSourceSwitch({ tenantId, chatbotId: chatbot.id, config });
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") {
      throw new HttpError(409, "A chatbot with this name already exists in your workspace.");
    }
    throw error;
  }
  return getChatbotBuilder(id, tenantId);
}

export async function publishChatbotBuilder({ id, tenantId, userId, name, status, config, changes }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const chatbot = await getChatbotOrThrow(id, tenantId, connection);
    const [[latest]] = await connection.execute(
      "SELECT COALESCE(MAX(version_number), 0) AS latestVersion FROM chatbot_versions WHERE chatbot_id = ? AND tenant_id = ? FOR UPDATE",
      [chatbot.id, tenantId],
    );
    const version = Number(latest.latestVersion) + 1;
    await connection.execute(
      `UPDATE chatbots
          SET name = ?, status = ?, config_json = ?, published_config_json = ?
        WHERE id = ? AND tenant_id = ?`,
      [name.trim(), status.toUpperCase(), JSON.stringify(config), JSON.stringify(config), chatbot.id, tenantId],
    );
    await connection.execute(
      `INSERT INTO chatbot_versions
        (tenant_id, chatbot_id, version_number, config_json, changes_json, published_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [tenantId, chatbot.id, version, JSON.stringify(config), JSON.stringify(changes), userId],
    );
    await connection.commit();
    await handlePotentialSourceSwitch({ tenantId, chatbotId: chatbot.id, config });
    return getChatbotBuilder(id, tenantId);
  } catch (error) {
    await connection.rollback();
    if (error?.code === "ER_DUP_ENTRY") {
      throw new HttpError(409, "A chatbot with this name already exists in your workspace.");
    }
    throw error;
  } finally {
    connection.release();
  }
}

const publicIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeText(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function safePublishedConfig(row) {
  const config = parseJson(row.published_config_json, {});
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const suggestions = Array.isArray(config.suggestedQuestions)
    ? config.suggestedQuestions
      .map((item) => (typeof item === "string" ? item : item?.text))
      .filter((item) => typeof item === "string" && item.trim())
      .slice(0, 5)
      .map((item) => item.trim().slice(0, 160))
    : [];
  const logo = typeof config.logo === "string" && config.logo.length <= 5_000_000 ? config.logo : "";
  const chatTypes = config.chatTypes && typeof config.chatTypes === "object"
    ? {
      enabled: config.chatTypes.enabled !== false,
      text: Boolean(config.chatTypes.text),
      voice: Boolean(config.chatTypes.voice),
      call: Boolean(config.chatTypes.call),
    }
    : undefined;
  const leadCapture = config.leadCapture && typeof config.leadCapture === "object"
    ? {
      enabled: config.leadCapture.enabled !== false,
      fields: Array.isArray(config.leadCapture.fields)
        ? config.leadCapture.fields
          .slice(0, 5)
          .map((field, index) => ({
            id: safeText(field?.id, `field-${index}`),
            label: safeText(field?.label, "Information"),
            type: safeText(field?.type, "custom"),
            required: field?.required === true,
          }))
          .filter((field) => field.id && field.label)
        : [],
      afterMessage: safeText(config.leadCapture.afterMessage, "Great! How would you like to connect with us?"),
    }
    : undefined;
  return {
    name: safeText(config.name, row.name),
    description: safeText(row.description),
    tagline: safeText(config.tagline),
    onlineText: safeText(config.onlineText, "Online"),
    primaryColor: safeText(config.primaryColor, "#2563eb"),
    theme: ["light", "dark", "auto"].includes(config.theme) ? config.theme : "light",
    position: safeText(config.position, "bottom-right"),
    widgetSize: safeText(config.widgetSize, "normal"),
    borderRadius: Number.isFinite(Number(config.borderRadius)) ? Math.min(48, Math.max(0, Number(config.borderRadius))) : 12,
    shadow: config.shadow !== false,
    logo,
    welcomeMessage: safeText(config.welcomeMessage, "Hi there! How can I help you today?"),
    showQuestions: config.showQuestions !== false,
    suggestedQuestions: suggestions,
    chatTypes,
    leadCapture,
  };
}

async function getPublishedChatbotByPublicId(publicId) {
  if (!publicIdPattern.test(publicId || "")) throw new HttpError(404, "Published chatbot not found.");
  const [rows] = await pool.execute(
    `SELECT id, public_id, tenant_id, name, description, status, channels_json, published_config_json
       FROM chatbots
      WHERE public_id = ? AND status = 'ACTIVE' AND published_config_json IS NOT NULL
      LIMIT 1`,
    [publicId],
  );
  if (!rows.length) throw new HttpError(404, "Published chatbot not found.");
  const config = safePublishedConfig(rows[0]);
  if (!config) throw new HttpError(404, "Published chatbot not found.");
  return { row: rows[0], config, providerConfig: parseJson(rows[0].published_config_json, {}) };
}

export async function getPublicWidgetConfig(publicId, visitorId, conversationId = null) {
  const { row, config, providerConfig } = await getPublishedChatbotByPublicId(publicId);
  const validatedVisitor = visitorId ? validateVisitorId(visitorId) : null;
  const historyResult = validatedVisitor
    ? await getConversationHistory({ chatbot: row, visitorId: validatedVisitor, conversationId, limit: 50 })
    : { history: [], conversation: null };
  const lead = validatedVisitor
    ? await findPublicLead(row, validatedVisitor)
    : null;

  let leadInfo = null;
  if (lead) {
    const fields = parseJson(lead.fields_json, {});
    const leadPhone = fields.phone || fields.mobile || fields.phoneNumber || "";
    const leadName = fields.name || fields.fullName || "";
    leadInfo = { phone: leadPhone, name: leadName };
  }

  // Ensure stale previous-source suggestions are never served if source is reconfiguring or not yet active
  const [crawlStates] = await pool.execute(
    `SELECT source_fingerprint, active_source_fingerprint, last_check_status
       FROM chatbot_crawl_states
      WHERE tenant_id = ? AND chatbot_id = ? LIMIT 1`,
    [row.tenant_id, row.id],
  );
  const crawlState = crawlStates[0];
  const isReconfiguring = crawlState?.last_check_status === "RECONFIGURING";
  const hasActiveSource = Boolean(
    crawlState?.active_source_fingerprint &&
    crawlState?.source_fingerprint &&
    crawlState.active_source_fingerprint === crawlState.source_fingerprint
  );

  if ((isReconfiguring || !hasActiveSource) && !providerConfig?.customizedSuggestedQuestions) {
    config.suggestedQuestions = [];
  }

  return {
    publicId: row.public_id,
    chatbot: {
      name: row.name,
      description: row.description,
      channels: parseChannels(row.channels_json),
    },
    config,
    sourceGenerationId: hasActiveSource ? crawlState.active_source_fingerprint : null,
    conversationId: historyResult.conversation?.public_id || null,
    history: historyResult.history,
    leadCaptured: Boolean(lead),
    leadInfo,
  };
}

async function findPublicLead(chatbot, visitorId) {
  const [rows] = await pool.execute(
    `SELECT id, public_id, fields_json, status, created_at, updated_at
       FROM leads
      WHERE tenant_id = ? AND chatbot_id = ? AND chatbot_public_id = ? AND visitor_id = ?
      LIMIT 1`,
    [chatbot.tenant_id, chatbot.id, chatbot.public_id, visitorId],
  );
  return rows[0] || null;
}

export async function savePublicLead({ publicId, visitorId, fields }) {
  const { row, config } = await getPublishedChatbotByPublicId(publicId);
  const visitor = validateVisitorId(visitorId);
  const leadConfig = config.leadCapture;
  if (!leadConfig?.enabled || !leadConfig.fields.length) {
    return { leadCaptured: true };
  }

  const normalizedFields = {};
  for (const field of leadConfig.fields) {
    const value = typeof fields?.[field.id] === "string" ? fields[field.id].trim() : "";
    if (field.required && !value) {
      throw new HttpError(422, `${field.label} is required.`, { [field.id]: `${field.label} is required.` });
    }
    if (value && field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new HttpError(422, `Please enter a valid ${field.label}.`, { [field.id]: `Please enter a valid ${field.label}.` });
    }
    if (value && field.type === "phone" && !/^\+?[0-9()\-\s]{7,24}$/.test(value)) {
      throw new HttpError(422, `Please enter a valid ${field.label}.`, { [field.id]: `Please enter a valid ${field.label}.` });
    }
    if (value && field.type === "name" && value.length < 2) {
      throw new HttpError(422, `Please enter a valid ${field.label}.`, { [field.id]: `Please enter a valid ${field.label}.` });
    }
    normalizedFields[field.id] = value;
  }
  const leadPublicId = randomUUID();
  await pool.execute(
    `INSERT INTO leads
      (public_id, tenant_id, chatbot_id, chatbot_public_id, visitor_id, source, fields_json)
     VALUES (?, ?, ?, ?, ?, 'website_widget', ?)
     ON DUPLICATE KEY UPDATE fields_json = VALUES(fields_json), updated_at = CURRENT_TIMESTAMP`,
    [leadPublicId, row.tenant_id, row.id, row.public_id, visitor, JSON.stringify(normalizedFields)],
  );

  notifyAdminsOfTenant({
    tenantId: row.tenant_id,
    type: "NEW_LEAD",
    title: "New Student Lead Received",
    message: `A new student lead (${normalizedFields.name || normalizedFields.fullName || "Website Visitor"}) was captured by chatbot "${row.name}".`,
    module: "Leads",
    entityType: "lead",
    entityId: leadPublicId,
    priority: "INFO",
  }).catch(() => { });

  return { leadCaptured: true };
}

export async function sendPublicWidgetMessage({ publicId, message, text: textParam, visitorId, conversationId = null }) {
  const { row, config, providerConfig } = await getPublishedChatbotByPublicId(publicId);
  const visitor = validateVisitorId(visitorId);
  if (config.leadCapture?.enabled && config.leadCapture.fields.length && !(await findPublicLead(row, visitor))) {
    throw new HttpError(409, "Please complete lead capture before starting the conversation.");
  }
  if (config.chatTypes && config.chatTypes.text === false && config.chatTypes.voice === false) {
    throw new HttpError(409, "Chat is not enabled for this chatbot.");
  }
  const text = String(message !== undefined ? message : textParam || "").trim();
  if (!text) {
    throw new HttpError(422, "Message content cannot be empty.");
  }
  // Check if website knowledge is currently reconfiguring or not yet active
  const [crawlStates] = await pool.execute(
    `SELECT active_source_fingerprint, source_fingerprint, last_check_status, website_url
       FROM chatbot_crawl_states
      WHERE tenant_id = ? AND chatbot_id = ? LIMIT 1`,
    [row.tenant_id, row.id],
  );
  const crawlState = crawlStates[0];
  const isReconfiguring = crawlState?.last_check_status === "RECONFIGURING";
  const hasActiveSource = Boolean(
    crawlState?.active_source_fingerprint &&
    crawlState?.source_fingerprint &&
    crawlState.active_source_fingerprint === crawlState.source_fingerprint
  );
  const currentFp = crawlState?.active_source_fingerprint || crawlState?.source_fingerprint || null;

  const conversation = await saveUserMessage({
    chatbot: row,
    visitorId: visitor,
    conversationPublicId: conversationId,
    content: text,
    metadata: currentFp ? { source_fingerprint: currentFp } : null,
  });
  const history = await getConversationContext({
    chatbot: row,
    conversationId: conversation.id,
    sourceFingerprint: currentFp,
  });

  if (isReconfiguring) {
    const politeNotice = "The website knowledge for this chatbot is currently being configured and indexed. Please check back in a few moments, or feel free to ask a general question.";
    await saveAssistantMessage({
      chatbot: row,
      conversationId: conversation.id,
      content: politeNotice,
      metadata: currentFp ? { source_fingerprint: currentFp } : null,
    });
    return {
      reply: politeNotice,
      intent: "SYSTEM_NOTIFICATION",
      conversationId: conversation.public_id,
      suggestions: [],
      followUpQuestions: [],
    };
  }

  let generated;
  let excerpts = [];
  if (!isGeminiConfigured()) {
    throw new HttpError(503, "Gemini API key is not configured on the server. Please configure GEMINI_API_KEY in backend environment.");
  }

  try {
    excerpts = await searchKnowledgeExcerpts({
      tenantId: row.tenant_id,
      chatbotId: row.id,
      query: text,
      maxExcerpts: 4,
      maxTotalWords: 2000,
    });

    let siteTopics = [];
    if (excerpts.length === 0 && currentFp) {
      try {
        const [topPages] = await pool.query(
          `SELECT title FROM chatbot_knowledge_pages
            WHERE tenant_id = ? AND chatbot_id = ? AND status = 'INDEXED' AND source_fingerprint = ?
            ORDER BY id ASC LIMIT 5`,
          [row.tenant_id, row.id, currentFp],
        );
        siteTopics = topPages.map((p) => p.title).filter(Boolean);
      } catch { }
    }

    generated = await generateGroundedResponse({
      chatbotName: providerConfig.name || config.name || row.name,
      personality: config.personality || providerConfig.personality || "Helpful and Professional",
      language: config.language || providerConfig.language || "English",
      excerpts,
      history,
      userQuestion: text,
      siteTopics,
      extractedConcepts: excerpts.extractedConcepts || [],
    });
  } catch (aiError) {
    console.error("[ChatbotService] AI response generation failed:", aiError.message);
    throw new HttpError(500, aiError.message || "Failed to generate AI response.");
  }

  const baseAnswer = (generated.answer || generated.reply || "").trim();
  const rawFollowUpPrompt = typeof generated.followUpPrompt === "string" ? generated.followUpPrompt.trim() : "";
  const rawFollowUps = Array.isArray(generated.followUpQuestions) ? generated.followUpQuestions : [];

  // Grounding check: verify if the answer is a fallback (information not available / out of scope)
  const isFallbackAnswer = !excerpts.length ||
    /not available on (the|our|this) (official )?website/i.test(baseAnswer) ||
    /not available in the (provided|available|current|official)?\s*(website|excerpt)/i.test(baseAnswer) ||
    /not found on (the|our|this) (official )?website/i.test(baseAnswer) ||
    /not mentioned in the (official )?website/i.test(baseAnswer) ||
    /does not contain (information|details)/i.test(baseAnswer) ||
    /could not find (any )?(information|details)/i.test(baseAnswer) ||
    /couldn't find (any )?(information|details)/i.test(baseAnswer) ||
    /specific details (about .* )?are not available/i.test(baseAnswer);

  const excerptCorpus = (excerpts.map((e) => `${e.title || ""} ${e.text || ""}`).join(" ") + " " + baseAnswer).toLowerCase();

  // Validate follow-up prompt
  let validFollowUpPrompt = rawFollowUpPrompt;
  if (isFallbackAnswer) {
    // If fallback, ensure the follow-up prompt does not mention unsupported entities from the user's query
    const queryTokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 3);
    const unsupportedQueryTokens = queryTokens.filter((w) => !excerptCorpus.includes(w));
    if (unsupportedQueryTokens.some((w) => validFollowUpPrompt.toLowerCase().includes(w))) {
      validFollowUpPrompt = "";
    }
  } else if (validFollowUpPrompt && excerpts.length > 0) {
    const promptWords = validFollowUpPrompt.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 3);
    const isGrounded = promptWords.some((w) => excerptCorpus.includes(w));
    if (!isGrounded) {
      validFollowUpPrompt = "";
    }
  }

  // Contextual suggestions for this turn:
  // For supported answers, filter suggestions to ensure strict grounding in retrieved excerpts and answer.
  let activeTurnSuggestions = [];
  if (!isFallbackAnswer && rawFollowUps.length > 0 && excerpts.length > 0) {
    activeTurnSuggestions = rawFollowUps.filter((q) => {
      const trimmed = typeof q === "string" ? q.trim() : "";
      if (trimmed.length < 3 || trimmed.length > 80) return false;
      const words = trimmed.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 2);
      return words.length > 0 && words.some((w) => excerptCorpus.includes(w));
    }).slice(0, 3);
  }

  // If fallback/out-of-scope, or if we have fewer than 3 suggestions,
  // derive safe suggestions strictly from the CURRENT active source topic inventory.
  // NEVER fall back to previous suggestions, old website suggestions, or config.suggestedQuestions.
  if (activeTurnSuggestions.length < 3 && hasActiveSource && currentFp) {
    const fallbackTopics = await getCurrentSourceTopicInventory({
      tenantId: row.tenant_id,
      chatbotId: row.id,
      sourceFingerprint: currentFp,
      limit: 3 - activeTurnSuggestions.length,
    });
    for (const topic of fallbackTopics) {
      if (!activeTurnSuggestions.some((s) => s.toLowerCase() === topic.toLowerCase())) {
        activeTurnSuggestions.push(topic);
      }
      if (activeTurnSuggestions.length >= 3) break;
    }
  }

  // For out-of-scope/fallback answers, if follow-up prompt was empty or invalidated, offer verified topics from current active source
  if (isFallbackAnswer && !validFollowUpPrompt && activeTurnSuggestions.length > 0) {
    const topicKeywords = activeTurnSuggestions
      .map((q) => q.replace(/^What (is|are)\s+/i, "").replace(/\?$/, "").trim())
      .filter(Boolean);
    if (topicKeywords.length > 0) {
      validFollowUpPrompt = `Would you like to explore topics available on this website, such as ${topicKeywords.slice(0, 3).join(", ")}?`;
    }
  }

  const combinedReply = validFollowUpPrompt
    ? `${baseAnswer}\n\n${validFollowUpPrompt}`
    : baseAnswer;

  const turnId = `turn-${Date.now()}-${randomUUID().slice(0, 8)}`;

  await saveAssistantMessage({
    chatbot: row,
    conversationId: conversation.id,
    content: combinedReply,
    metadata: {
      ...(currentFp ? { source_fingerprint: currentFp } : {}),
      answer: baseAnswer,
      follow_up_prompt: validFollowUpPrompt,
      suggestions: activeTurnSuggestions,
      turn_id: turnId,
    },
  });

  return {
    reply: combinedReply,
    answer: baseAnswer,
    followUpPrompt: validFollowUpPrompt,
    intent: generated.intent,
    conversationId: conversation.public_id,
    turnId,
    sourceGenerationId: currentFp || null,
    suggestions: config.showQuestions !== false ? activeTurnSuggestions : [],
    followUpQuestions: config.showQuestions !== false ? activeTurnSuggestions : [],
  };
}

export async function initiatePublicWidgetCall({ publicId, visitorId, phone, name }) {
  const { row, config } = await getPublishedChatbotByPublicId(publicId);
  const visitor = validateVisitorId(visitorId);

  if (config.chatTypes && config.chatTypes.call === false) {
    throw new HttpError(409, "Call Chat is not enabled for this chatbot.");
  }

  let lead = await findPublicLead(row, visitor);
  const existingFields = lead ? parseJson(lead.fields_json, {}) : {};
  const requestedPhone = String(phone || existingFields.phone || existingFields.mobile || existingFields.phoneNumber || "").trim();

  if (!requestedPhone) {
    throw new HttpError(422, "Phone number is required to request a call.", { phone: "Phone number is required." });
  }

  if (!/^\+?[0-9()\-\s]{7,24}$/.test(requestedPhone)) {
    throw new HttpError(422, "Please enter a valid phone number.", { phone: "Please enter a valid phone number." });
  }

  const cleanDigits = requestedPhone.replace(/[^0-9+]/g, "");
  if (cleanDigits.length < 7 || cleanDigits.length > 18) {
    throw new HttpError(422, "Please enter a valid phone number with 7 to 15 digits.", { phone: "Please enter a valid phone number." });
  }

  const updatedFields = {
    ...existingFields,
    phone: requestedPhone,
    ...(name?.trim() ? { name: name.trim() } : {}),
  };

  const leadPublicId = lead?.public_id || randomUUID();
  const [leadResult] = await pool.execute(
    `INSERT INTO leads
      (public_id, tenant_id, chatbot_id, chatbot_public_id, visitor_id, source, fields_json)
     VALUES (?, ?, ?, ?, ?, 'website_widget', ?)
     ON DUPLICATE KEY UPDATE fields_json = VALUES(fields_json), updated_at = CURRENT_TIMESTAMP`,
    [leadPublicId, row.tenant_id, row.id, row.public_id, visitor, JSON.stringify(updatedFields)],
  );

  let currentLeadId = lead?.id;
  if (!currentLeadId) {
    const updatedLead = await findPublicLead(row, visitor);
    currentLeadId = updatedLead?.id || leadResult.insertId;
  }

  // Duplicate Protection: check for recently initiated call session for this visitor & chatbot within last 5 minutes
  const [recentCalls] = await pool.execute(
    `SELECT id, public_id, status, phone, provider_call_id, created_at
       FROM calls
      WHERE tenant_id = ? AND chatbot_id = ? AND visitor_id = ?
        AND status IN ('INITIATED', 'PENDING', 'SCHEDULED', 'RINGING', 'IN_PROGRESS')
        AND created_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
      ORDER BY created_at DESC
      LIMIT 1`,
    [row.tenant_id, row.id, visitor],
  );

  if (recentCalls.length > 0) {
    const existingCall = recentCalls[0];
    return {
      callId: existingCall.public_id,
      providerCallId: existingCall.provider_call_id || null,
      status: existingCall.status,
      phone: existingCall.phone || requestedPhone,
      createdAt: existingCall.created_at,
      message: "A call request is already in progress. Our AI counsellor will connect with you shortly.",
      isExisting: true,
    };
  }

  const callPublicId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  const callDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const formattedHours = hours % 12 || 12;
  const callTime = `${String(formattedHours).padStart(2, "0")}:${minutes} ${ampm}`;

  // Execute real Exotel Outbound Call
  let exotelResult = null;
  try {
    exotelResult = await createExotelOutboundCall({
      toPhone: requestedPhone,
      customData: {
        customField: JSON.stringify({ chatbotId: row.id, leadId: currentLeadId, publicId: callPublicId }),
      },
    });
  } catch (exotelError) {
    // Record failure in database for auditing
    await pool.execute(
      `INSERT INTO calls
        (public_id, tenant_id, chatbot_id, lead_id, counsellor_id, visitor_id, phone, direction, call_date, call_time, duration_seconds, status, outcome, notes)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 'OUTBOUND', ?, ?, 0, 'FAILED', 'Exotel Initiation Failed', ?)`,
      [callPublicId, row.tenant_id, row.id, currentLeadId, visitor, requestedPhone, callDate, callTime, exotelError.message || "Failed"],
    );
    throw exotelError;
  }

  const callSid = exotelResult.callSid;

  await pool.execute(
    `INSERT INTO calls
      (public_id, tenant_id, chatbot_id, lead_id, counsellor_id, visitor_id, phone, direction, call_date, call_time, duration_seconds, status, outcome, notes, provider_call_id)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'OUTBOUND', ?, ?, 0, 'INITIATED', 'Exotel Outbound Call Initiated', ?, ?)`,
    [callPublicId, row.tenant_id, row.id, currentLeadId, visitor, requestedPhone, callDate, callTime, `Exotel Call SID: ${callSid}`, callSid],
  );

  await pool.execute(
    "UPDATE leads SET last_contacted_at = NOW(), updated_at = NOW() WHERE id = ? AND tenant_id = ?",
    [currentLeadId, row.tenant_id],
  );

  return {
    callId: callPublicId,
    providerCallId: callSid,
    status: "INITIATED",
    phone: requestedPhone,
    createdAt: now.toISOString(),
    message: "Outbound call initiated via Exotel. Your phone will ring shortly.",
    isExisting: false,
  };
}


export async function getPublicWidgetCallStatus({ publicId, callId, visitorId }) {
  const { row } = await getPublishedChatbotByPublicId(publicId);
  const visitor = validateVisitorId(visitorId);

  const [calls] = await pool.execute(
    `SELECT public_id, status, phone, duration_seconds, outcome, created_at
       FROM calls
      WHERE public_id = ? AND tenant_id = ? AND chatbot_id = ? AND visitor_id = ?
      LIMIT 1`,
    [callId, row.tenant_id, row.id, visitor],
  );

  if (!calls.length) {
    throw new HttpError(404, "Call session not found.");
  }

  const call = calls[0];
  return {
    callId: call.public_id,
    status: call.status,
    phone: call.phone,
    durationSeconds: call.duration_seconds,
    outcome: call.outcome,
    createdAt: call.created_at,
  };
}

export async function crawlChatbotWebsite({ id, tenantId, websiteUrl, maxPages, crawlLimit }) {
  const chatbot = await getChatbotOrThrow(id, tenantId);
  const config = parseJson(chatbot.config_json, {}) || {};
  const targetUrl = String(websiteUrl || config.websiteUrl || config.sitemapUrl || "").trim();

  if (!targetUrl) {
    throw new HttpError(422, "Please provide a valid website URL or sitemap URL to crawl.");
  }

  const { sanitizeCrawlLimit } = await import("./crawlerService.js");
  const limit = sanitizeCrawlLimit(maxPages || crawlLimit || config.crawlLimit || config.maxPages);

  const { computeSourceFingerprint } = await import("./chatbotKnowledgeService.js");
  const newFp = computeSourceFingerprint(targetUrl);

  const [existingStates] = await pool.execute(
    "SELECT source_fingerprint FROM chatbot_crawl_states WHERE tenant_id = ? AND chatbot_id = ? LIMIT 1",
    [tenantId, chatbot.id],
  );
  if (existingStates.length > 0 && existingStates[0].source_fingerprint && existingStates[0].source_fingerprint !== newFp) {
    await pool.execute(
      `UPDATE chatbot_crawl_states
          SET website_url = ?,
              source_fingerprint = ?,
              last_check_status = 'RECONFIGURING',
              active_source_fingerprint = NULL
        WHERE tenant_id = ? AND chatbot_id = ?`,
      [targetUrl, newFp, tenantId, chatbot.id],
    );
  }

  // Update target URL and crawl limits in chatbot config
  config.websiteUrl = targetUrl;
  config.crawlLimit = limit;
  config.maxPages = limit;
  await pool.execute(
    "UPDATE chatbots SET config_json = ? WHERE id = ? AND tenant_id = ?",
    [JSON.stringify(config), chatbot.id, tenantId],
  );

  // Ensure persistent state record exists
  const { getOrCreateCrawlState, createCrawlJob, executeCrawlJob, getCrawlState } = await import("./crawlJobService.js");
  await getOrCreateCrawlState({ tenantId, chatbotId: chatbot.id, websiteUrl: targetUrl });

  // Create manual crawl job
  const job = await createCrawlJob({
    tenantId,
    chatbotId: chatbot.id,
    jobType: "MANUAL",
  });

  // For crawls larger than synchronous threshold (> 50 pages), process asynchronously via background worker
  if (limit > 50) {
    await pool.execute(
      `UPDATE chatbot_crawl_states
          SET last_check_status = 'IN_PROGRESS'
        WHERE tenant_id = ? AND chatbot_id = ?`,
      [tenantId, chatbot.id],
    );

    const { processPendingJobs } = await import("./crawlSchedulerService.js");
    setImmediate(() => {
      processPendingJobs().catch((err) => console.error("[CrawlWorker] Async execution error:", err));
    });

    const currentState = await getCrawlState({ tenantId, chatbotId: chatbot.id });
    return {
      success: true,
      status: "IN_PROGRESS",
      isAsync: true,
      jobId: job.id,
      maxPages: limit,
      crawlLimit: limit,
      indexedCount: currentState?.total_pages_indexed || 0,
      discoveredCount: currentState?.pages_discovered || 0,
      message: `Crawl job #${job.id} started in the background (limit: ${limit} pages).`,
    };
  }

  // Synchronous execution for small crawls (<= 50 pages)
  const result = await executeCrawlJob(job);
  const currentState = await getCrawlState({ tenantId, chatbotId: chatbot.id });

  if (!result.success && result.indexedCount === 0) {
    throw new HttpError(422, result.error || "No readable pages could be indexed from this website URL. Please verify the URL and try again.");
  }

  return {
    success: result.success,
    status: result.status,
    indexedCount: result.indexedCount,
    discoveredCount: result.discoveredCount,
    totalDiscoveredCount: result.totalDiscoveredCount,
    processedCount: result.processedCount,
    newCount: result.newCount,
    changedCount: result.changedCount,
    unchangedCount: result.unchangedCount,
    removedCount: result.removedCount,
    failedCount: result.failedCount,
    isPartial: result.isPartial,
    maxPages: limit,
    crawlLimit: limit,
    lastCrawledAt: currentState?.last_successful_crawl_at || new Date().toISOString(),
    nextCheckAt: currentState?.next_check_at || null,
    error: result.error,
  };
}

export async function getChatbotCrawlStatus({ id, tenantId }) {
  const chatbot = await getChatbotOrThrow(id, tenantId);
  const { getCrawlState, getLatestCrawlJob } = await import("./crawlJobService.js");
  const state = await getCrawlState({ tenantId, chatbotId: chatbot.id });
  const latestJob = await getLatestCrawlJob({ tenantId, chatbotId: chatbot.id });
  const activeFp = state?.active_source_fingerprint;
  const isReconfiguring = state?.last_check_status === "RECONFIGURING";

  const isJobActive = latestJob && (latestJob.status === "PENDING" || latestJob.status === "RUNNING");

  const stats = await getChatbotKnowledgeStats({
    tenantId,
    chatbotId: chatbot.id,
    sourceFingerprint: activeFp || undefined,
  });

  const totalIndexed = isReconfiguring ? 0 : (activeFp ? stats.totalPages : 0);
  const truthfulStatus = isJobActive
    ? "IN_PROGRESS"
    : state?.last_check_status || (totalIndexed > 0 ? "COMPLETED" : "PENDING");

  const pagesDiscovered = Math.max(
    state?.pages_discovered || 0,
    totalIndexed,
    latestJob?.pages_discovered || 0,
  );
  const pagesProcessed = Math.max(
    (latestJob?.pages_new || 0) + (latestJob?.pages_changed || 0) + (latestJob?.pages_unchanged || 0) + (latestJob?.pages_failed || 0),
    (state?.pages_changed || 0) + (state?.pages_unchanged || 0),
    totalIndexed,
  );
  const pagesFailed = latestJob?.pages_failed || 0;

  return {
    totalPages: totalIndexed,
    indexedCount: totalIndexed,
    inactivePages: stats.inactivePages,
    lastCrawledAt: stats.lastCrawledAt || state?.last_successful_crawl_at || null,
    lastCheckedAt: stats.lastCheckedAt || state?.last_checked_at || null,
    nextCheckAt: state?.next_check_at || null,
    status: truthfulStatus,
    pagesDiscovered,
    pagesProcessed,
    pagesIndexed: totalIndexed,
    pagesNew: latestJob?.pages_new ?? state?.pages_discovered ?? 0,
    pagesChanged: state?.pages_changed || 0,
    pagesUnchanged: state?.pages_unchanged || 0,
    pagesRemoved: state?.pages_removed || 0,
    pagesFailed,
    lastErrorSummary: isJobActive ? null : (state?.last_error_summary || null),
    jobId: latestJob?.id || null,
  };
}



