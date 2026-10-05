import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5000),
  FRONTEND_ORIGINS: z.string().default("http://localhost:5173,http://localhost:5174"),
  MYSQL_HOST: z.string().default("127.0.0.1"),
  MYSQL_PORT: z.coerce.number().int().positive().default(3306),
  MYSQL_DATABASE: z.string().min(1).default("solmento_ai"),
  MYSQL_USER: z.string().min(1).default("root"),
  MYSQL_PASSWORD: z.string().default(""),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must contain at least 32 characters"),
  SUPER_ADMIN_JWT_SECRET: z.string().min(32).optional(),
  JWT_EXPIRES_IN: z.string().default("7d"),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  EXOTEL_ACCOUNT_SID: z.string().optional(),
  EXOTEL_API_KEY: z.string().optional(),
  EXOTEL_API_TOKEN: z.string().optional(),
  EXOTEL_EXOPHONE: z.string().optional(),
  EXOTEL_SUB_DOMAIN: z.string().default("api.exotel.com"),
  EXOTEL_API_BASE_URL: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash"),
  CRAWL_SCHEDULER_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  CRAWL_CHECK_INTERVAL_SEC: z.coerce.number().int().positive().default(60),
  CRAWL_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  CRAWL_LEASE_MINUTES: z.coerce.number().int().positive().default(5),
  CRAWL_DEFAULT_MAX_PAGES: z.coerce.number().int().positive().default(50),
  CRAWL_HARD_CEILING_PAGES: z.coerce.number().int().positive().default(1000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`Invalid backend environment: ${details}`);
}

export const env = {
  ...parsed.data,
  SUPER_ADMIN_JWT_SECRET: parsed.data.SUPER_ADMIN_JWT_SECRET || `${parsed.data.JWT_SECRET}:super-admin-realm`,
};
