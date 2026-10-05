import { pool } from "../config/database.js";
import { HttpError } from "../utils/http.js";
import { recordAudit } from "./auditService.js";

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function mapTenant(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyName: row.company_name,
    companyDomain: row.domain || "",
    slug: row.slug,
    status: row.status,
    plan: row.plan_name || "Unassigned",
    planId: row.plan_id,
    trialLength: row.trial_days == null ? "No trial" : `${row.trial_days} days`,
    trialDays: row.trial_days,
    featureFlags: parseJson(row.feature_flags_json),
    admin: row.admin_id ? { id: row.admin_id, name: row.admin_name, email: row.admin_email, status: row.admin_status } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const tenantSelect = `SELECT t.id, t.company_name, t.domain, t.slug, t.plan_id, t.trial_days,
  t.feature_flags_json, t.status, t.created_at, t.updated_at, p.name AS plan_name,
  u.id AS admin_id, u.name AS admin_name, u.email AS admin_email, u.status AS admin_status
  FROM tenants t LEFT JOIN plans p ON p.id = t.plan_id
  LEFT JOIN users u ON u.tenant_id = t.id AND u.role = 'ADMIN'
  WHERE t.id = ? ORDER BY u.id ASC LIMIT 1`;

export async function getTenantById(id) {
  const [rows] = await pool.execute(tenantSelect, [id]);
  if (!rows[0]) throw new HttpError(404, "Admin not found.");
  return mapTenant(rows[0]);
}

export async function listTenants() {
  const [rows] = await pool.query(`SELECT t.id, t.company_name AS companyName, t.domain, t.status,
    COALESCE(p.name, 'Unassigned') AS plan, t.plan_id AS planId, t.created_at AS createdAt,
    COUNT(DISTINCT u.id) AS users FROM tenants t LEFT JOIN plans p ON p.id = t.plan_id
    LEFT JOIN users u ON u.tenant_id = t.id GROUP BY t.id ORDER BY t.created_at DESC`);
  return rows;
}

export async function updateTenant(id, input, actorUserId, ipAddress) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [tenantRows] = await connection.execute("SELECT id, plan_id, company_name, domain, trial_days, feature_flags_json, status FROM tenants WHERE id = ? FOR UPDATE", [id]);
    if (!tenantRows[0]) throw new HttpError(404, "Admin not found.");
    const current = tenantRows[0];
    let planId = current.plan_id;
    if (input.plan !== undefined) {
      const requestedPlan = String(input.plan).trim();
      let [plans] = await connection.execute(
        "SELECT id FROM plans WHERE LOWER(name) = LOWER(?) AND status = 'ACTIVE' LIMIT 1",
        [requestedPlan],
      );

      // Keep updates from older edit screens working after the plan names were
      // shortened in the plans table (Professional -> Pro, Enterprise -> Business).
      if (!plans[0]) {
        const legacyPlanAliases = { professional: "Pro", enterprise: "Business" };
        const canonicalName = legacyPlanAliases[requestedPlan.toLowerCase()];
        if (canonicalName) {
          [plans] = await connection.execute(
            "SELECT id FROM plans WHERE name = ? AND status = 'ACTIVE' LIMIT 1",
            [canonicalName],
          );
        }
      }
      if (!plans[0]) throw new HttpError(422, "The selected plan is not available.");
      planId = plans[0].id;
    }
    const [admins] = await connection.execute("SELECT id, email, name FROM users WHERE tenant_id = ? AND role = 'ADMIN' ORDER BY id ASC LIMIT 1 FOR UPDATE", [id]);
    const admin = admins[0];
    if (input.adminEmail !== undefined) {
      const [duplicate] = await connection.execute("SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1", [input.adminEmail.toLowerCase(), admin?.id || 0]);
      if (duplicate.length) throw new HttpError(409, "An account with this email already exists.");
    }
    const trialDays = input.trialLength === undefined ? current.trial_days : (input.trialLength === "No trial" ? null : Number.parseInt(input.trialLength, 10));
    if (trialDays !== null && (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365)) throw new HttpError(422, "Trial length must be between 0 and 365 days.");
    await connection.execute("UPDATE tenants SET company_name = COALESCE(?, company_name), domain = COALESCE(?, domain), status = COALESCE(?, status), plan_id = ?, trial_days = ?, feature_flags_json = COALESCE(?, feature_flags_json) WHERE id = ?", [input.companyName ?? null, input.companyDomain ?? null, input.status ?? null, planId, trialDays, input.featureFlags === undefined ? null : JSON.stringify(input.featureFlags), id]);
    if (admin) await connection.execute("UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email) WHERE id = ?", [input.adminName ?? null, input.adminEmail ? input.adminEmail.toLowerCase() : null, admin.id]);
    await connection.commit();
    await recordAudit({ actorUserId, action: "TENANT_UPDATED", targetType: "TENANT", targetId: id, ipAddress, metadata: { fields: Object.keys(input).filter((key) => key !== "featureFlags"), featureFlagsUpdated: input.featureFlags !== undefined } });
    return getTenantById(id);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

export async function getCompanyProfile(tenantId) {
  const [rows] = await pool.execute(
    `SELECT tenant_id AS tenantId, company_name AS companyName, logo_url AS logoUrl,
            industry, timezone, email, phone, website, support_email AS supportEmail,
            address_line1 AS addressLine1, address_line2 AS addressLine2,
            city, state, pin_code AS pinCode, country
       FROM company_profiles
      WHERE tenant_id = ?
      LIMIT 1`,
    [tenantId],
  );

  if (rows[0]) {
    return {
      companyName: rows[0].companyName || "",
      logoUrl: rows[0].logoUrl || "",
      industry: rows[0].industry || "Education",
      timezone: rows[0].timezone || "(GMT+05:30) Asia/Kolkata",
      email: rows[0].email || "",
      phone: rows[0].phone || "",
      website: rows[0].website || "",
      supportEmail: rows[0].supportEmail || "",
      addressLine1: rows[0].addressLine1 || "",
      addressLine2: rows[0].addressLine2 || "",
      city: rows[0].city || "",
      state: rows[0].state || "",
      pinCode: rows[0].pinCode || "",
      country: rows[0].country || "India",
    };
  }

  // Fallback to tenant default if profile record not created yet
  const [tenants] = await pool.execute(
    `SELECT t.company_name, u.email, u.phone
       FROM tenants t
       LEFT JOIN users u ON u.tenant_id = t.id AND u.role = 'ADMIN'
      WHERE t.id = ?
      LIMIT 1`,
    [tenantId],
  );

  const t = tenants[0] || {};
  return {
    companyName: t.company_name || "BrightMind University",
    logoUrl: "",
    industry: "Education",
    timezone: "(GMT+05:30) Asia/Kolkata",
    email: t.email || "info@brightminduniversity.com",
    phone: t.phone || "+91 98765 43210",
    website: "https://www.brightminduniversity.com",
    supportEmail: "support@brightminduniversity.com",
    addressLine1: "Plot No. 123, Sector 62",
    addressLine2: "",
    city: "Noida",
    state: "Uttar Pradesh",
    pinCode: "201309",
    country: "India",
  };
}

export async function upsertCompanyProfile(tenantId, input, actorUserId, ipAddress) {
  const {
    companyName,
    industry,
    timezone,
    logoUrl = "",
    email,
    phone,
    website = "",
    supportEmail = "",
    addressLine1,
    addressLine2 = "",
    city,
    state,
    pinCode,
    country,
  } = input;

  await pool.execute(
    `INSERT INTO company_profiles
      (tenant_id, company_name, logo_url, industry, timezone, email, phone, website, support_email, address_line1, address_line2, city, state, pin_code, country)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      company_name = VALUES(company_name),
      logo_url = VALUES(logo_url),
      industry = VALUES(industry),
      timezone = VALUES(timezone),
      email = VALUES(email),
      phone = VALUES(phone),
      website = VALUES(website),
      support_email = VALUES(support_email),
      address_line1 = VALUES(address_line1),
      address_line2 = VALUES(address_line2),
      city = VALUES(city),
      state = VALUES(state),
      pin_code = VALUES(pin_code),
      country = VALUES(country)`,
    [
      tenantId,
      companyName.trim(),
      logoUrl || null,
      industry.trim(),
      timezone.trim(),
      email.trim().toLowerCase(),
      phone.trim(),
      website ? website.trim() : null,
      supportEmail ? supportEmail.trim().toLowerCase() : null,
      addressLine1.trim(),
      addressLine2 ? addressLine2.trim() : null,
      city.trim(),
      state.trim(),
      pinCode.trim(),
      country.trim(),
    ],
  );

  // Sync company_name into tenants table
  await pool.execute("UPDATE tenants SET company_name = ? WHERE id = ?", [
    companyName.trim(),
    tenantId,
  ]);

  // Record Audit Log event
  await recordAudit({
    tenantId,
    actorUserId,
    action: "Updated",
    targetType: "Company Profile",
    targetId: String(tenantId),
    ipAddress,
    metadata: {
      module: "Company Profile",
      page: "Company Profile",
      details: "Company profile updated",
    },
  });

  return await getCompanyProfile(tenantId);
}
