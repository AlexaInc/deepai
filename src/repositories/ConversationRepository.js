'use strict';

const JidParser = require('../utils/JidParser');

/**
 * ConversationRepository
 * ----------------------
 * Threads and their messages.
 *
 * A DM and each group are separate threads so chat context never leaks between
 * rooms — while user identity/memory stays global (see MemoryRepository).
 */
class ConversationRepository {
    /** @param {import('../db/Database')} db */
    constructor(db) {
        this.db = db;
    }

    /**
     * Find-or-create the thread for this (user, group) pair.
     * @param {object} params
     * @param {string} params.contextKey
     * @param {number} params.userId
     * @param {number|null} [params.groupId]
     * @param {string} [params.title]
     * @returns {Promise<object>}
     */
    async upsertConversation({ contextKey, userId, groupId = null, title = null }) {
        const kind = groupId ? 'group' : 'dm';
        return this.db.one(
            `INSERT INTO wa_conversations (context_key, user_id, group_id, kind, title)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (context_key) DO UPDATE
               SET updated_at = NOW(),
                   title      = COALESCE(EXCLUDED.title, wa_conversations.title)
             RETURNING *`,
            [contextKey, userId, groupId, kind, title]
        );
    }

    /**
     * Append a message.
     * @param {object} params
     * @param {number} params.conversationId
     * @param {number|null} params.userId
     * @param {'user'|'assistant'|'system'} params.role
     * @param {string} params.content
     * @param {boolean} [params.hasMedia]
     * @param {string} [params.mediaType]
     * @param {string} [params.waMessageId]
     * @param {object} [params.metadata]
     * @returns {Promise<object|null>} null when deduped
     */
    async addMessage({
        conversationId,
        userId = null,
        role,
        content,
        hasMedia = false,
        mediaType = null,
        waMessageId = null,
        metadata = {},
    }) {
        const text = String(content ?? '');
        if (!conversationId || !text.trim()) return null;

        // ON CONFLICT DO NOTHING relies on the partial unique index over
        // (conversation_id, wa_message_id) — WhatsApp redelivers on reconnect.
        const row = await this.db.one(
            `INSERT INTO wa_messages
                 (conversation_id, user_id, role, content, has_media, media_type, wa_message_id, tokens, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
             ON CONFLICT DO NOTHING
             RETURNING *`,
            [
                conversationId,
                userId,
                role,
                text,
                Boolean(hasMedia),
                mediaType,
                waMessageId,
                Math.ceil(text.length / 4),
                JSON.stringify(metadata || {}),
            ]
        );

        if (row) {
            await this.db.query(
                `UPDATE wa_conversations
                    SET message_count   = message_count + 1,
                        last_message_at = NOW(),
                        updated_at      = NOW()
                  WHERE id = $1`,
                [conversationId]
            );
        }
        return row;
    }

    /**
     * Newest `limit` messages in chronological order, ready for the model.
     * @param {number} conversationId
     * @param {number} [limit=14]
     * @returns {Promise<Array<{role:string, content:string}>>}
     */
    async getHistory(conversationId, limit = 14) {
        if (!conversationId) return [];
        const rows = await this.db.many(
            `SELECT role, content, created_at
               FROM (
                   SELECT role, content, created_at, id
                     FROM wa_messages
                    WHERE conversation_id = $1
                      AND role IN ('user','assistant')
                    ORDER BY created_at DESC, id DESC
                    LIMIT $2
               ) recent
              ORDER BY created_at ASC, id ASC`,
            [conversationId, limit]
        );
        return rows.map((r) => ({ role: r.role, content: r.content }));
    }

    async findByContextKey(contextKey) {
        return this.db.one('SELECT * FROM wa_conversations WHERE context_key = $1', [contextKey]);
    }

    /** Wipe a thread's messages (keeps the user and their memories). */
    async clearHistory(contextKey) {
        const convo = await this.findByContextKey(contextKey);
        if (!convo) return 0;
        const { rowCount } = await this.db.query('DELETE FROM wa_messages WHERE conversation_id = $1', [
            convo.id,
        ]);
        await this.db.query(
            'UPDATE wa_conversations SET message_count = 0, last_message_at = NULL WHERE id = $1',
            [convo.id]
        );
        return rowCount;
    }

    /**
     * Trim a thread to its newest `keep` messages.
     * Called opportunistically so tables stay bounded on busy groups.
     */
    async trim(conversationId, keep = 200) {
        if (!conversationId) return 0;
        const { rowCount } = await this.db.query(
            `DELETE FROM wa_messages
              WHERE conversation_id = $1
                AND id NOT IN (
                    SELECT id FROM wa_messages
                     WHERE conversation_id = $1
                     ORDER BY created_at DESC, id DESC
                     LIMIT $2
                )`,
            [conversationId, keep]
        );
        return rowCount;
    }

    /** All threads a user participates in (DM + every group). */
    async listForUser(rawJid) {
        const jid = JidParser.normalize(rawJid);
        return this.db.many(
            `SELECT c.*, g.subject AS group_subject
               FROM wa_conversations c
               JOIN wa_users u ON u.id = c.user_id
          LEFT JOIN wa_groups g ON g.id = c.group_id
              WHERE u.jid = $1
              ORDER BY c.last_message_at DESC NULLS LAST`,
            [jid]
        );
    }

    /** Audit row for observability. */
    async logUsage({
        userId = null,
        conversationId = null,
        model = null,
        ok = true,
        errorCode = null,
        latencyMs = null,
        promptChars = null,
        replyChars = null,
    }) {
        try {
            await this.db.query(
                `INSERT INTO wa_ai_usage
                     (user_id, conversation_id, model, ok, error_code, latency_ms, prompt_chars, reply_chars)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [userId, conversationId, model, ok, errorCode, latencyMs, promptChars, replyChars]
            );
        } catch {
            // Telemetry must never break a reply.
        }
    }
}

module.exports = ConversationRepository;
