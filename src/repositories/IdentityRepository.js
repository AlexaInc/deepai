'use strict';

const JidParser = require('../utils/JidParser');
const { ValidationError } = require('../core/errors');

/**
 * IdentityRepository
 * ------------------
 * The alias graph that makes "one human = one row" true.
 *
 * THE BUG THIS FIXES
 * ------------------
 * WhatsApp addresses the same person differently depending on the surface:
 *
 *   DM      -> 94771234567@s.whatsapp.net   (phone jid)
 *   Group   -> 78151912841263@lid           (privacy jid, LID addressing)
 *
 * The engine used to key `wa_users` on the jid alone, so the person who
 * introduced themselves in a DM was a *different* row in a group — and Alexa
 * answered "sorry, as a bot I can't remember you". Now every jid a person is
 * seen under is stored in `wa_user_identities` and resolves to one user id;
 * when two rows turn out to be the same human they are merged, memories and
 * transcripts included.
 */
class IdentityRepository {
    /** @param {import('../db/Database')} db */
    constructor(db) {
        this.db = db;
    }

    /**
     * The user a jid belongs to, following the alias graph.
     * @param {string} rawJid
     * @returns {Promise<object|null>} wa_users row
     */
    async findUserByJid(rawJid) {
        const jid = JidParser.normalize(rawJid);
        if (!jid) return null;
        return this.db.one(
            `SELECT u.* FROM wa_users u
               JOIN wa_user_identities i ON i.user_id = u.id
              WHERE i.jid = $1
              LIMIT 1`,
            [jid]
        );
    }

    /** The user that owns a phone number, whatever jid shape it was seen as. */
    async findUserByPhone(phone) {
        const digits = String(phone || '').replace(/\D/g, '');
        if (digits.length < 6) return null;
        return this.db.one(
            `SELECT u.* FROM wa_users u
               JOIN wa_user_identities i ON i.user_id = u.id
              WHERE i.phone = $1
              ORDER BY i.is_primary DESC, i.first_seen_at ASC
              LIMIT 1`,
            [digits]
        );
    }

    /** Every jid known for a user (primary first). */
    async aliasesFor(userId) {
        if (!userId) return [];
        return this.db.many(
            `SELECT jid, jid_type, phone, is_primary, source, last_seen_at
               FROM wa_user_identities
              WHERE user_id = $1
              ORDER BY is_primary DESC, first_seen_at ASC`,
            [userId]
        );
    }

    /**
     * Record `rawJid` as an alias of `userId`.
     * If the jid already belongs to someone else the two users are merged
     * (unless `merge:false`), because a jid can only ever be one human.
     *
     * @param {number} userId
     * @param {string} rawJid
     * @param {object} [opts]
     * @param {boolean} [opts.primary=false]
     * @param {string} [opts.source='observed']
     * @param {boolean} [opts.merge=true]
     * @returns {Promise<{linked:boolean, merged:boolean, userId:number}>}
     */
    async link(userId, rawJid, opts = {}) {
        const parsed = JidParser.parse(rawJid);
        if (!userId || !parsed.valid || parsed.isGroup) return { linked: false, merged: false, userId };

        const existing = await this.db.one('SELECT * FROM wa_user_identities WHERE jid = $1', [parsed.jid]);

        if (existing && Number(existing.user_id) !== Number(userId)) {
            if (opts.merge === false) return { linked: false, merged: false, userId };
            const keep = await this.merge(userId, existing.user_id);
            return { linked: true, merged: true, userId: keep.id };
        }

        await this.db.query(
            `INSERT INTO wa_user_identities (user_id, jid, jid_local, jid_server, jid_type, phone, is_primary, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (jid) DO UPDATE
               SET user_id      = EXCLUDED.user_id,
                   last_seen_at = NOW(),
                   phone        = COALESCE(wa_user_identities.phone, EXCLUDED.phone),
                   is_primary   = wa_user_identities.is_primary OR EXCLUDED.is_primary,
                   source       = COALESCE(wa_user_identities.source, EXCLUDED.source)`,
            [
                userId,
                parsed.jid,
                parsed.local,
                parsed.server,
                parsed.type,
                parsed.phone,
                Boolean(opts.primary),
                opts.source || 'observed',
            ]
        );

        // A phone jid teaches us the person's number even when the row was
        // first created from an anonymous @lid.
        if (parsed.phone) {
            await this.db.query('UPDATE wa_users SET phone = COALESCE(phone, $2) WHERE id = $1', [
                userId,
                parsed.phone,
            ]);
        }
        return { linked: true, merged: false, userId };
    }

    /**
     * Fold `loserId` into `winnerId`: memories, transcripts, group membership,
     * usage rows and aliases all move across, then the loser row is deleted.
     * The OLDER row always wins so the longest-lived history survives.
     *
     * @returns {Promise<object>} the surviving wa_users row
     */
    async merge(winnerId, loserId) {
        const a = Number(winnerId);
        const b = Number(loserId);
        if (!a || !b) throw new ValidationError('merge() needs two user ids');
        if (a === b) return this.db.one('SELECT * FROM wa_users WHERE id = $1', [a]);

        const rows = await this.db.many('SELECT * FROM wa_users WHERE id = ANY($1::bigint[])', [[a, b]]);
        if (rows.length < 2) {
            return this.db.one('SELECT * FROM wa_users WHERE id = $1', [rows[0]?.id || a]);
        }
        const [older, newer] = rows.sort(
            (x, y) => new Date(x.first_seen_at) - new Date(y.first_seen_at) || Number(x.id) - Number(y.id)
        );
        const keepId = Number(older.id);
        const dropId = Number(newer.id);

        return this.db.transaction(async (client) => {
            // --- memories: newest value of each key wins -------------------
            await client.query(
                `DELETE FROM wa_memories k
                  USING wa_memories d
                  WHERE k.user_id = $1 AND d.user_id = $2
                    AND k.key = d.key
                    AND d.updated_at > k.updated_at`,
                [keepId, dropId]
            );
            await client.query(
                `UPDATE wa_memories SET user_id = $1
                  WHERE user_id = $2
                    AND key NOT IN (SELECT key FROM wa_memories WHERE user_id = $1)`,
                [keepId, dropId]
            );
            await client.query('DELETE FROM wa_memories WHERE user_id = $1', [dropId]);

            // --- group membership ------------------------------------------
            await client.query(
                `UPDATE wa_group_members SET user_id = $1
                  WHERE user_id = $2
                    AND group_id NOT IN (SELECT group_id FROM wa_group_members WHERE user_id = $1)`,
                [keepId, dropId]
            );
            await client.query('DELETE FROM wa_group_members WHERE user_id = $1', [dropId]);

            // --- threads, messages, telemetry -------------------------------
            await client.query('UPDATE wa_conversations SET user_id = $1 WHERE user_id = $2', [keepId, dropId]);
            await client.query('UPDATE wa_messages SET user_id = $1 WHERE user_id = $2', [keepId, dropId]);
            await client.query('UPDATE wa_ai_usage SET user_id = $1 WHERE user_id = $2', [keepId, dropId]);

            // --- aliases -----------------------------------------------------
            await client.query(
                'UPDATE wa_user_identities SET user_id = $1, is_primary = FALSE WHERE user_id = $2',
                [keepId, dropId]
            );

            // --- roll the counters and the best-known profile up ------------
            await client.query(
                `UPDATE wa_users k SET
                     message_count  = k.message_count + d.message_count,
                     token_estimate = k.token_estimate + d.token_estimate,
                     push_name      = COALESCE(k.push_name, d.push_name),
                     display_name   = COALESCE(k.display_name, d.display_name),
                     phone          = COALESCE(k.phone, d.phone),
                     locale         = COALESCE(k.locale, d.locale),
                     is_blocked     = k.is_blocked OR d.is_blocked,
                     is_admin       = k.is_admin OR d.is_admin,
                     metadata       = d.metadata || k.metadata,
                     last_seen_at   = GREATEST(k.last_seen_at, d.last_seen_at),
                     updated_at     = NOW()
                  FROM wa_users d
                 WHERE k.id = $1 AND d.id = $2`,
                [keepId, dropId]
            );

            await client.query('DELETE FROM wa_users WHERE id = $1', [dropId]);
            await client.query('UPDATE wa_user_identities SET is_primary = TRUE WHERE user_id = $1 AND jid = (SELECT jid FROM wa_users WHERE id = $1)', [keepId]);

            const { rows: kept } = await client.query('SELECT * FROM wa_users WHERE id = $1', [keepId]);
            return kept[0];
        });
    }

    /** Make `rawJid` the canonical address of a user (used for context keys). */
    async setPrimary(userId, rawJid) {
        const jid = JidParser.normalize(rawJid);
        if (!userId || !jid) return null;
        await this.db.query('UPDATE wa_user_identities SET is_primary = (jid = $2) WHERE user_id = $1', [
            userId,
            jid,
        ]);
        return this.db.one('UPDATE wa_users SET jid = $2 WHERE id = $1 RETURNING *', [userId, jid]).catch(() => null);
    }

    /** The stable jid used to build conversation keys for this user. */
    async primaryJid(userId, fallback = null) {
        if (!userId) return fallback;
        const row = await this.db.one(
            `SELECT jid FROM wa_user_identities
              WHERE user_id = $1
              ORDER BY is_primary DESC, first_seen_at ASC
              LIMIT 1`,
            [userId]
        );
        return row?.jid || fallback;
    }
}

module.exports = IdentityRepository;
