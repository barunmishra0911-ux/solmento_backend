import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import { pool } from "../config/database.js";
import { env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { publicUser } from "./authService.js";

function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160) || "workspace";
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function uniqueSlug(connection, name) {
  const base = slugify(name);
  for (let suffix = 1; ; suffix += 1) {
    const slug = suffix === 1 ? base : `${base.slice(0, 155)}-${suffix}`;
    const [rows] = await connection.execute("SELECT id FROM tenants WHERE slug = ? LIMIT 1", [slug]);
    if (!rows.length) return slug;
  }
}

export async function registerCompany({ companyName, name, email, password }) {
  const connection = await pool.getConnection();
  const normalizedEmail = email.toLowerCase();
  const rawToken = randomBytes(32).toString("hex");
  try {
    await connection.beginTransaction();
    const [existing] = await connection.execute("SELECT id FROM users WHERE email = ? LIMIT 1", [normalizedEmail]);
    if (existing.length) throw new HttpError(409, "An account with this email already exists.");
    const slug = await uniqueSlug(connection, companyName);
    const [tenantResult] = await connection.execute("INSERT INTO tenants (name, company_name, slug, status) VALUES (?, ?, ?, 'ACTIVE')", [companyName.trim(), companyName.trim(), slug]);
    const passwordHash = await bcrypt.hash(password, 12);
    const [userResult] = await connection.execute("INSERT INTO users (tenant_id, name, email, password_hash, role, status) VALUES (?, ?, ?, ?, 'ADMIN', 'ACTIVE')", [tenantResult.insertId, name.trim(), normalizedEmail, passwordHash]);
    await connection.execute("INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 24 HOUR))", [userResult.insertId, hashToken(rawToken)]);
    await connection.commit();
    return { user: publicUser({ id: userResult.insertId, tenant_id: tenantResult.insertId, name: name.trim(), email: normalizedEmail, role: "ADMIN", status: "ACTIVE" }), verificationToken: env.NODE_ENV === "development" ? rawToken : undefined };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function verifyEmail(rawToken) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute("SELECT id, user_id FROM email_verification_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP() LIMIT 1", [hashToken(rawToken)]);
    if (!rows[0]) throw new HttpError(400, "This verification link is invalid or has expired.");
    await connection.execute("UPDATE users SET email_verified_at = COALESCE(email_verified_at, UTC_TIMESTAMP()) WHERE id = ?", [rows[0].user_id]);
    await connection.execute("UPDATE email_verification_tokens SET used_at = UTC_TIMESTAMP() WHERE id = ?", [rows[0].id]);
    await connection.commit();
    return { verified: true };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
