import { pool } from "../config/database.js";

function getInitials(name) {
  if (!name) return "U";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
}

function getAvatarBg(name) {
  const charCode = (name || "U").charCodeAt(0);
  const colors = [
    "bg-blue-100 text-blue-600",
    "bg-amber-100 text-amber-700",
    "bg-purple-100 text-purple-700",
    "bg-rose-100 text-rose-600",
    "bg-emerald-100 text-emerald-700",
  ];
  return colors[charCode % colors.length];
}

function formatTimestamp(createdAt) {
  if (!createdAt) return "";
  const d = new Date(createdAt);
  if (isNaN(d.getTime())) return String(createdAt);

  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();

  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  hours = hours ? hours : 12;
  const formattedHours = String(hours).padStart(2, "0");

  return `${day}-${month}-${year} ${formattedHours}:${minutes} ${ampm}`;
}

function parseDateStringToIso(dateStr) {
  if (!dateStr) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  if (/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) {
    const [d, m, y] = dateStr.split("-");
    return `${y}-${m}-${d}`;
  }
  return null;
}

export function formatAuditLogRow(row) {
  const metadata = typeof row.metadata === "string"
    ? JSON.parse(row.metadata || "{}")
    : (row.metadata || {});

  let action = metadata.action || row.action || "Updated";
  if (action === "ROLE_CREATED" || action === "COUNSELLOR_CREATED" || action === "LEAD_CREATED" || action === "FOLLOWUP_CREATED" || action === "CAMPAIGN_CREATED" || action === "CREATED") action = "Created";
  else if (action === "ROLE_UPDATED" || action === "ROLE_PERMISSIONS_UPDATED" || action === "COUNSELLOR_UPDATED" || action === "LEAD_UPDATED" || action === "SETTINGS_UPDATED" || action === "TENANT_UPDATED" || action === "UPDATED") action = "Updated";
  else if (action === "ROLE_DELETED" || action === "COUNSELLOR_DELETED" || action === "LEAD_DELETED" || action === "DELETED") action = "Deleted";
  else if (action === "LOGIN" || action === "USER_LOGIN" || action === "AUTHENTICATED" || action === "LOGGED_IN") action = "Logged In";

  let module = metadata.module || row.targetType || "Settings";
  if (module === "ROLE" || module === "PERMISSIONS" || module === "ROLE_PERMISSIONS" || module === "PLATFORM_ROLE") module = "Roles & Permissions";
  if (module === "TENANT" || module === "PROFILE" || module === "COMPANY_PROFILE") module = "Company Profile";
  if (module === "WHATSAPP") module = "Settings";
  if (module === "STUDENT_LEAD" || module === "LEAD") module = "Student Lead";
  if (module === "FOLLOW_UP" || module === "FOLLOW_UPS") module = "Follow Ups";
  if (module === "AUTHENTICATION" || module === "AUTH") module = "Authentication";

  const name = metadata.userName || row.actorName || "System User";
  const user = {
    id: row.actorUserId || 0,
    name: name,
    email: metadata.userEmail || row.actorEmail || "",
    initials: metadata.userInitials || getInitials(name),
    avatarBg: metadata.avatarBg || getAvatarBg(name),
  };

  const role = metadata.userRole || row.actorRole || "Admin";
  const formattedRole = role === "ADMIN" || role === "SUPER_ADMIN" ? "Admin" : role === "COUNSELLOR" ? "Counsellor" : role;

  const page = metadata.page || `${module}`;
  const details = metadata.details || `${action} ${module.toLowerCase()} details`;

  return {
    id: row.id,
    timestamp: formatTimestamp(row.createdAt),
    rawDate: row.createdAt,
    user,
    role: formattedRole,
    action,
    module,
    page,
    details,
    fullDetails: metadata.fullDetails || details,
    summaryTitle: metadata.summaryTitle || `${module} ${action}`,
    summarySubtitle: metadata.summarySubtitle || `${module} information was modified`,
  };
}

export async function recordAudit({
  tenantId = null,
  actorUserId = null,
  action,
  targetType,
  targetId = null,
  metadata = {},
  ipAddress = null,
}) {
  try {
    let resolvedTenantId = tenantId;
    if (!resolvedTenantId && actorUserId) {
      const [userRows] = await pool.execute(
        "SELECT tenant_id FROM users WHERE id = ?",
        [actorUserId]
      );
      if (userRows.length > 0) {
        resolvedTenantId = userRows[0].tenant_id;
      }
    }

    await pool.execute(
      "INSERT INTO audit_logs (tenant_id, actor_user_id, action, target_type, target_id, metadata_json, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        resolvedTenantId ?? null,
        actorUserId ?? null,
        action,
        targetType,
        targetId == null ? null : String(targetId),
        JSON.stringify(metadata),
        ipAddress,
      ]
    );
  } catch (err) {
    console.error("Failed to record audit log:", err);
  }
}

export async function listAuditLogs({
  tenantId = null,
  search = "",
  module = "ALL",
  action = "ALL",
  user = "ALL",
  role = "ALL",
  dateFrom,
  dateTo,
  page = 1,
  limit = 10,
} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  let whereClauses = ["1=1"];
  let params = [];

  if (tenantId) {
    whereClauses.push("a.tenant_id = ?");
    params.push(tenantId);
  }

  if (action && action !== "ALL") {
    whereClauses.push("(a.action = ? OR a.action LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.action')) = ?)");
    params.push(action, `%${action}%`, action);
  }

  if (module && module !== "ALL") {
    whereClauses.push("(a.target_type = ? OR JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.module')) = ?)");
    params.push(module, module);
  }

  if (user && user !== "ALL") {
    whereClauses.push("(u.name = ? OR JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.userName')) = ?)");
    params.push(user, user);
  }

  if (role && role !== "ALL") {
    whereClauses.push("(u.role = ? OR JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.userRole')) = ?)");
    params.push(role, role);
  }

  if (search && search.trim()) {
    const q = `%${search.trim().toLowerCase()}%`;
    whereClauses.push(
      "(LOWER(u.name) LIKE ? OR LOWER(a.action) LIKE ? OR LOWER(a.target_type) LIKE ? OR LOWER(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.details'))) LIKE ? OR LOWER(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.page'))) LIKE ?)"
    );
    params.push(q, q, q, q, q);
  }

  if (dateFrom && dateFrom !== "ALL") {
    const parsedFrom = parseDateStringToIso(dateFrom);
    if (parsedFrom) {
      whereClauses.push("a.created_at >= ?");
      params.push(parsedFrom + " 00:00:00");
    }
  }

  if (dateTo && dateTo !== "ALL") {
    const parsedTo = parseDateStringToIso(dateTo);
    if (parsedTo) {
      whereClauses.push("a.created_at <= ?");
      params.push(parsedTo + " 23:59:59");
    }
  }

  const whereSql = whereClauses.join(" AND ");

  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE ${whereSql}`,
    params
  );
  const total = countRows[0]?.total || 0;

  const [rows] = await pool.execute(
    `SELECT a.id, a.tenant_id AS tenantId, a.actor_user_id AS actorUserId,
            a.action, a.target_type AS targetType, a.target_id AS targetId,
            a.metadata_json AS metadata, a.created_at AS createdAt,
            u.name AS actorName, u.email AS actorEmail, u.role AS actorRole
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE ${whereSql}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${safeLimit} OFFSET ${offset}`,
    params
  );

  const logs = rows.map(formatAuditLogRow);

  return {
    logs,
    total,
    page: safePage,
    limit: safeLimit,
  };
}

function escapeCsvValue(val) {
  if (val == null) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

export async function exportAuditLogs({
  tenantId = null,
  search = "",
  module = "ALL",
  action = "ALL",
  user = "ALL",
  role = "ALL",
  dateFrom,
  dateTo,
} = {}) {
  let whereClauses = ["1=1"];
  let params = [];

  if (tenantId) {
    whereClauses.push("a.tenant_id = ?");
    params.push(tenantId);
  }

  if (action && action !== "ALL") {
    whereClauses.push("(a.action = ? OR a.action LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.action')) = ?)");
    params.push(action, `%${action}%`, action);
  }

  if (module && module !== "ALL") {
    whereClauses.push("(a.target_type = ? OR JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.module')) = ?)");
    params.push(module, module);
  }

  if (user && user !== "ALL") {
    whereClauses.push("(u.name = ? OR JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.userName')) = ?)");
    params.push(user, user);
  }

  if (role && role !== "ALL") {
    whereClauses.push("(u.role = ? OR JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.userRole')) = ?)");
    params.push(role, role);
  }

  if (search && search.trim()) {
    const q = `%${search.trim().toLowerCase()}%`;
    whereClauses.push(
      "(LOWER(u.name) LIKE ? OR LOWER(a.action) LIKE ? OR LOWER(a.target_type) LIKE ? OR LOWER(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.details'))) LIKE ? OR LOWER(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.page'))) LIKE ?)"
    );
    params.push(q, q, q, q, q);
  }

  if (dateFrom && dateFrom !== "ALL") {
    const parsedFrom = parseDateStringToIso(dateFrom);
    if (parsedFrom) {
      whereClauses.push("a.created_at >= ?");
      params.push(parsedFrom + " 00:00:00");
    }
  }

  if (dateTo && dateTo !== "ALL") {
    const parsedTo = parseDateStringToIso(dateTo);
    if (parsedTo) {
      whereClauses.push("a.created_at <= ?");
      params.push(parsedTo + " 23:59:59");
    }
  }

  const whereSql = whereClauses.join(" AND ");

  const [rows] = await pool.execute(
    `SELECT a.id, a.tenant_id AS tenantId, a.actor_user_id AS actorUserId,
            a.action, a.target_type AS targetType, a.target_id AS targetId,
            a.metadata_json AS metadata, a.created_at AS createdAt,
            u.name AS actorName, u.email AS actorEmail, u.role AS actorRole
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE ${whereSql}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT 10000`,
    params
  );

  const logs = rows.map(formatAuditLogRow);

  const headers = ["Date & Time", "User", "Role", "Action", "Module / Page", "Details"];
  const lines = [headers.map(escapeCsvValue).join(",")];

  for (const log of logs) {
    const userName = log.user?.name || log.user?.email || "System User";
    const modulePage = log.page ? `${log.module} / ${log.page}` : log.module;
    lines.push([
      escapeCsvValue(log.timestamp),
      escapeCsvValue(userName),
      escapeCsvValue(log.role),
      escapeCsvValue(log.action),
      escapeCsvValue(modulePage),
      escapeCsvValue(log.fullDetails || log.details),
    ].join(","));
  }

  return lines.join("\n");
}

