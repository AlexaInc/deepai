'use strict';

const JidParser = require('../utils/JidParser');
const { ValidationError } = require('../core/errors');

/**
 * UserRepository
 * --------------
 * Users and groups. One `wa_users` row per person, keyed by canonical jid, so
 * the same human is recognised in a DM and in every group.
 */
class UserRepository {
    /** @param {import('../db/Database')} db */
    constructor(db) {
        this.db = db;
    }

    /**
     * Find-or-create a user, refreshing `last_seen_at` and push name.
     * @param {string} rawJid
     * @param {object} [info]
     * @param {string} [info.pushName]
     * @param {object} [info.metadata]
     * @returns {Promise<object>} user row
     */
    async upsertUser(rawJid, info = {}) {
        const parsed = JidParser.parse(rawJid);
        if (!parsed.valid || parsed.isGroup) {
            throw new ValidationError(`Invalid user jid: ${JSON.stringify(rawJid)}`);
        }

        const pushName = UserRepository._clean(info.pushName, 128);
        const metadata = info.metadata && typeof info.metadata === 'object' ? info.metadata : {};

        // COALESCE keeps a previously-known push name if this event lacks one.
        return this.db.one(
            `INSERT INTO wa_users (jid, jid_local, jid_server, jid_type, phone, push_name, metadata, last_seen_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
             ON CONFLICT (jid) DO UPDATE
               SET last_seen_at = NOW(),
                   push_name    = COALESCE(NULLIF(EXCLUDED.push_name, ''), wa_users.push_name),
                   phone        = COALESCE(wa_users.phone, EXCLUDED.phone),
                   metadata     = wa_users.metadata || EXCLUDED.metadata
             RETURNING *`,
            [
                parsed.jid,
                parsed.local,
                parsed.server,
                parsed.type,
                parsed.phone,
                pushName,
                JSON.stringify(metadata),
            ]
        );
    }

    /**
     * Find-or-create a group.
     * @param {string} rawJid
     * @param {object} [info]
     * @param {string} [info.subject]
     * @returns {Promise<object|null>}
     */
    async upsertGroup(rawJid, info = {}) {
        if (!rawJid) return null;
        const parsed = JidParser.parse(rawJid);
        if (!parsed.valid || !parsed.isGroup) {
            throw new ValidationError(`Invalid group jid: ${JSON.stringify(rawJid)}`);
        }

        const subject = UserRepository._clean(info.subject, 256);
        const metadata = info.metadata && typeof info.metadata === 'object' ? info.metadata : {};

        return this.db.one(
            `INSERT INTO wa_groups (jid, subject, metadata, last_seen_at)
             VALUES ($1, $2, $3::jsonb, NOW())
             ON CONFLICT (jid) DO UPDATE
               SET last_seen_at = NOW(),
                   subject      = COALESCE(NULLIF(EXCLUDED.subject, ''), wa_groups.subject),
                   metadata     = wa_groups.metadata || EXCLUDED.metadata
             RETURNING *`,
            [parsed.jid, subject, JSON.stringify(metadata)]
        );
    }

    /** Record that `userId` is present in `groupId`. */
    async linkMember(groupId, userId, isAdmin = false) {
        if (!groupId || !userId) return null;
        return this.db.one(
            `INSERT INTO wa_group_members (group_id, user_id, is_admin, last_seen_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (group_id, user_id) DO UPDATE
               SET last_seen_at  = NOW(),
                   message_count = wa_group_members.message_count + 1,
                   is_admin      = EXCLUDED.is_admin OR wa_group_members.is_admin
             RETURNING *`,
            [groupId, userId, Boolean(isAdmin)]
        );
    }

    async findByJid(rawJid) {
        const jid = JidParser.normalize(rawJid);
        if (!jid) return null;
        return this.db.one('SELECT * FROM wa_users WHERE jid = $1', [jid]);
    }

    async findGroupByJid(rawJid) {
        const jid = JidParser.normalize(rawJid);
        if (!jid) return null;
        return this.db.one('SELECT * FROM wa_groups WHERE jid = $1', [jid]);
    }

    async incrementMessageCount(userId, chars = 0) {
        if (!userId) return;
        await this.db.query(
            `UPDATE wa_users
                SET message_count  = message_count + 1,
                    token_estimate = token_estimate + $2
              WHERE id = $1`,
            [userId, Math.ceil(chars / 4)]
        );
    }

    async setBlocked(rawJid, blocked = true) {
        const jid = JidParser.normalize(rawJid);
        return this.db.one(
            'UPDATE wa_users SET is_blocked = $2 WHERE jid = $1 RETURNING *',
            [jid, Boolean(blocked)]
        );
    }

    async isBlocked(rawJid) {
        const user = await this.findByJid(rawJid);
        return Boolean(user?.is_blocked);
    }

    async setGroupEnabled(rawJid, enabled = true) {
        const jid = JidParser.normalize(rawJid);
        return this.db.one(
            'UPDATE wa_groups SET is_enabled = $2 WHERE jid = $1 RETURNING *',
            [jid, Boolean(enabled)]
        );
    }

    /** Name Alexa should use: learned name > WhatsApp push name > fallback. */
    async resolveDisplayName(userId, fallback = 'there') {
        const row = await this.db.one(
            `SELECT COALESCE(
                        u.display_name,
                        (SELECT m.value FROM wa_memories m
                          WHERE m.user_id = u.id AND m.key IN ('name','full_name','nickname')
                          ORDER BY (m.key = 'name') DESC, m.updated_at DESC LIMIT 1),
                        u.push_name
                    ) AS name
               FROM wa_users u WHERE u.id = $1`,
            [userId]
        );
        return UserRepository._clean(row?.name, 64) || fallback;
    }

    async setDisplayName(rawJid, name) {
        const jid = JidParser.normalize(rawJid);
        return this.db.one('UPDATE wa_users SET display_name = $2 WHERE jid = $1 RETURNING *', [
            jid,
            UserRepository._clean(name, 64),
        ]);
    }

    async stats() {
        return this.db.one(`
            SELECT (SELECT COUNT(*) FROM wa_users)                          AS users,
                   (SELECT COUNT(*) FROM wa_groups)                         AS groups,
                   (SELECT COUNT(*) FROM wa_conversations)                  AS conversations,
                   (SELECT COUNT(*) FROM wa_messages)                       AS messages,
                   (SELECT COUNT(*) FROM wa_memories)                       AS memories,
                   (SELECT COUNT(*) FROM wa_users WHERE last_seen_at > NOW() - INTERVAL '24 hours') AS active_24h
        `);
    }

    static _clean(value, max) {
        if (value == null) return null;
        const str = String(value).replace(/[\u0000-\u001F\u007F]/g, '').trim();
        if (!str) return null;
        return str.length > max ? str.slice(0, max) : str;
    }
}

module.exports = UserRepository;
