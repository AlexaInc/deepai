'use strict';

const MemoryRepository = require('../repositories/MemoryRepository');

/**
 * MemoryExtractor
 * ---------------
 * Parses the `@MEMORY: {...}` tag the persona appends, strips it from the
 * user-visible text, and returns the facts to persist.
 *
 * Real models are messy, so the parser tolerates:
 *   @MEMORY: {"name": "Nimal"}
 *   @MEMORY:{"name":"Nimal","hobby":"cricket"}
 *   @memory: {'name': 'Nimal'}                     (single quotes)
 *   @MEMORY: {"name": "Nimal"} @MEMORY: {"city":"Galle"}   (multiple tags)
 *   *@MEMORY:* {"name": "Nimal"}                   (WhatsApp bolded tag)
 *   ```@MEMORY: {"name":"Nimal"}```                (fenced)
 *   @MEMORY: name: Nimal, hobby: cricket           (non-JSON fallback)
 */
class MemoryExtractor {
    // Tag, then a balanced-ish {...} block. Non-greedy, no nested braces expected.
    // `[*_~\s]*` absorbs WhatsApp emphasis the model may wrap the tag in,
    // e.g. "*@MEMORY:*" or "_@MEMORY:_".
    static TAG_JSON = /[*_~]*@\s*MEMORY\s*:?[*_~]*\s*(\{[^{}]*\})/gi;
    // Fallback: "@MEMORY: key: value, key2: value2" until end of line.
    static TAG_LOOSE = /[*_~]*@\s*MEMORY\s*:?[*_~]*\s*([^\n{}]+)/gi;

    /**
     * @param {string} reply raw model output
     * @returns {{ text: string, memories: Record<string,string>, found: boolean }}
     */
    static extract(reply) {
        const original = String(reply ?? '');
        if (!original) return { text: '', memories: {}, found: false };

        const memories = {};
        let found = false;
        let text = original;

        // --- Pass 1: JSON payloads -----------------------------------------
        text = text.replace(MemoryExtractor.TAG_JSON, (_match, jsonBlock) => {
            const parsed = MemoryExtractor._parseObject(jsonBlock);
            if (parsed) {
                Object.assign(memories, parsed);
                found = true;
                return '';
            }
            return '';
        });

        // --- Pass 2: loose "key: value" payloads ---------------------------
        if (/@\s*MEMORY/i.test(text)) {
            text = text.replace(MemoryExtractor.TAG_LOOSE, (_match, body) => {
                const parsed = MemoryExtractor._parseLoose(body);
                if (parsed && Object.keys(parsed).length) {
                    Object.assign(memories, parsed);
                    found = true;
                }
                return '';
            });
        }

        return {
            text: MemoryExtractor._tidy(text),
            memories: MemoryExtractor._sanitise(memories),
            found,
        };
    }

    /**
     * Remove any stray memory-tag remnants without extracting.
     * Used as a final safety net before sending to WhatsApp.
     */
    static strip(reply) {
        return MemoryExtractor.extract(reply).text;
    }

    /** @private JSON first, then a lenient single-quote repair. */
    static _parseObject(block) {
        try {
            const parsed = JSON.parse(block);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch {
            /* fall through to repair */
        }

        try {
            const repaired = block
                .replace(/'/g, '"')
                // quote bare keys: {name: "x"} -> {"name": "x"}
                .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_ -]*)\s*:/g, '$1"$2":')
                // drop trailing commas
                .replace(/,\s*}/g, '}');
            const parsed = JSON.parse(repaired);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch {
            /* give up on this block */
        }
        return null;
    }

    /** @private "name: Nimal, hobby: cricket" -> object */
    static _parseLoose(body) {
        const out = {};
        const segments = String(body).split(/[,;]+/);
        for (const segment of segments) {
            const match = segment.match(/^\s*["']?([A-Za-z_][A-Za-z0-9_ -]{0,40})["']?\s*[:=]\s*(.+?)\s*$/);
            if (!match) continue;
            const key = match[1];
            const value = match[2].replace(/^["']|["']$/g, '');
            if (key && value) out[key] = value;
        }
        return out;
    }

    /** @private Normalise keys/values through the repository's rules. */
    static _sanitise(raw) {
        const clean = {};
        for (const [k, v] of Object.entries(raw)) {
            const key = MemoryRepository.normalizeKey(k);
            const value = MemoryRepository.normalizeValue(v);
            if (key && value) clean[key] = value;
        }
        return clean;
    }

    /**
     * @private Tidy the leftover prose: collapse the hole the tag left behind,
     * drop empty code fences, and trim trailing separators.
     */
    static _tidy(text) {
        return String(text)
            .replace(/```\s*```/g, '')
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[\s\-–—•,;:]+$/g, '')
            .trim();
    }
}

module.exports = MemoryExtractor;
