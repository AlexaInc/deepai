'use strict';

const MemoryRepository = require('../repositories/MemoryRepository');

/**
 * FactMiner
 * ---------
 * Deterministic, local extraction of personal facts from the USER's own words.
 *
 * WHY THIS EXISTS
 * ---------------
 * The persona asks the model to append `@MEMORY: {...}` when it learns
 * something. Live testing against DeepAI's free tier showed the model very
 * often ignores that instruction — it replied warmly to
 * "Hi, I'm Nimal and I love playing cricket" but emitted no tag at all, so
 * nothing was ever remembered.
 *
 * FactMiner closes that gap: it reads the user's message directly and pulls out
 * high-confidence facts using explicit patterns. It never guesses — every
 * pattern requires an unambiguous first-person statement.
 *
 * Model-emitted `@MEMORY` tags still win: MemoryExtractor results are merged
 * over these, so a smarter/paid model simply overrides the heuristics.
 */
class FactMiner {
    /**
     * Ordered list of [key, regex, groupIndex].
     * All patterns are anchored to first-person phrasing to avoid capturing
     * facts about third parties ("my friend lives in Kandy" is skipped).
     */
    static PATTERNS = [
        // --- identity -------------------------------------------------------
        // NOTE: these run case-INSENSITIVELY, so `[A-Z]` alone would also match
        // lowercase words. Trailing words are therefore guarded by NAME_STOP to
        // avoid swallowing connectives ("I'm Nimal and …" -> "Nimal", not "Nimal and").
        ['name', /\b(?:my name is|i am called|i'?m called|call me|this is)\s+([A-Za-z][A-Za-z'\u00C0-\u024F-]{1,20}(?:\s+[A-Za-z][A-Za-z'\u00C0-\u024F-]{1,20})?)/i],
        ['name', /^(?:hi|hello|hey)[,!\s]+(?:i'?m|i am)\s+([A-Za-z][A-Za-z'\u00C0-\u024F-]{1,20}(?:\s+[A-Za-z][A-Za-z'\u00C0-\u024F-]{1,20})?)\b/i],
        ['name', /\b(?:i'?m|i am)\s+([A-Z][a-z\u00C0-\u024F]{2,20})(?:\s*[,.!]|\s+and\b|$)/],

        // --- location -------------------------------------------------------
        ['location', /\b(?:i live in|i'?m from|i am from|i live at|i'?m based in|i am based in|i stay in)\s+([A-Za-z][A-Za-z .'\u00C0-\u024F-]{1,35}?)(?=\s*[,.!?]|\s+and\b|\s+but\b|$)/i],
        ['location', /\b(?:my (?:home ?town|city|country|location) is)\s+([A-Za-z][A-Za-z .'\u00C0-\u024F-]{1,35}?)(?=\s*[,.!?]|\s+and\b|$)/i],

        // --- preferences ------------------------------------------------------
        ['favourite_food', /\b(?:my favou?rite food is|i love eating|i love to eat)\s+([A-Za-z][A-Za-z .'\u00C0-\u024F-]{1,35}?)(?=\s*[,.!?]|\s+and\b|$)/i],
        ['favourite_colour', /\b(?:my favou?rite colou?r is)\s+([A-Za-z]{2,20})/i],
        ['favourite_team', /\b(?:my favou?rite team is|i support)\s+([A-Za-z][A-Za-z .'\u00C0-\u024F-]{1,35}?)(?=\s*[,.!?]|\s+and\b|$)/i],
        ['hobby', /\b(?:i love|i enjoy|i like)\s+(?:playing|watching|doing|reading|writing|cooking|making)\s+([A-Za-z][A-Za-z .'\u00C0-\u024F-]{1,30}?)(?=\s*[,.!?]|\s+and\b|$)/i],
        ['hobby', /\b(?:my hobby is|my hobbies are)\s+([A-Za-z][A-Za-z .,'\u00C0-\u024F-]{1,40}?)(?=\s*[.!?]|$)/i],

        // --- work / study -----------------------------------------------------
        ['job', /\b(?:i work as|i am a|i'?m a|i work at|my job is)\s+((?:an?\s+)?[A-Za-z][A-Za-z .'\u00C0-\u024F-]{2,35}?)(?=\s*[,.!?]|\s+and\b|$)/i],
        ['studies', /\b(?:i study|i'?m studying|i am studying|i'?m learning|i am learning)\s+([A-Za-z][A-Za-z .'\u00C0-\u024F-]{1,35}?)(?=\s*[,.!?]|\s+and\b|$)/i],
        ['school', /\b(?:i study at|i go to|my school is|my university is)\s+([A-Za-z][A-Za-z .'\u00C0-\u024F-]{2,40}?)(?=\s*[,.!?]|\s+and\b|$)/i],

        // --- misc ---------------------------------------------------------------
        ['age', /\b(?:i am|i'?m)\s+(\d{1,2})\s*(?:years? old|yrs? old|y\/o)\b/i],
        ['birthday', /\b(?:my birthday is|i was born on)\s+([A-Za-z0-9][A-Za-z0-9 ,\/-]{2,25}?)(?=\s*[.!?]|$)/i],
        ['language', /\b(?:i speak|my language is|i'?m fluent in)\s+([A-Za-z][A-Za-z ,'\u00C0-\u024F-]{2,30}?)(?=\s*[.!?]|\s+and\b|$)/i],
    ];

    /** Values that are never a real fact. */
    static JUNK = new Set([
        'a', 'an', 'the', 'not', 'no', 'yes', 'ok', 'okay', 'fine', 'good', 'bad', 'here',
        'there', 'sure', 'sorry', 'thanks', 'happy', 'sad', 'tired', 'busy', 'back', 'going',
        'just', 'still', 'now', 'today', 'looking', 'trying', 'sorry', 'glad', 'afraid',
        'bot', 'ai', 'user', 'someone', 'anyone', 'nobody', 'human', 'person', 'people',
    ]);

    /** Connectives that must never end a captured name. */
    static NAME_STOP = 'and|or|but|from|with|the|a|an|at|in|on|of|for|to|who|that|here|there|too|also|now|today';

    /** Third-party subjects — skip the whole clause. */
    static THIRD_PARTY = /\b(?:my (?:friend|brother|sister|mother|father|mom|dad|wife|husband|son|daughter|boss|teacher|cousin|uncle|aunt|neighbou?r)|he|she|they|his|her|their)\b/i;

    /**
     * Mine facts from a user message.
     * @param {string} message
     * @returns {Record<string,string>}
     */
    static mine(message) {
        const text = String(message ?? '').trim();
        if (!text || text.length > 1200) return {};

        const facts = {};

        for (const [key, pattern] of FactMiner.PATTERNS) {
            if (facts[key]) continue; // first match wins

            const match = text.match(pattern);
            if (!match || !match[1]) continue;

            // Reject if the sentence around the match is about someone else.
            const clause = FactMiner._clauseAround(text, match.index ?? 0);
            if (FactMiner.THIRD_PARTY.test(clause)) continue;

            const value = FactMiner._cleanValue(match[1], key);
            if (value) facts[key] = value;
        }

        return facts;
    }

    /** @private The sentence fragment containing the match. */
    static _clauseAround(text, index) {
        const start = Math.max(0, text.lastIndexOf('.', index), text.lastIndexOf(',', index));
        const endDot = text.indexOf('.', index);
        const end = endDot === -1 ? text.length : endDot;
        return text.slice(start, end);
    }

    /** @private Tidy and validate a captured value. */
    static _cleanValue(raw, key) {
        let value = String(raw)
            .trim()
            .replace(/^(?:an?|the)\s+/i, '')
            .replace(/[\s,.;:!?'"]+$/g, '')
            .replace(/\s{2,}/g, ' ')
            .trim();

        if (!value) return null;
        if (value.length < 2 || value.length > 60) return null;
        if (FactMiner.JUNK.has(value.toLowerCase())) return null;
        // Reject values that are mostly non-letters (except numeric age).
        if (key !== 'age' && !/[A-Za-z\u00C0-\u024F]{2,}/.test(value)) return null;
        if (key === 'age') {
            const n = Number.parseInt(value, 10);
            if (Number.isNaN(n) || n < 5 || n > 120) return null;
            return String(n);
        }
        // Names must look like names.
        if (key === 'name') {
            // Drop a trailing connective the greedy capture may have taken:
            // "Nimal and" -> "Nimal";  "Kasun from" -> "Kasun".
            value = value.replace(new RegExp(`\\s+(?:${FactMiner.NAME_STOP})$`, 'i'), '').trim();
            if (!value) return null;
            if (!/^[A-Za-z\u00C0-\u024F][A-Za-z'\u00C0-\u024F-]*(?:\s+[A-Za-z'\u00C0-\u024F-]+)?$/.test(value)) return null;
            if (value.split(/\s+/).length > 2) return null;
            // A single all-lowercase common word is not a name.
            if (FactMiner.JUNK.has(value.toLowerCase())) return null;
            value = value
                .split(/\s+/)
                .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                .join(' ');
        }

        return MemoryRepository.normalizeValue(value);
    }
}

module.exports = FactMiner;
