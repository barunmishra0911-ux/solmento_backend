import { pool } from "../config/database.js";
import { HttpError } from "../utils/http.js";

function mapNotification(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    recipientUserId: String(row.recipient_user_id),
    actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
    type: row.type,
    title: row.title,
    message: row.message,
    module: row.module,
    entityType: row.entity_type || null,
    entityId: row.entity_id ? String(row.entity_id) : null,
    priority: row.priority || "INFO",
    isRead: Boolean(row.is_read),
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

export async function createNotification({
  tenantId,
  recipientUserId,
  actorUserId = null,
  type,
  title,
  message,
  module,
  entityType = null,
  entityId = null,
  priority = "INFO",
}) {
  if (!tenantId || !recipientUserId || !type || !title || !message || !module) {
    throw new HttpError(400, "Missing required notification fields.");
  }

  const validPriorities = ["INFO", "SUCCESS", "WARNING", "URGENT"];
  const finalPriority = validPriorities.includes(String(priority).toUpperCase())
    ? String(priority).toUpperCase()
    : "INFO";

  const [result] = await pool.execute(
    `INSERT INTO notifications
      (tenant_id, recipient_user_id, actor_user_id, type, title, message, module, entity_type, entity_id, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      recipientUserId,
      actorUserId || null,
      String(type).slice(0, 60),
      String(title).slice(0, 180),
      String(message),
      String(module).slice(0, 60),
      entityType ? String(entityType).slice(0, 60) : null,
      entityId ? String(entityId).slice(0, 120) : null,
      finalPriority,
    ],
  );

  const [[row]] = await pool.execute(
    "SELECT * FROM notifications WHERE id = ?",
    [result.insertId],
  );
  return mapNotification(row);
}

export async function createMultiNotification({
  tenantId,
  recipientUserIds = [],
  actorUserId = null,
  type,
  title,
  message,
  module,
  entityType = null,
  entityId = null,
  priority = "INFO",
}) {
  const uniqueIds = Array.from(new Set(recipientUserIds.filter(Boolean).map(String)));
  const results = [];
  for (const recipientUserId of uniqueIds) {
    const notif = await createNotification({
      tenantId,
      recipientUserId,
      actorUserId,
      type,
      title,
      message,
      module,
      entityType,
      entityId,
      priority,
    });
    results.push(notif);
  }
  return results;
}

export async function notifyAdminsOfTenant({
  tenantId,
  actorUserId = null,
  type,
  title,
  message,
  module,
  entityType = null,
  entityId = null,
  priority = "INFO",
}) {
  const [adminRows] = await pool.execute(
    "SELECT id FROM users WHERE tenant_id = ? AND role = 'ADMIN' AND status = 'ACTIVE' AND deleted_at IS NULL",
    [tenantId],
  );
  const adminIds = adminRows.map((r) => r.id);
  return createMultiNotification({
    tenantId,
    recipientUserIds: adminIds,
    actorUserId,
    type,
    title,
    message,
    module,
    entityType,
    entityId,
    priority,
  });
}

export async function createNotificationIfNotExistsRecent({
  tenantId,
  userId,
  recipientUserId,
  actorUserId = null,
  type,
  title,
  message,
  module,
  entityType = null,
  entityId = null,
  priority = "INFO",
  cooldownHours = 24,
}) {
  const targetUserId = userId || recipientUserId;
  const [[existing]] = await pool.execute(
    `SELECT id FROM notifications
      WHERE tenant_id = ? AND recipient_user_id = ? AND type = ? AND entity_type = ? AND entity_id = ?
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
      LIMIT 1`,
    [tenantId, targetUserId, type, entityType || "", String(entityId || ""), cooldownHours],
  );

  if (existing) {
    return null; // Skip duplicate notification within cooldown period
  }

  return createNotification({
    tenantId,
    recipientUserId: targetUserId,
    actorUserId,
    type,
    title,
    message,
    module,
    entityType,
    entityId,
    priority,
  });
}

export async function listUserNotifications({
  tenantId,
  userId,
  recipientUserId,
  page = 1,
  limit = 20,
  unreadOnly = false,
}) {
  const targetUserId = userId || recipientUserId;
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (safePage - 1) * safeLimit;

  const whereConditions = ["tenant_id = ?", "recipient_user_id = ?"];
  const params = [tenantId, targetUserId];

  if (unreadOnly) {
    whereConditions.push("is_read = 0");
  }

  const whereClause = whereConditions.join(" AND ");

  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM notifications WHERE ${whereClause}`,
    params,
  );

  const [rows] = await pool.execute(
    `SELECT * FROM notifications
      WHERE ${whereClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ${safeLimit} OFFSET ${offset}`,
    params,
  );

  const unreadCount = await getUnreadNotificationCount({ tenantId, userId: targetUserId });

  return {
    notifications: rows.map(mapNotification),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total: Number(total || 0),
      totalPages: Math.ceil((Number(total) || 0) / safeLimit),
    },
    unreadCount,
  };
}

export async function getUnreadNotificationCount({ tenantId, userId, recipientUserId }) {
  const targetUserId = userId || recipientUserId;
  const [[{ count }]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM notifications WHERE tenant_id = ? AND recipient_user_id = ? AND is_read = 0",
    [tenantId, targetUserId],
  );
  return Number(count || 0);
}

export async function markAsRead({ tenantId, userId, recipientUserId, notificationId }) {
  const targetUserId = userId || recipientUserId;
  const [res] = await pool.execute(
    "UPDATE notifications SET is_read = 1, read_at = NOW() WHERE id = ? AND tenant_id = ? AND recipient_user_id = ?",
    [notificationId, tenantId, targetUserId],
  );

  if (res.affectedRows === 0) {
    throw new HttpError(404, "Notification not found.");
  }

  const [[row]] = await pool.execute(
    "SELECT * FROM notifications WHERE id = ?",
    [notificationId],
  );
  return mapNotification(row);
}

export async function markAllAsRead({ tenantId, userId, recipientUserId }) {
  const targetUserId = userId || recipientUserId;
  await pool.execute(
    "UPDATE notifications SET is_read = 1, read_at = NOW() WHERE tenant_id = ? AND recipient_user_id = ? AND is_read = 0",
    [tenantId, targetUserId],
  );
  return { success: true };
}
