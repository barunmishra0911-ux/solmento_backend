import { randomUUID } from "node:crypto";
import { pool } from "../config/database.js";
import { HttpError } from "../utils/http.js";

const visitorIdPattern = /^[A-Za-z0-9_-]{16,128}$/;

export function validateVisitorId(visitorId) {
  if (typeof visitorId !== "string" || !visitorIdPattern.test(visitorId)) {
    throw new HttpError(422, "Please provide a valid visitor session.");
  }
  return visitorId;
}

function mapHistory(rows) {
  return rows.map((row) => {
    let meta = null;
    if (row.metadata_json) {
      try {
        meta = typeof row.metadata_json === "string" ? JSON.parse(row.metadata_json) : row.metadata_json;
      } catch { }
    }
    return {
      role: row.role === "USER" ? "user" : "bot",
      text: row.content,
      answer: meta?.answer || null,
      followUpPrompt: meta?.follow_up_prompt || null,
      suggestions: Array.isArray(meta?.suggestions) ? meta.suggestions : null,
      createdAt: row.created_at,
    };
  });
}

async function findConversation(connection, chatbot, visitorId, lock = false, conversationPublicId = null) {
  let query = `SELECT id, public_id, visitor_id, status, created_at, updated_at
       FROM conversations
      WHERE tenant_id = ? AND chatbot_id = ? AND chatbot_public_id = ? AND visitor_id = ?`;
  const params = [chatbot.tenant_id, chatbot.id, chatbot.public_id, visitorId];

  if (conversationPublicId) {
    query += ` AND public_id = ?`;
    params.push(conversationPublicId);
  }

  query += ` ORDER BY updated_at DESC, id DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`;

  const [rows] = await connection.execute(query, params);
  if (rows[0]) return rows[0];

  // If conversationPublicId was passed but not found, fall back to visitor's most recent active conversation
  if (conversationPublicId) {
    const [fallbackRows] = await connection.execute(
      `SELECT id, public_id, visitor_id, status, created_at, updated_at
         FROM conversations
        WHERE tenant_id = ? AND chatbot_id = ? AND chatbot_public_id = ? AND visitor_id = ?
        ORDER BY updated_at DESC, id DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
      [chatbot.tenant_id, chatbot.id, chatbot.public_id, visitorId],
    );
    return fallbackRows[0] || null;
  }

  return null;
}

async function createConversation(connection, chatbot, visitorId) {
  const publicId = randomUUID();
  try {
    const [result] = await connection.execute(
      `INSERT INTO conversations
        (public_id, tenant_id, chatbot_id, chatbot_public_id, visitor_id, channel, status)
       VALUES (?, ?, ?, ?, ?, 'website', 'OPEN')`,
      [publicId, chatbot.tenant_id, chatbot.id, chatbot.public_id, visitorId],
    );
    await connection.execute(
      "UPDATE chatbots SET conversations_this_month = conversations_this_month + 1 WHERE id = ? AND tenant_id = ?",
      [chatbot.id, chatbot.tenant_id],
    );
    return { id: result.insertId, public_id: publicId, visitor_id: visitorId, status: "OPEN", created_at: new Date(), updated_at: new Date() };
  } catch (error) {
    if (error?.code !== "ER_DUP_ENTRY") throw error;
    return findConversation(connection, chatbot, visitorId, true);
  }
}

async function getOrCreateConversation(connection, chatbot, visitorId, conversationPublicId = null) {
  return (
    (await findConversation(connection, chatbot, visitorId, true, conversationPublicId)) ||
    createConversation(connection, chatbot, visitorId)
  );
}

export async function saveUserMessage({ chatbot, visitorId, conversationPublicId = null, content, metadata = null }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const conversation = await getOrCreateConversation(connection, chatbot, visitorId, conversationPublicId);
    await connection.execute(
      `INSERT INTO conversation_messages
        (conversation_id, tenant_id, chatbot_id, role, content, status, metadata_json)
       VALUES (?, ?, ?, 'USER', ?, 'SENT', ?)`,
      [conversation.id, chatbot.tenant_id, chatbot.id, content, metadata ? JSON.stringify(metadata) : null],
    );
    await connection.execute("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [conversation.id]);
    await connection.commit();
    return conversation;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function saveAssistantMessage({ chatbot, conversationId, content, metadata = null }) {
  const [result] = await pool.execute(
    `INSERT INTO conversation_messages
      (conversation_id, tenant_id, chatbot_id, role, content, status, metadata_json)
     SELECT c.id, c.tenant_id, c.chatbot_id, 'ASSISTANT', ?, 'SENT', ?
       FROM conversations c
      WHERE c.id = ? AND c.tenant_id = ? AND c.chatbot_id = ? AND c.chatbot_public_id = ?
      LIMIT 1`,
    [content, metadata ? JSON.stringify(metadata) : null, conversationId, chatbot.tenant_id, chatbot.id, chatbot.public_id],
  );
  if (!result.affectedRows) throw new HttpError(404, "Conversation not found.");
  await pool.execute("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ? AND chatbot_id = ?", [conversationId, chatbot.tenant_id, chatbot.id]);
}

export async function getConversationHistory({ chatbot, visitorId, conversationId = null, limit = 50 }) {
  const conversation = await findConversation(pool, chatbot, visitorId, false, conversationId);
  if (!conversation) return { conversation: null, history: [] };
  const [rows] = await pool.execute(
    `SELECT role, content, metadata_json, created_at
       FROM (
         SELECT id, role, content, metadata_json, created_at
           FROM conversation_messages
          WHERE conversation_id = ? AND tenant_id = ? AND chatbot_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
       ) latest
      ORDER BY created_at ASC, id ASC`,
    [conversation.id, chatbot.tenant_id, chatbot.id, Number(limit)],
  );
  return { conversation, history: mapHistory(rows) };
}

export async function getConversationContext({ chatbot, conversationId, sourceFingerprint = null, limit = 30 }) {
  let query = `SELECT role, content, created_at
       FROM conversation_messages
      WHERE conversation_id = ? AND tenant_id = ? AND chatbot_id = ?`;
  const params = [conversationId, chatbot.tenant_id, chatbot.id];

  if (sourceFingerprint) {
    query += ` AND (metadata_json IS NULL OR JSON_EXTRACT(metadata_json, '$.source_fingerprint') IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.source_fingerprint')) = ?)`;
    params.push(sourceFingerprint);
  }

  query += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
  params.push(Number(limit));

  const [rows] = await pool.execute(query, params);
  return mapHistory(rows.reverse());
}
