'use strict';

const JidParser = require('../utils/JidParser');

/**
 * IdentityResolver
 * ----------------
 * Turns "whatever WhatsApp handed us this time" into ONE canonical person.
 *
 * A Baileys message can carry several addresses for the same sender:
 *
 *   key.participant        78151912841263@lid          (group, LID addressing)
 *   key.participantAlt     94771234567@s.whatsapp.net  (the phone behind it)
 *   key.remoteJid          94771234567@s.whatsapp.net  (DM)
 *
 * Pass any of them (`userId`, `userLid`, `userPhone`, `aliases: []`) and the
 * resolver links them together, merging previously-separate rows so the facts
 * learned in a DM are instantly available in every group.
 */
class IdentityResolver {
    /**
     * @param {import('../repositories/UserRepository')} users
     * @param {import('../repositories/IdentityRepository')} identities
     * @param {import('../core/Config')} config
     */
    constructor(users, identities, config) {
        this.users = users;
        this.identities = identities;
        this.config = config;
        this.log = config.logger;
    }

    /**
     * Collect every jid-shaped identifier in a chat() params object.
     * Pure function — unit-testable without a database.
     *
     * @param {object} params
     * @returns {string[]} canonical, de-duplicated user jids (primary first)
     */
    static collectAliases(params = {}) {
        const candidates = [
            params.userId,
            params.user,
            params.jid,
            params.userLid,
            params.lid,
            params.lidJid,
            params.userAltId,
            params.altJid,
            params.participantAlt,
            params.participantPn,
            params.senderPn,
            params.userPhone,
            params.phone,
            params.phoneJid,
            ...(Array.isArray(params.aliases) ? params.aliases : []),
        ];

        const seen = new Set();
        const out = [];
        for (const candidate of candidates) {
            const jid = IdentityResolver.toUserJid(candidate);
            if (!jid || seen.has(jid)) continue;
            seen.add(jid);
            out.push(jid);
        }
        return out;
    }

    /**
     * Normalise one identifier to a canonical user jid.
     * Bare digits are treated as a phone number.
     * @param {string} value
     * @returns {string|null}
     */
    static toUserJid(value) {
        if (value == null) return null;
        let raw = String(value).trim();
        if (!raw) return null;
        if (/^\+?\d{6,}$/.test(raw)) raw = `${raw.replace(/\D/g, '')}@s.whatsapp.net`;
        const parsed = JidParser.parse(raw);
        if (!parsed.valid || parsed.isGroup) return null;
        return parsed.jid;
    }

    /**
     * Find-or-create the person behind these addresses, linking (and merging
     * when necessary) so they all resolve to one row from now on.
     *
     * @param {string[]} aliases  canonical jids, primary first
     * @param {object} [info]     { pushName, metadata }
     * @returns {Promise<{user:object, primaryJid:string, aliases:string[], merged:boolean}>}
     */
    async resolve(aliases, info = {}) {
        const list = aliases.filter(Boolean);
        const primary = list[0];
        if (!primary) throw new Error('IdentityResolver.resolve(): no usable jid');

        // Identity linking can be switched off for a plain one-jid-per-user setup.
        if (!this.config.linkIdentities) {
            const user = await this.users.upsertUser(primary, info);
            return { user, primaryJid: JidParser.normalize(primary), aliases: [primary], merged: false };
        }

        // ---- 1. who do we already know? -------------------------------------
        const found = new Map(); // userId -> user row
        for (const jid of list) {
            const row = await this.identities.findUserByJid(jid);
            if (row) found.set(Number(row.id), row);
        }
        // A phone number is an identity even when the jid shape differs.
        for (const jid of list) {
            const { phone } = JidParser.parse(jid);
            if (!phone || found.size) continue;
            const row = await this.identities.findUserByPhone(phone);
            if (row) found.set(Number(row.id), row);
        }

        let merged = false;
        let user;

        if (found.size === 0) {
            // ---- 2. brand new person -----------------------------------------
            user = await this.users.upsertUser(primary, info);
        } else {
            // ---- 3. one or more known rows: keep the oldest, fold in the rest --
            const rows = [...found.values()].sort(
                (a, b) => new Date(a.first_seen_at) - new Date(b.first_seen_at) || Number(a.id) - Number(b.id)
            );
            user = rows[0];
            if (rows.length > 1 && this.config.mergeIdentities) {
                for (const other of rows.slice(1)) {
                    user = await this.identities.merge(user.id, other.id);
                    merged = true;
                }
                if (this.config.debug) {
                    this.log.info?.(
                        `[AlexaAI] Merged ${rows.length} duplicate identities into user #${user.id} (${list.join(', ')})`
                    );
                }
            }
            // Refresh push name / last_seen on the row we are keeping.
            user = (await this.users.touch(user.id, info)) || user;
        }

        // ---- 4. make sure every address points at this row -------------------
        for (const jid of list) {
            const result = await this.identities.link(user.id, jid, {
                primary: jid === JidParser.normalize(user.jid),
                source: jid === primary ? 'message' : 'alias',
                merge: this.config.mergeIdentities,
            });
            if (result.merged) {
                merged = true;
                user = (await this.users.findById(result.userId)) || user;
            }
        }

        const primaryJid = (await this.identities.primaryJid(user.id, user.jid)) || user.jid;
        return { user, primaryJid, aliases: list, merged };
    }

    /**
     * Manually declare that two addresses are the same human.
     * Used by `ai.linkIdentity(a, b)` when the host bot learns a LID↔phone
     * mapping from Baileys (`sock.signalRepository.lidMapping`).
     */
    async link(jidA, jidB, source = 'manual') {
        const a = IdentityResolver.toUserJid(jidA);
        const b = IdentityResolver.toUserJid(jidB);
        if (!a || !b) return null;

        const userA = (await this.identities.findUserByJid(a)) || (await this.users.upsertUser(a));
        const result = await this.identities.link(userA.id, b, { source, merge: true });
        return this.users.findById(result.userId || userA.id);
    }
}

module.exports = IdentityResolver;
