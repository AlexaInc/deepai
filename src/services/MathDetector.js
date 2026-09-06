'use strict';

/**
 * MathDetector
 * ------------
 * Recognises maths questions so PromptBuilder can attach a one-line "MATH MODE"
 * instruction directly above the user's message.
 *
 * WHY: the persona says "provide ONLY the direct final formula and result, no
 * step-by-step". Live testing showed the free-tier model ignores that when the
 * rule sits far up in a long persona — it returned a full nine-line derivation
 * for "area of a circle with radius 7". Repeating the constraint next to the
 * question fixed it (verified: `A = π * 7² ≈ 153.938`).
 */
class MathDetector {
    /** Explicit calculation verbs. */
    static VERBS = /\b(calculate|compute|evaluate|solve|simplify|factor|derive|integrate|differentiate|convert)\b/i;

    /** Arithmetic expressions: 12 * 47, 2+2, 15/3, 2^8. */
    static EXPRESSION = /\d\s*[+\-*/^×÷]\s*\d/;

    /** Percentage / fraction phrasing. */
    static PERCENT = /\b\d+(?:\.\d+)?\s*%|\bpercent(?:age)?\s+of\b|\b\d+\s*%\s*of\b/i;

    /** Common maths nouns paired with numbers. */
    static TOPIC = /\b(area|perimeter|circumference|volume|radius|diameter|hypotenuse|square root|sqrt|cube root|factorial|average|mean|median|logarithm|log|sine|cosine|tangent|equation|derivative|integral)\b/i;

    /** "what is X" followed by something numeric. */
    static WHAT_IS_NUMBER = /\b(?:what(?:'?s| is)|how much is)\b[^?]*\d/i;

    /** Phrases that look mathematical but want prose, not a bare number. */
    static PROSE = /\b(explain|why|history|who invented|prove|proof|meaning|difference between|tell me about|what does .* mean|help me understand|teach|learn)\b/i;

    /**
     * @param {string} message
     * @returns {boolean}
     */
    static isMath(message) {
        const text = String(message ?? '').trim();
        if (!text || text.length > 400) return false;

        // A request for explanation overrides math mode.
        if (MathDetector.PROSE.test(text)) return false;

        // Must contain at least one digit to be a calculation.
        if (!/\d/.test(text)) return false;

        if (MathDetector.EXPRESSION.test(text)) return true;
        if (MathDetector.PERCENT.test(text)) return true;
        if (MathDetector.VERBS.test(text)) return true;
        if (MathDetector.TOPIC.test(text)) return true;
        if (MathDetector.WHAT_IS_NUMBER.test(text)) return true;

        return false;
    }

    /** The instruction appended above a maths question. */
    static HINT =
        '[MATH MODE: Reply with ONLY the final formula and result on ONE line wrapped in single backticks. ' +
        'No explanation, no steps, no restating the question, no extra sentences. ' +
        'Example: `A = π * 7² ≈ 153.938`]\n\n';
}

module.exports = MathDetector;
