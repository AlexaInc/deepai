'use strict';

/**
 * JidParser
 * ---------
 * Normalises every WhatsApp identifier shape the bot may hand us.
 *
 * Supported inputs:
 *   78151912841263@lid              -> linked-device / privacy id  (user)
 *   94771234567@s.whatsapp.net      -> classic phone jid           (user)
 *   94771234567@c.us                -> legacy web jid              (user)
 *   94771234567:12@s.whatsapp.net   -> jid with device suffix      (user)
 *   120363413125431525@g.us         -> group                       (group)
 *   xxxxx@broadcast / @newsletter   -> broadcast / channel
 *
 * The parser is intentionally forgiving: WhatsApp libraries pass slightly
 * different shapes depending on version, and a memory system must never lose
 * a user just because a `:device` suffix appeared.
 */
class JidParser {
    static SERVER_LID = 'lid';
    static SERVER_USER = 's.whatsapp.net';
    static SERVER_LEGACY = 'c.us';
    static SERVER_GROUP = 'g.us';
    static SERVER_BROADCAST = 'broadcast';
    static SERVER_NEWSLETTER = 'newsletter';

    /**
     * Parse any jid into a stable descriptor.
     * @param {string} rawJid
     * @returns {{
     *   raw: string, jid: string, local: string, server: string,
     *   type: 'lid'|'user'|'group'|'broadcast'|'newsletter'|'unknown',
     *   isGroup: boolean, isUser: boolean, isLid: boolean, device: number|null,
     *   phone: string|null, valid: boolean
     * }}
     */
    static parse(rawJid) {
        const empty = {
            raw: rawJid == null ? '' : String(rawJid),
            jid: '',
            local: '',
            server: '',
            type: 'unknown',
            isGroup: false,
            isUser: false,
            isLid: false,
            device: null,
            phone: null,
            valid: false,
        };

        if (rawJid == null) return empty;

        const raw = String(rawJid).trim();
        if (!raw) return empty;

        // Strip anything after a space (some libs append push names)
        const cleaned = raw.split(/\s+/)[0];

        const at = cleaned.lastIndexOf('@');
        let local = at === -1 ? cleaned : cleaned.slice(0, at);
        const server = at === -1 ? '' : cleaned.slice(at + 1).toLowerCase();

        // Split device suffix -> "94771234567:12" => local 94771234567, device 12
        let device = null;
        const colon = local.indexOf(':');
        if (colon !== -1) {
            const devPart = local.slice(colon + 1);
            local = local.slice(0, colon);
            const parsedDev = Number.parseInt(devPart, 10);
            device = Number.isNaN(parsedDev) ? null : parsedDev;
        }

        local = local.replace(/[^0-9a-zA-Z_-]/g, '');

        let type = 'unknown';
        if (server === JidParser.SERVER_GROUP) type = 'group';
        else if (server === JidParser.SERVER_LID) type = 'lid';
        else if (server === JidParser.SERVER_USER || server === JidParser.SERVER_LEGACY) type = 'user';
        else if (server === JidParser.SERVER_BROADCAST) type = 'broadcast';
        else if (server === JidParser.SERVER_NEWSLETTER) type = 'newsletter';
        else if (!server && /^\d{6,}$/.test(local)) type = 'user'; // bare number

        const isGroup = type === 'group';
        const isLid = type === 'lid';
        const isUser = type === 'user' || isLid;

        // Only a real phone jid yields a usable phone number. @lid is a privacy
        // id and must NEVER be treated as a phone number.
        const phone = type === 'user' && /^\d{6,}$/.test(local) ? local : null;

        const normalisedServer = server || (type === 'user' ? JidParser.SERVER_USER : '');

        return {
            raw,
            jid: normalisedServer ? `${local}@${normalisedServer}` : local,
            local,
            server: normalisedServer,
            type,
            isGroup,
            isUser,
            isLid,
            device,
            phone,
            valid: Boolean(local) && type !== 'unknown',
        };
    }

    /**
     * Canonical, device-stripped jid used as the DB primary key for a user/group.
     * @param {string} rawJid
     * @returns {string}
     */
    static normalize(rawJid) {
        return JidParser.parse(rawJid).jid;
    }

    static isGroup(rawJid) {
        return JidParser.parse(rawJid).isGroup;
    }

    static isUser(rawJid) {
        return JidParser.parse(rawJid).isUser;
    }

    static isLid(rawJid) {
        return JidParser.parse(rawJid).isLid;
    }

    /**
     * Build the conversation context key.
     * DM      -> "dm:<userJid>"
     * Group   -> "group:<groupJid>:<userJid>"  (per-user thread inside a group)
     * @param {string} userJid
     * @param {string} [groupJid]
     * @param {boolean} [sharedGroupThread=false] one thread for the whole group
     * @returns {string}
     */
    static contextKey(userJid, groupJid, sharedGroupThread = false) {
        const user = JidParser.normalize(userJid);
        const group = groupJid ? JidParser.normalize(groupJid) : '';
        if (!group) return `dm:${user}`;
        return sharedGroupThread ? `group:${group}` : `group:${group}:${user}`;
    }
}

module.exports = JidParser;
