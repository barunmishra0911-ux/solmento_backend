import { HttpError, ok } from "../utils/http.js";
import { chatbotBuilderDraftSchema, chatbotPublishSchema, chatbotStatusSchema, createChatbotSchema } from "../validators/auth.js";
import {
  createChatbot,
  crawlChatbotWebsite,
  deleteChatbot,
  duplicateChatbot,
  getChatbot,
  getChatbotBuilder,
  getChatbotCrawlStatus,
  listChatbots,
  publishChatbotBuilder,
  restoreChatbot,
  saveChatbotBuilderDraft,
  updateChatbotStatus,
} from "../services/chatbotService.js";
import { recordAudit } from "../services/auditService.js";

function parseBuilderPayload(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(422, "Please provide valid chatbot builder details.", parsed.error.flatten().fieldErrors);
  }
  const serialized = JSON.stringify(parsed.data.config);
  if (serialized.length > 5_000_000) {
    throw new HttpError(413, "Chatbot configuration is too large.");
  }
  return parsed.data;
}

export async function getChatbots(req, res, next) {
  try {
    return ok(res, { chatbots: await listChatbots(req.auth.tenantId) });
  } catch (error) {
    return next(error);
  }
}

export async function getChatbotById(req, res, next) {
  try {
    return ok(res, { chatbot: await getChatbot(req.params.id, req.auth.tenantId) });
  } catch (error) {
    return next(error);
  }
}

export async function getChatbotBuilderById(req, res, next) {
  try {
    return ok(res, await getChatbotBuilder(req.params.id, req.auth.tenantId));
  } catch (error) {
    return next(error);
  }
}

export async function putChatbotBuilderDraft(req, res, next) {
  try {
    const data = parseBuilderPayload(chatbotBuilderDraftSchema, req.body);
    return ok(res, await saveChatbotBuilderDraft({
      id: req.params.id,
      tenantId: req.auth.tenantId,
      ...data,
    }));
  } catch (error) {
    return next(error);
  }
}

export async function postChatbotBuilderPublish(req, res, next) {
  try {
    const data = parseBuilderPayload(chatbotPublishSchema, req.body);
    return ok(res, await publishChatbotBuilder({
      id: req.params.id,
      tenantId: req.auth.tenantId,
      userId: req.auth.sub,
      ...data,
    }), 201);
  } catch (error) {
    return next(error);
  }
}

export async function postChatbot(req, res, next) {
  try {
    const parsed = createChatbotSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(422, "Please provide valid chatbot details.", parsed.error.flatten().fieldErrors);
    return ok(res, { chatbot: await createChatbot({ ...parsed.data, tenantId: req.auth.tenantId, userId: req.auth.sub }) }, 201);
  } catch (error) {
    return next(error);
  }
}

export async function patchChatbotStatus(req, res, next) {
  try {
    const parsed = chatbotStatusSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(422, "Please choose a valid chatbot status.", parsed.error.flatten().fieldErrors);
    return ok(res, { chatbot: await updateChatbotStatus({ id: req.params.id, tenantId: req.auth.tenantId, status: parsed.data.status }) });
  } catch (error) {
    return next(error);
  }
}

export async function postChatbotDuplicate(req, res, next) {
  try {
    return ok(res, { chatbot: await duplicateChatbot({ id: req.params.id, tenantId: req.auth.tenantId, userId: req.auth.sub }) }, 201);
  } catch (error) {
    return next(error);
  }
}

export async function destroyChatbot(req, res, next) {
  try {
    const chatbot = await deleteChatbot({ id: req.params.id, tenantId: req.auth.tenantId, actorUserId: req.auth.userId });
    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: "Deleted",
      targetType: "Chatbot",
      targetId: req.params.id,
      metadata: {
        userName: req.auth.email,
        userRole: req.auth.role === "ADMIN" ? "Admin" : "Counsellor",
        module: "Chatbots",
        page: "Chatbots",
        details: `Deleted chatbot "${chatbot.name || req.params.id}"`,
        summaryTitle: "Chatbot Deleted",
        summarySubtitle: "Chatbot was removed",
      },
      ipAddress: req.ip,
    });
    return ok(res, { chatbot });
  } catch (error) {
    return next(error);
  }
}

export async function restoreChatbotController(req, res, next) {
  try {
    const chatbot = await restoreChatbot({ id: req.params.id, tenantId: req.auth.tenantId });
    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId,
      action: "Restored",
      targetType: "Chatbot",
      targetId: req.params.id,
      metadata: {
        userName: req.auth.email,
        userRole: req.auth.role === "ADMIN" ? "Admin" : "Counsellor",
        module: "Chatbots",
        page: "Chatbots",
        details: `Restored chatbot "${chatbot.name || req.params.id}"`,
        summaryTitle: "Chatbot Restored",
        summarySubtitle: "Chatbot was restored",
      },
      ipAddress: req.ip,
    });
    return ok(res, { chatbot });
  } catch (error) {
    return next(error);
  }
}

export async function postCrawlChatbotWebsite(req, res, next) {
  try {
    const result = await crawlChatbotWebsite({
      id: req.params.id,
      tenantId: req.auth.tenantId,
      websiteUrl: req.body?.websiteUrl,
      maxPages: req.body?.maxPages || req.body?.crawlLimit,
      crawlLimit: req.body?.crawlLimit || req.body?.maxPages,
    });
    return ok(res, result, 200);
  } catch (error) {
    return next(error);
  }
}

export async function getChatbotCrawlStatusController(req, res, next) {
  try {
    const stats = await getChatbotCrawlStatus({
      id: req.params.id,
      tenantId: req.auth.tenantId,
    });
    return ok(res, stats, 200);
  } catch (error) {
    return next(error);
  }
}

