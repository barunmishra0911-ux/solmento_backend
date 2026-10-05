import { z } from "zod";

export const campaignStatusEnum = z.enum([
  "DRAFT",
  "SCHEDULED",
  "SENDING",
  "COMPLETED",
  "CANCELLED",
]);

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1, "Campaign name is required.").max(160, "Campaign name is too long."),
  description: z.string().trim().optional().nullable(),
  status: campaignStatusEnum.optional().default("DRAFT"),
  audienceConfig: z.record(z.any()).optional().nullable(),
  messageConfig: z.record(z.any()).optional().nullable(),
  scheduleType: z.string().trim().optional().nullable().default("IMMEDIATE"),
  scheduledAt: z.string().trim().optional().nullable(),
});

export const updateCampaignSchema = z.object({
  name: z.string().trim().min(1, "Campaign name cannot be empty.").max(160, "Campaign name is too long.").optional(),
  description: z.string().trim().optional().nullable(),
  status: campaignStatusEnum.optional(),
  audienceConfig: z.record(z.any()).optional().nullable(),
  messageConfig: z.record(z.any()).optional().nullable(),
  scheduleType: z.string().trim().optional().nullable(),
  scheduledAt: z.string().trim().optional().nullable(),
});
