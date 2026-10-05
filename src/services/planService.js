import { pool } from "../config/database.js";
import { HttpError } from "../utils/http.js";
import { recordAudit } from "./auditService.js";

function decode(value) { if (!value) return {}; if (typeof value === "object") return value; try { return JSON.parse(value); } catch { return {}; } }
function map(row) { return { id: row.id, name: row.name, description: row.description || "", price: Number(row.price), interval: row.billing_interval.toLowerCase(), limits: decode(row.limits_json), features: decode(row.features_json), status: row.status, displayOrder: row.display_order }; }
export async function listPlans() { const [rows] = await pool.query("SELECT * FROM plans ORDER BY display_order ASC, id ASC"); return rows.map(map); }
export async function createPlan(input, actorUserId, ipAddress) {
  const name = String(input.name || "").trim(); if (!name) throw new HttpError(422, "Plan name is required.");
  const [result] = await pool.execute("INSERT INTO plans (name, description, price, billing_interval, limits_json, features_json, display_order) VALUES (?, ?, ?, ?, ?, ?, ?)", [name, input.description || null, Number(input.price) || 0, String(input.interval || "monthly").toUpperCase(), JSON.stringify(input.limits || {}), JSON.stringify(input.features || {}), Number(input.displayOrder) || 0]);
  await recordAudit({ actorUserId, action: "PLAN_CREATED", targetType: "PLAN", targetId: result.insertId, ipAddress, metadata: { name } });
  const [rows] = await pool.execute("SELECT * FROM plans WHERE id = ?", [result.insertId]); return map(rows[0]);
}
export async function updatePlan(id, input, actorUserId, ipAddress) {
  const [result] = await pool.execute("UPDATE plans SET name = COALESCE(?, name), description = COALESCE(?, description), price = COALESCE(?, price), billing_interval = COALESCE(?, billing_interval), limits_json = COALESCE(?, limits_json), features_json = COALESCE(?, features_json), status = COALESCE(?, status), display_order = COALESCE(?, display_order) WHERE id = ?", [input.name || null, input.description || null, input.price == null ? null : Number(input.price), input.interval ? String(input.interval).toUpperCase() : null, input.limits ? JSON.stringify(input.limits) : null, input.features ? JSON.stringify(input.features) : null, input.status || null, input.displayOrder == null ? null : Number(input.displayOrder), id]);
  if (!result.affectedRows) throw new HttpError(404, "Plan not found.");
  await recordAudit({ actorUserId, action: "PLAN_UPDATED", targetType: "PLAN", targetId: id, ipAddress, metadata: { fields: Object.keys(input) } });
  const [rows] = await pool.execute("SELECT * FROM plans WHERE id = ?", [id]); return map(rows[0]);
}
