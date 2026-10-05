import { pool } from "../config/database.js";
import { HttpError } from "../utils/http.js";

function parseJsonSafe(val, fallback = null) {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

export function mapCampaign(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    createdByUserId: row.created_by_user_id
      ? String(row.created_by_user_id)
      : null,
    name: row.name,
    description: row.description || "",
    status: row.status,
    audienceConfig: parseJsonSafe(row.audience_config_json, {}),
    messageConfig: parseJsonSafe(row.message_config_json, {}),
    scheduleType: row.schedule_type || "IMMEDIATE",
    scheduledAt: row.scheduled_at
      ? new Date(row.scheduled_at).toISOString()
      : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export async function listCampaigns({ tenantId, status = null }) {
  let query = `
    SELECT id, tenant_id, created_by_user_id, name, description, status,
           audience_config_json, message_config_json, schedule_type, scheduled_at,
           created_at, updated_at
      FROM campaigns
     WHERE tenant_id = ? AND deleted_at IS NULL
  `;
  const params = [tenantId];

  if (status) {
    query += ` AND status = ?`;
    params.push(String(status).toUpperCase());
  }

  query += ` ORDER BY id DESC`;

  const [rows] = await pool.execute(query, params);
  return rows.map(mapCampaign);
}

export async function getCampaign(id, tenantId) {
  const [rows] = await pool.execute(
    `SELECT id, tenant_id, created_by_user_id, name, description, status,
            audience_config_json, message_config_json, schedule_type, scheduled_at,
            created_at, updated_at
       FROM campaigns
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [id, tenantId],
  );

  if (rows.length === 0) {
    throw new HttpError(404, "Campaign not found.");
  }

  return mapCampaign(rows[0]);
}

export async function createCampaign({
  tenantId,
  createdByUserId = null,
  name,
  description = null,
  status = "DRAFT",
  audienceConfig = null,
  messageConfig = null,
  scheduleType = "IMMEDIATE",
  scheduledAt = null,
}) {
  const finalStatus = String(status || "DRAFT").toUpperCase();
  const audienceJson = audienceConfig ? JSON.stringify(audienceConfig) : null;
  const messageJson = messageConfig ? JSON.stringify(messageConfig) : null;

  let formattedScheduledAt = null;
  if (scheduledAt) {
    const d = new Date(scheduledAt);
    if (!isNaN(d.getTime())) {
      formattedScheduledAt = d.toISOString().slice(0, 19).replace("T", " ");
    }
  }

  const [res] = await pool.execute(
    `INSERT INTO campaigns
      (tenant_id, created_by_user_id, name, description, status,
       audience_config_json, message_config_json, schedule_type, scheduled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      createdByUserId,
      name,
      description || null,
      finalStatus,
      audienceJson,
      messageJson,
      scheduleType || "IMMEDIATE",
      formattedScheduledAt,
    ],
  );

  return getCampaign(res.insertId, tenantId);
}

export async function updateCampaign(id, tenantId, payload) {
  const existing = await getCampaign(id, tenantId);

  const name = payload.name !== undefined ? payload.name : existing.name;
  const description =
    payload.description !== undefined
      ? payload.description
      : existing.description;
  const status =
    payload.status !== undefined
      ? String(payload.status).toUpperCase()
      : existing.status;
  const audienceConfig =
    payload.audienceConfig !== undefined
      ? payload.audienceConfig
      : existing.audienceConfig;
  const messageConfig =
    payload.messageConfig !== undefined
      ? payload.messageConfig
      : existing.messageConfig;
  const scheduleType =
    payload.scheduleType !== undefined
      ? payload.scheduleType
      : existing.scheduleType;

  let scheduledAt = existing.scheduledAt;
  if (payload.scheduledAt !== undefined) {
    if (payload.scheduledAt) {
      const d = new Date(payload.scheduledAt);
      scheduledAt = !isNaN(d.getTime())
        ? d.toISOString().slice(0, 19).replace("T", " ")
        : null;
    } else {
      scheduledAt = null;
    }
  }

  const audienceJson = audienceConfig ? JSON.stringify(audienceConfig) : null;
  const messageJson = messageConfig ? JSON.stringify(messageConfig) : null;

  await pool.execute(
    `UPDATE campaigns
        SET name = ?,
            description = ?,
            status = ?,
            audience_config_json = ?,
            message_config_json = ?,
            schedule_type = ?,
            scheduled_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
    [
      name,
      description || null,
      status,
      audienceJson,
      messageJson,
      scheduleType || "IMMEDIATE",
      scheduledAt,
      id,
      tenantId,
    ],
  );

  return getCampaign(id, tenantId);
}

export async function deleteCampaign(id, tenantId, actorUserId) {
  await getCampaign(id, tenantId);

  await pool.execute(
    `UPDATE campaigns
        SET deleted_at = CURRENT_TIMESTAMP,
            deleted_by_user_id = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
    [actorUserId || null, id, tenantId],
  );

  return { id: String(id), deleted: true };
}

export async function restoreCampaign(id, tenantId) {
  const [rows] = await pool.execute(
    `SELECT id, tenant_id, created_by_user_id, name, description, status,
            audience_config_json, message_config_json, schedule_type, scheduled_at,
            created_at, updated_at
       FROM campaigns
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NOT NULL
      LIMIT 1`,
    [id, tenantId],
  );

  if (rows.length === 0) {
    throw new HttpError(404, "Deleted campaign not found or already active.");
  }

  await pool.execute(
    `UPDATE campaigns
        SET deleted_at = NULL,
            deleted_by_user_id = NULL
      WHERE id = ? AND tenant_id = ?`,
    [id, tenantId],
  );

  return mapCampaign(rows[0]);
}
