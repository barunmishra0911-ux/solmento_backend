import { pool } from "../config/database.js";
import { HttpError } from "../utils/http.js";
import { recordAudit } from "./auditService.js";

export const PLATFORM_MODULES = new Set([
  "invoices", "ai-provider-settings", "whatsapp-provider-settings", "voice-provider-settings",
  "platform-users", "platform-roles", "platform-permissions", "announcements", "global-analytics",
  "system-health", "tickets", "ticket-details", "audit-logs", "impersonation",
]);

function ensureModule(module) {
  if (!PLATFORM_MODULES.has(module)) throw new HttpError(404, "Platform module not found.");
}

function mapRecord(row) {
  let payload = row.payload_json;
  if (typeof payload === "string") { try { payload = JSON.parse(payload || "{}"); } catch { payload = {}; } }
  return { id: row.id, module: row.module, title: row.title, status: row.status, payload: payload || {}, createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function listPlatformRecords(module, query = {}) {
  ensureModule(module);
  const search = String(query.search || "").trim();
  const status = String(query.status || "").trim();
  const [rows] = await pool.execute(
    "SELECT id, module, title, status, payload_json, created_at, updated_at FROM platform_records WHERE module = ? AND deleted_at IS NULL AND (? = '' OR title LIKE ?) AND (? = '' OR status = ?) ORDER BY updated_at DESC",
    [module, search, `%${search}%`, status, status],
  );
  return rows.map(mapRecord);
}

export async function createPlatformRecord(module, input, actorUserId, ipAddress) {
  ensureModule(module);
  const title = String(input.title || "").trim();
  if (!title || title.length > 180) throw new HttpError(422, "A title between 1 and 180 characters is required.");
  const status = String(input.status || "ACTIVE").trim().slice(0, 60);
  const [result] = await pool.execute("INSERT INTO platform_records (module, title, status, payload_json, created_by_user_id) VALUES (?, ?, ?, ?, ?)", [module, title, status, JSON.stringify(input.payload || {}), actorUserId]);
  await recordAudit({ actorUserId, action: "PLATFORM_RECORD_CREATED", targetType: module, targetId: result.insertId, ipAddress, metadata: { title, status } });
  const [rows] = await pool.execute("SELECT id, module, title, status, payload_json, created_at, updated_at FROM platform_records WHERE id = ?", [result.insertId]);
  return mapRecord(rows[0]);
}

export async function deletePlatformRecord(module, id, actorUserId, ipAddress) {
  ensureModule(module);
  const [result] = await pool.execute("UPDATE platform_records SET deleted_at = CURRENT_TIMESTAMP, deleted_by_user_id = ? WHERE id = ? AND module = ? AND deleted_at IS NULL", [actorUserId || null, id, module]);
  if (!result.affectedRows) throw new HttpError(404, "Record not found.");
  await recordAudit({ actorUserId, action: "PLATFORM_RECORD_DELETED", targetType: module, targetId: id, ipAddress });
}

export async function restorePlatformRecord(module, id, actorUserId, ipAddress) {
  ensureModule(module);
  const [result] = await pool.execute("UPDATE platform_records SET deleted_at = NULL, deleted_by_user_id = NULL WHERE id = ? AND module = ? AND deleted_at IS NOT NULL", [id, module]);
  if (!result.affectedRows) throw new HttpError(404, "Deleted record not found or already active.");
  await recordAudit({ actorUserId, action: "PLATFORM_RECORD_RESTORED", targetType: module, targetId: id, ipAddress });
  const [rows] = await pool.execute("SELECT id, module, title, status, payload_json, created_at, updated_at FROM platform_records WHERE id = ?", [id]);
  return mapRecord(rows[0]);
}
