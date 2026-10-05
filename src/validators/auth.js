import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(6).max(128),
  rememberMe: z.boolean().optional().default(false),
});

const accountFields = {
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
};

export const createAdminSchema = z.object({
  ...accountFields,
  companyName: z.string().trim().min(2).max(160),
});

export const createTeamMemberSchema = z.object({
  ...accountFields,
  role: z.string().trim().min(1).max(80).optional(),
  roleId: z.union([z.string().trim().min(1), z.number()]).optional(),
});

export const createCounsellorSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  profilePhoto: z.string().max(500000).optional().or(z.literal("")),
  employeeId: z.string().trim().max(80).optional(),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().regex(/^\+?[0-9()\-\s]{7,24}$/, "Please enter a valid phone number."),
  department: z.string().trim().min(2).max(120),
  designation: z.string().trim().min(1).max(120),
  password: z.string().min(8, "Password must be at least 8 characters long.").max(128).optional(),
}).strict();

export const updateCounsellorSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  profilePhoto: z.string().max(500000).optional().or(z.literal("")),
  employeeId: z.string().trim().max(80).optional(),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().regex(/^\+?[0-9()\-\s]{7,24}$/, "Please enter a valid phone number."),
  department: z.string().trim().min(2).max(120),
  designation: z.string().trim().min(1).max(120),
  password: z.string().min(8, "Password must be at least 8 characters long.").max(128).optional().or(z.literal("")),
}).strict();

export const createChatbotSchema = z.object({
  name: z.string().trim().min(2).max(50),
  description: z.string().trim().max(200).optional().default(""),
  sitemapUrl: z.string().trim().url().max(500).optional().or(z.literal("")),
  channels: z.array(z.enum(["website", "whatsapp"]))
    .min(1)
    .max(2)
    .transform((channels) => [...new Set(channels)]),
  status: z.enum(["active", "inactive"]).optional().default("inactive"),
  startMode: z.enum(["template", "blank"]).optional().default("template"),
}).strict();

export const chatbotStatusSchema = z.object({
  status: z.enum(["active", "inactive"]),
}).strict();

const chatbotConfigSchema = z.object({}).passthrough().superRefine((config, context) => {
  if (Array.isArray(config.suggestedQuestions) && config.suggestedQuestions.length > 5) {
    context.addIssue({ code: z.ZodIssueCode.too_big, maximum: 5, type: "array", inclusive: true, path: ["suggestedQuestions"], message: "At most 5 suggested questions are allowed." });
  }
  const fields = config.leadCapture?.fields;
  if (Array.isArray(fields) && fields.length > 5) {
    context.addIssue({ code: z.ZodIssueCode.too_big, maximum: 5, type: "array", inclusive: true, path: ["leadCapture", "fields"], message: "At most 5 lead-capture fields are allowed." });
  }
  const chatTypes = config.chatTypes;
  if (chatTypes && typeof chatTypes === "object" && ["text", "voice", "call"].some((key) => key in chatTypes)
    && !["text", "voice", "call"].some((key) => chatTypes[key] === true)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["chatTypes"], message: "Enable at least one chat type." });
  }
});

export const chatbotBuilderDraftSchema = z.object({
  name: z.string().trim().min(2).max(50),
  status: z.enum(["active", "inactive"]),
  config: chatbotConfigSchema,
}).strict();

export const chatbotPublishSchema = chatbotBuilderDraftSchema.extend({
  changes: z.array(z.string().trim().min(1).max(240)).max(30).optional().default([]),
}).strict();

export const listLeadsQuerySchema = z.object({
  search: z.string().max(100).optional().default(""),
  status: z.string().max(32).optional().default(""),
  source: z.string().max(32).optional().default(""),
  counsellorId: z.string().max(64).optional().default(""),
  fromDate: z.string().max(32).optional().default(""),
  toDate: z.string().max(32).optional().default(""),
  startDate: z.string().max(32).optional().default(""),
  endDate: z.string().max(32).optional().default(""),
  period: z.enum(["all", "today", "week", "month"]).optional().default("all"),
  page: z.coerce.number().int().min(1).max(1000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(20),
  sortBy: z.string().max(32).optional().default("created_at"),
  sortOrder: z.enum(["asc", "desc", "ASC", "DESC"]).optional().default("DESC"),
}).strict();

export const assignLeadSchema = z.object({
  leadId: z.string().trim().min(1).max(128),
  counsellorId: z.union([z.string().trim().max(64), z.number(), z.null()]).optional(),
}).strict();

export const assignBulkLeadsSchema = z.object({
  leadIds: z.array(z.string().trim().min(1).max(128)).min(1).max(500),
  counsellorId: z.union([z.string().trim().max(64), z.number(), z.null()]).optional(),
}).strict();

export const registerSchema = z.object({
  companyName: z.string().trim().min(2).max(160),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
  termsAccepted: z.literal(true),
  plan: z.string().trim().max(40).optional().default(""),
});

export const verificationTokenSchema = z.object({ token: z.string().trim().min(32).max(256) });
