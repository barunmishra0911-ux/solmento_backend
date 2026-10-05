import { HttpError, ok } from "../utils/http.js";
import {
  getPublicWidgetConfig,
  initiatePublicWidgetCall,
  getPublicWidgetCallStatus,
  savePublicLead,
  sendPublicWidgetMessage,
} from "../services/chatbotService.js";
import {
  publicWidgetCallSchema,
  publicWidgetLeadSchema,
  publicWidgetMessageSchema,
} from "../validators/publicWidget.js";

export async function getPublicWidgetConfigById(req, res, next) {
  try {
    return ok(
      res,
      await getPublicWidgetConfig(req.params.publicId, req.query.visitorId, req.query.conversationId),
    );
  } catch (error) {
    return next(error);
  }
}

export async function postPublicWidgetMessage(req, res, next) {
  try {
    const parsed = publicWidgetMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(
        422,
        "Please provide a valid message.",
        parsed.error.flatten().fieldErrors,
      );
    }
    return ok(
      res,
      await sendPublicWidgetMessage({
        publicId: req.params.publicId,
        message: parsed.data.message,
        visitorId: parsed.data.visitorId,
        conversationId: parsed.data.conversationId,
      }),
    );
  } catch (error) {
    return next(error);
  }
}

export async function postPublicWidgetLead(req, res, next) {
  try {
    const parsed = publicWidgetLeadSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(
        422,
        "Please provide valid lead details.",
        parsed.error.flatten().fieldErrors,
      );
    }
    return ok(
      res,
      await savePublicLead({
        publicId: req.params.publicId,
        visitorId: parsed.data.visitorId,
        fields: parsed.data.fields,
      }),
      201,
    );
  } catch (error) {
    return next(error);
  }
}

export async function postPublicWidgetCall(req, res, next) {
  try {
    const parsed = publicWidgetCallSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(
        422,
        "Please provide valid call details.",
        parsed.error.flatten().fieldErrors,
      );
    }
    return ok(
      res,
      await initiatePublicWidgetCall({
        publicId: req.params.publicId,
        visitorId: parsed.data.visitorId,
        phone: parsed.data.phone,
        name: parsed.data.name,
      }),
      201,
    );
  } catch (error) {
    return next(error);
  }
}

export async function getPublicWidgetCallStatusById(req, res, next) {
  try {
    const visitorId = req.query.visitorId;
    if (!visitorId) {
      throw new HttpError(422, "Visitor session is required.");
    }
    return ok(
      res,
      await getPublicWidgetCallStatus({
        publicId: req.params.publicId,
        callId: req.params.callId,
        visitorId,
      }),
    );
  } catch (error) {
    return next(error);
  }
}
