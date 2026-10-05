import { z } from "zod";

export const publicWidgetMessageSchema = z.object({
  message: z.string().refine((value) => value.trim().length > 0, "Message cannot be empty.").max(2_000),
  visitorId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, "Please provide a valid visitor session."),
  conversationId: z.string().trim().max(128).optional(),
}).strict();

export const publicWidgetLeadSchema = z.object({
  fields: z.record(z.string().trim().max(160), z.string().max(2_000)).default({}),
  visitorId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, "Please provide a valid visitor session."),
}).strict();

export const publicWidgetCallSchema = z.object({
  visitorId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, "Please provide a valid visitor session."),
  phone: z.string().trim().max(32).optional(),
  name: z.string().trim().max(160).optional(),
}).strict();

