import { pool } from "../config/database.js";
import { ok } from "../utils/http.js";

export async function getDashboardMetrics(_req, res, next) {
  try {
    const [[tenantCounts]] = await pool.query(
      "SELECT COUNT(*) AS totalTenants, SUM(status = 'ACTIVE') AS activeTenants FROM tenants",
    );
    const [[userCounts]] = await pool.query(
      "SELECT COUNT(*) AS totalUsers FROM users WHERE role <> 'SUPER_ADMIN'",
    );
    return ok(res, {
      metrics: {
        totalTenants: Number(tenantCounts.totalTenants || 0),
        activeTenants: Number(tenantCounts.activeTenants || 0),
        totalUsers: Number(userCounts.totalUsers || 0),
        mrr: null,
        aiTokensUsedToday: null,
        activeConversations: null,
        openTickets: null,
        unavailable: [
          "mrr",
          "aiTokensUsedToday",
          "activeConversations",
          "openTickets",
        ],
      },
    });
  } catch (error) {
    return next(error);
  }
}
