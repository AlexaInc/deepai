'use strict';

/**
 * MemoryRepository
 * ----------------
 * Long-term facts about a person.
 *
 * Design rule: memories are keyed to `user_id` ONLY — never to a group. That
 * is what makes Alexa recognise the same person's details in a DM and in any
 * group. `UNIQUE (user_id, key)` means re-learning a key
 * (e.g. the user moves city) overwrites instead of piling up duplicates.
 */
class MemoryRepository {
    /** @param {import('../db/Database')} db */
    constructor(db) {
        this.db = db;
    }

    /** Reserved keys that must never be stored as "facts". */
    static BLOCKED_KEYS = new Set(['', 'null', 'undefined', 'none', 'n/a', 'memory', 'key', 'value']);

    static MAX_KEY = 64;
    static MAX_VALUE = 512;

    /**
     * Insert or update one fact.
     * @param {number} userId
     * @param {string} key
     * @param {string} value
     * @param {object} [opts]
     * @param {string} [opts.source='auto']
     * @param {string} [opts.learnedIn]
     * @param {number} [opts.confidence=1]
     * @param {Date|null} [opts.expiresAt]
     * @returns {Promise<object|null>}
     */
    async remember(userId, key, value, opts = {}) {
        const normalisedKey = MemoryRepository.normalizeKey(key);
        const normalisedValue = MemoryRepository.normalizeValue(value);
        if (!userId || !normalisedKey || !normalisedValue) return null;

        return this.db.one(
            `INSERT INTO wa_memories (user_id, key, value, source, learned_in, confidence, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (user_id, key) DO UPDATE
               SET value      = EXCLUDED.value,
                   source     = EXCLUDED.source,
                   learned_in = COALESCE(EXCLUDED.learned_in, wa_memories.learned_in),
                   confidence = EXCLUDED.confidence,
                   expires_at = EXCLUDED.expires_at,
                   updated_at = NOW()
             RETURNING *`,
            [
                userId,
                normalisedKey,
                normalisedValue,
                opts.source || 'auto',
                opts.learnedIn || null,
                typeof opts.confidence === 'number' ? opts.confidence : 1.0,
                opts.expiresAt || null,
            ]
        );
    }

    /**
     * Store many facts at once (one round-trip, single transaction).
     * @param {number} userId
     * @param {Record<string,any>} facts
     * @param {object} [opts]
     * @returns {Promise<object[]>}
     */
    async rememberMany(userId, facts, opts = {}) {
        if (!userId || !facts || typeof facts !== 'object') return [];

        const entries = Object.entries(facts)
            .map(([k, v]) => [MemoryRepository.normalizeKey(k), MemoryRepository.normalizeValue(v)])
            .filter(([k, v]) => k && v);

        if (!entries.length) return [];

        // Cap per-turn writes so a malformed model reply can't flood the table.
        const limited = entries.slice(0, 12);

        return this.db.transaction(async (client) => {
            const saved = [];
            for (const [key, value] of limited) {
                const { rows } = await client.query(
                    `INSERT INTO wa_memories (user_id, key, value, source, learned_in, confidence)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (user_id, key) DO UPDATE
                       SET value      = EXCLUDED.value,
                           source     = EXCLUDED.source,
                           learned_in = COALESCE(EXCLUDED.learned_in, wa_memories.learned_in),
                           updated_at = NOW()
                     RETURNING *`,
                    [
                        userId,
                        key,
                        value,
                        opts.source || 'auto',
                        opts.learnedIn || null,
                        typeof opts.confidence === 'number' ? opts.confidence : 1.0,
                    ]
                );
                saved.push(rows[0]);
            }
            return saved;
        });
    }

    /**
     * All live memories for a user (expired rows filtered out).
     * @param {number} userId
     * @param {number} [limit=25]
     */
    async getAll(userId, limit = 25) {
        if (!userId) return [];
        return this.db.many(
            `SELECT * FROM wa_memories
              WHERE user_id = $1
                AND (expires_at IS NULL OR expires_at > NOW())
              ORDER BY updated_at DESC
              LIMIT $2`,
            [userId, limit]
        );
    }

    /** Plain `{key: value}` map for prompt injection. */
    async getMap(userId, limit = 25) {
        const rows = await this.getAll(userId, limit);
        const map = {};
        for (const row of rows) map[row.key] = row.value;
        return map;
    }

    async get(userId, key) {
        const normalisedKey = MemoryRepository.normalizeKey(key);
        if (!userId || !normalisedKey) return null;
        return this.db.one(
            `SELECT * FROM wa_memories
              WHERE user_id = $1 AND key = $2
                AND (expires_at IS NULL OR expires_at > NOW())`,
            [userId, normalisedKey]
        );
    }

    async forget(userId, key) {
        const normalisedKey = MemoryRepository.normalizeKey(key);
        if (!userId || !normalisedKey) return false;
        const { rowCount } = await this.db.query(
            'DELETE FROM wa_memories WHERE user_id = $1 AND key = $2',
            [userId, normalisedKey]
        );
        return rowCount > 0;
    }

    async forgetAll(userId) {
        if (!userId) return 0;
        const { rowCount } = await this.db.query('DELETE FROM wa_memories WHERE user_id = $1', [userId]);
        return rowCount;
    }

    /** Bump usage counters for memories that were injected into a prompt. */
    async markUsed(userId, keys) {
        if (!userId || !Array.isArray(keys) || !keys.length) return;
        await this.db.query(
            'UPDATE wa_memories SET hit_count = hit_count + 1 WHERE user_id = $1 AND key = ANY($2::text[])',
            [userId, keys]
        );
    }

    /** Housekeeping: drop expired rows. */
    async pruneExpired() {
        const { rowCount } = await this.db.query(
            'DELETE FROM wa_memories WHERE expires_at IS NOT NULL AND expires_at <= NOW()'
        );
        return rowCount;
    }

    // ------------------------------------------------------------ helpers ---

    /** `Favourite Food ` -> `favourite_food` */
    static normalizeKey(key) {
        if (key == null) return null;
        const cleaned = String(key)
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, '_')
            .replace(/[^a-z0-9_]/g, '')
            .replace(/_{2,}/g, '_')
            .replace(/^_|_$/g, '');
        if (!cleaned || MemoryRepository.BLOCKED_KEYS.has(cleaned)) return null;
        return cleaned.slice(0, MemoryRepository.MAX_KEY);
    }

    /** Objects/arrays are JSON-stringified so nested model output still stores. */
    static normalizeValue(value) {
        if (value == null) return null;
        let str;
        if (typeof value === 'object') {
            try {
                str = JSON.stringify(value);
            } catch {
                return null;
            }
        } else {
            str = String(value);
        }
        str = str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
        if (!str || MemoryRepository.BLOCKED_KEYS.has(str.toLowerCase())) return null;
        return str.slice(0, MemoryRepository.MAX_VALUE);
    }
}

module.exports = MemoryRepository;
