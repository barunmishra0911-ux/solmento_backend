import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { pool } from "../config/database.js";
import { HttpError } from "../utils/http.js";

function mapCounsellor(row) {
  return {
    id: row.id,
    fullName: row.name,
    name: row.name,
    profilePhoto: row.profile_photo || "",
    employeeId: row.employee_id,
    email: row.email,
    phone: row.phone,
    department: row.department,
    designation: row.designation || (row.role === "HEAD_COUNSELLOR" ? "Head Counsellor" : "Counsellor"),
    customRoleId: row.custom_role_id || null,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
  };
}

const counsellorColumns = `id, name, employee_id, email, phone, department,
  designation, custom_role_id, profile_photo, role, status, created_at`;

export async function listCounsellors(tenantId) {
  const [rows] = await pool.execute(
    `SELECT ${counsellorColumns}
     FROM users
     WHERE tenant_id = ? AND role IN ('HEAD_COUNSELLOR', 'COUNSELLOR') AND deleted_at IS NULL
     ORDER BY created_at DESC, id DESC`,
    [tenantId],
  );
  return rows.map(mapCounsellor);
}

const EMPLOYEE_ID_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const EMPLOYEE_ID_LENGTH = 12;

export function generateEmployeeId(length = EMPLOYEE_ID_LENGTH) {
  let result = "";
  for (let i = 0; i < length; i++) {
    const randomIndex = crypto.randomInt(0, EMPLOYEE_ID_CHARSET.length);
    result += EMPLOYEE_ID_CHARSET[randomIndex];
  }
  return result;
}

export async function createCounsellor({ fullName, profilePhoto, email, phone, department, designation, password, adminUserId, tenantId }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const normalizedEmail = email.toLowerCase();
    const role = designation.toLowerCase().includes("head") ? "HEAD_COUNSELLOR" : "COUNSELLOR";

    const [admins] = await connection.execute(
      "SELECT id FROM users WHERE id = ? AND tenant_id = ? AND role = 'ADMIN' AND status = 'ACTIVE' AND deleted_at IS NULL LIMIT 1",
      [adminUserId, tenantId],
    );
    if (!admins.length) throw new HttpError(403, "The admin account is not linked to this workspace.");

    const [emailRows] = await connection.execute("SELECT id FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1", [normalizedEmail]);
    if (emailRows.length) throw new HttpError(409, "An account with this email already exists.");

    // Match custom role by name for this tenant if available (prioritize custom role over system role)
    let customRoleId = null;
    const [matchedRoles] = await connection.execute(
      "SELECT id FROM roles WHERE (tenant_id = ? OR tenant_id IS NULL) AND LOWER(name) = LOWER(?) AND deleted_at IS NULL ORDER BY (tenant_id IS NOT NULL) DESC, id DESC LIMIT 1",
      [tenantId, designation.trim()],
    );
    if (matchedRoles.length) {
      customRoleId = matchedRoles[0].id;
    }

    const finalPassword = password && String(password).trim()
      ? String(password).trim()
      : crypto.randomBytes(24).toString("base64url");
    const passwordHash = await bcrypt.hash(finalPassword, 12);

    const MAX_RETRIES = 5;
    let insertResult = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const generatedEmployeeId = generateEmployeeId();
      try {
        const [result] = await connection.execute(
          `INSERT INTO users
            (tenant_id, created_by_user_id, name, employee_id, phone, department,
             designation, custom_role_id, profile_photo, email, password_hash, role, status, email_verified_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', UTC_TIMESTAMP())`,
          [tenantId, adminUserId, fullName.trim(), generatedEmployeeId, phone.trim(), department.trim(), designation.trim(), customRoleId, profilePhoto || null, normalizedEmail, passwordHash, role],
        );
        insertResult = result;
        break;
      } catch (insertError) {
        if (insertError?.code === "ER_DUP_ENTRY" && String(insertError.message).includes("employee") && attempt < MAX_RETRIES) {
          continue;
        }
        throw insertError;
      }
    }

    if (!insertResult) {
      throw new HttpError(500, "Unable to generate a unique employee ID. Please try again.");
    }

    const [rows] = await connection.execute(`SELECT ${counsellorColumns} FROM users WHERE id = ?`, [insertResult.insertId]);
    await connection.commit();
    return mapCounsellor(rows[0]);
  } catch (error) {
    await connection.rollback();
    if (error?.code === "ER_DUP_ENTRY") {
      if (String(error.message).includes("email") || String(error.message).includes("uq_users_email")) {
        throw new HttpError(409, "An account with this email already exists.");
      }
      throw new HttpError(409, "This employee ID is already used in your workspace.");
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function getCounsellorOrThrow(id, tenantId, connection = pool) {
  const [rows] = await connection.execute(
    `SELECT ${counsellorColumns}
       FROM users
      WHERE id = ? AND tenant_id = ? AND role IN ('HEAD_COUNSELLOR', 'COUNSELLOR') AND deleted_at IS NULL
      LIMIT 1`,
    [id, tenantId],
  );
  if (!rows.length) throw new HttpError(404, "Counsellor not found.");
  return rows[0];
}

export async function updateCounsellor({ id, tenantId, fullName, profilePhoto, email, phone, department, designation, password }) {
  const existing = await getCounsellorOrThrow(id, tenantId);
  const normalizedEmail = email.toLowerCase();
  const role = designation.toLowerCase().includes("head") ? "HEAD_COUNSELLOR" : "COUNSELLOR";
  const [emailRows] = await pool.execute(
    "SELECT id FROM users WHERE email = ? AND id <> ? AND deleted_at IS NULL LIMIT 1",
    [normalizedEmail, id],
  );
  if (emailRows.length) throw new HttpError(409, "An account with this email already exists.");

  // Match custom role by name for this tenant if available (prioritize custom role over system role)
  let customRoleId = null;
  const [matchedRoles] = await pool.execute(
    "SELECT id FROM roles WHERE (tenant_id = ? OR tenant_id IS NULL) AND LOWER(name) = LOWER(?) AND deleted_at IS NULL ORDER BY (tenant_id IS NOT NULL) DESC, id DESC LIMIT 1",
    [tenantId, designation.trim()],
  );
  if (matchedRoles.length) {
    customRoleId = matchedRoles[0].id;
  }

  if (password && String(password).trim()) {
    const passwordHash = await bcrypt.hash(String(password).trim(), 12);
    await pool.execute(
      `UPDATE users
          SET name = ?, email = ?, phone = ?, department = ?,
              designation = ?, custom_role_id = ?, profile_photo = ?, role = ?, password_hash = ?
        WHERE id = ? AND tenant_id = ? AND role IN ('HEAD_COUNSELLOR', 'COUNSELLOR') AND deleted_at IS NULL`,
      [fullName.trim(), normalizedEmail, phone.trim(), department.trim(), designation.trim(), customRoleId, profilePhoto || null, role, passwordHash, existing.id, tenantId],
    );
  } else {
    await pool.execute(
      `UPDATE users
          SET name = ?, email = ?, phone = ?, department = ?,
              designation = ?, custom_role_id = ?, profile_photo = ?, role = ?
        WHERE id = ? AND tenant_id = ? AND role IN ('HEAD_COUNSELLOR', 'COUNSELLOR') AND deleted_at IS NULL`,
      [fullName.trim(), normalizedEmail, phone.trim(), department.trim(), designation.trim(), customRoleId, profilePhoto || null, role, existing.id, tenantId],
    );
  }
  return mapCounsellor(await getCounsellorOrThrow(id, tenantId));
}

export async function deleteCounsellor({ id, tenantId, actorUserId }) {
  const counsellor = await getCounsellorOrThrow(id, tenantId);
  await pool.execute(
    `UPDATE users
        SET deleted_at = CURRENT_TIMESTAMP,
            deleted_by_user_id = ?
      WHERE id = ? AND tenant_id = ? AND role IN ('HEAD_COUNSELLOR', 'COUNSELLOR') AND deleted_at IS NULL`,
    [actorUserId || null, id, tenantId],
  );
  return mapCounsellor(counsellor);
}

export async function restoreCounsellor({ id, tenantId }) {
  const [rows] = await pool.execute(
    `SELECT ${counsellorColumns}
       FROM users
      WHERE id = ? AND tenant_id = ? AND role IN ('HEAD_COUNSELLOR', 'COUNSELLOR') AND deleted_at IS NOT NULL
      LIMIT 1`,
    [id, tenantId],
  );
  if (!rows.length) throw new HttpError(404, "Deleted counsellor not found.");

  await pool.execute(
    `UPDATE users
        SET deleted_at = NULL,
            deleted_by_user_id = NULL
      WHERE id = ? AND tenant_id = ?`,
    [id, tenantId],
  );
  return mapCounsellor(rows[0]);
}
