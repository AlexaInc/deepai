'use strict';

/**
 * ResponseFormatter
 * -----------------
 * Enforces the persona's WhatsApp-only formatting rules on the model output.
 *
 * Live testing confirmed the model DOES emit forbidden Markdown (`**Hello
 * Sahan!**`, `### Heading`) despite explicit instructions, so this pass is a
 * hard guarantee rather than a nicety.
 *
 * Conversions:
 *   **bold**      -> *bold*
 *   __bold__      -> *bold*
 *   ### Heading   -> *Heading*
 *   * bullet      -> • bullet      (a leading "* " would render as bold in WA)
 *   [txt](url)    -> txt (url)
 *
 * Fenced code blocks are protected and restored verbatim.
 */
class ResponseFormatter {
    /**
     * @param {string} reply
     * @returns {string}
     */
    static format(reply) {
        let text = String(reply ?? '');
        if (!text.trim()) return '';

        // Safety net: if the model ever echoes the internal recall note or an
        // image-context marker back at the user, strip those lines.
        text = text
            .replace(/^\s*\[Remembered facts about this person[^\]]*\]\s*/gim, '')
            .replace(/^\s*\[Image attached[^\]]*\]\s*/gim, '')
            .replace(/^\s*\[MATH MODE:[^\]]*\]\s*/gim, '');

        // --- protect fenced code blocks ------------------------------------
        const blocks = [];
        text = text.replace(/```[\s\S]*?```/g, (match) => {
            blocks.push(match);
            return `\u0000CODE${blocks.length - 1}\u0000`;
        });

        // --- protect inline code -------------------------------------------
        const inline = [];
        text = text.replace(/`[^`\n]+`/g, (match) => {
            inline.push(match);
            return `\u0000INL${inline.length - 1}\u0000`;
        });

        // --- markdown links -> "text (url)" --------------------------------
        text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');

        // --- bold/italic normalisation --------------------------------------
        // ***x*** or ___x___ -> _*x*_   (WhatsApp bold-italic)
        text = text.replace(/\*\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*\*/g, '_*$1*_');
        text = text.replace(/___(?!\s)([^_\n]+?)(?<!\s)___/g, '_*$1*_');
        // **x** -> *x*
        text = text.replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, '*$1*');
        // __x__ -> *x*
        text = text.replace(/__(?!\s)([^_\n]+?)(?<!\s)__/g, '*$1*');

        // --- headings -> bold line ------------------------------------------
        text = text.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, (_m, heading) => {
            const clean = heading.replace(/[*_~]/g, '').trim();
            return clean ? `*${clean}*` : '';
        });

        // --- bullets: "* item" / "- item" / "+ item" -> "• item" ------------
        text = text.replace(/^(\s*)[*+-]\s+(?=\S)/gm, '$1• ');

        // --- horizontal rules -------------------------------------------------
        text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, '──────────');

        // --- blockquote markers are not supported ----------------------------
        text = text.replace(/^\s{0,3}>\s?/gm, '');

        // --- tidy whitespace ---------------------------------------------------
        text = text
            .replace(/[ \t]+$/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        // --- restore protected segments ---------------------------------------
        text = text.replace(/\u0000INL(\d+)\u0000/g, (_m, i) => inline[Number(i)] ?? '');
        text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => blocks[Number(i)] ?? '');

        return text;
    }

    /**
     * Split an over-long reply on natural boundaries so the bot can send it as
     * sequential WhatsApp messages.
     * @param {string} text
     * @param {number} [limit=4000]
     * @returns {string[]}
     */
    static chunk(text, limit = 4000) {
        const input = String(text ?? '');
        if (input.length <= limit) return input ? [input] : [];

        const chunks = [];
        let remaining = input;

        while (remaining.length > limit) {
            let cut = remaining.lastIndexOf('\n\n', limit);
            if (cut < limit * 0.5) cut = remaining.lastIndexOf('\n', limit);
            if (cut < limit * 0.5) cut = remaining.lastIndexOf('. ', limit);
            if (cut < limit * 0.5) cut = remaining.lastIndexOf(' ', limit);
            if (cut <= 0) cut = limit;

            chunks.push(remaining.slice(0, cut).trim());
            remaining = remaining.slice(cut).trim();
        }
        if (remaining) chunks.push(remaining);
        return chunks;
    }
}

module.exports = ResponseFormatter;
