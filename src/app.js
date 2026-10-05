import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./config/env.js";
import authRoutes from "./routes/auth.js";
import tenantRoutes from "./routes/tenant.js";
import accountRoutes from "./routes/accounts.js";
import publicWidgetRoutes from "./routes/publicWidget.js";
import campaignRoutes from "./routes/campaignRoutes.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";

export function createApp() {
  const app = express();
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const backendRoot = path.resolve(currentDir, "..");
  const repositoryRoot = path.resolve(currentDir, "../..");
  const allowedOrigins = env.FRONTEND_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use("/widget", cors({ origin: "*", credentials: false, methods: ["GET", "HEAD", "OPTIONS"] }), (req, res, next) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
  });
  app.use("/widget", express.static(path.join(backendRoot, "public", "widget"), { fallthrough: true }));
  app.use("/widget", express.static(path.join(repositoryRoot, "public", "widget"), { fallthrough: true }));
  app.use(express.json({ limit: "5mb" }));
  app.use(cookieParser());
  const publicCors = cors({ origin: "*", credentials: false, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type"] });
  app.use("/api/public", publicCors, publicWidgetRoutes);
  app.use("/api/whatsapp", publicCors, publicWidgetRoutes);
  app.use("/whatsapp", publicCors, publicWidgetRoutes);
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Frontend origin is not allowed."));
    },
    credentials: true,
  }));
  app.get("/api/health", (_req, res) => res.json({ success: true, data: { service: "solmento-ai-backend", status: "ok" } }));
  app.use("/api/campaigns", campaignRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/tenant", tenantRoutes);
  app.use("/api", accountRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
