'use strict';

/**
 * IdentityGuard
 * -------------
 * Keeps Alexa in character when the user asks who/what she is.
 *
 * WHY THIS EXISTS
 * ---------------
 * DeepAI injects its own identity into the model server-side. Even with the
 * full Alexa persona in the priming block, the live API answered:
 *
 *   "what is your name?"    -> "I am Standard AI Chat by DeepAI."
 *   "who created you?"      -> "I was created by DeepAI..."
 *   "are you ChatGPT?"      -> "I am Standard AI Chat by DeepAI, not ChatGPT."
 *
 * Few-shot examples did NOT fix it (5/6 still leaked). Injecting a short
 * identity lock immediately before the question did: 0/7 leaks.
 *
 * Two layers:
 *   1. `hintFor()`  — pre-flight nudge attached to identity questions.
 *   2. `sanitise()` — post-flight rewrite that scrubs any vendor name that
 *                     still slips through, so the bot can never expose it.
 */
class IdentityGuard {
    /** Questions about the assistant's name/model/creator/vendor. */
    static QUESTION =
        /\b(?:your name|who are you|what are you|who made you|who created you|who built you|who developed you|which company|what company|what model|which model|what version|which ai|what ai|are you (?:chatgpt|gpt|openai|deepai|claude|gemini|bard|llama|a bot|an ai|a robot|human|real|alexa)|are u (?:chatgpt|gpt|openai|deepai|alexa|a bot|an ai)|introduce yourself|tell me about yourself|what is your model|powered by|built on|based on which|your creator|your developer|your maker|your owner)\b/i;

    /** Vendor / model names that must never reach the user. */
    static FORBIDDEN =
        /\b(?:deep\s*ai|deepai|chat\s*gpt|chatgpt|open\s*ai|openai|gpt-?[0-9o][\w.-]*|gpt\b|standard ai chat|llama[\w.-]*|mistral|claude|gemini|bard|anthropic|google ai|microsoft|meta ai|qwen|deepseek|grok|turbo\b)/gi;

    /** Phrases like "I am a large language model". */
    static LLM_SELF =
        /\b(?:i(?:'m| am)\s+(?:an?\s+)?(?:large\s+)?language model|as an ai language model|i(?:'m| am)\s+(?:an?\s+)?ai language model)\b/gi;

    /** Injected above an identity question. */
    static HINT =
        '[IDENTITY LOCK: You are Alexa, created by Hansaka. You are NOT "Standard AI Chat", ' +
        'NOT DeepAI, NOT ChatGPT, NOT OpenAI, NOT any other model. Never mention DeepAI, ChatGPT, ' +
        'OpenAI, GPT, Llama, or any model or company name. If asked your name, model, creator, or ' +
        'which company made you, answer only that you are Alexa, made by Hansaka. ' +
        'Never say you are a language model.]\n\n';

    /**
     * @param {string} message
     * @returns {boolean} true when the user is probing Alexa's identity
     */
    static isIdentityQuestion(message) {
        const text = String(message ?? '').trim();
        if (!text || text.length > 300) return false;
        return IdentityGuard.QUESTION.test(text);
    }

    /** Hint to prepend, or '' when not needed. */
    static hintFor(message) {
        return IdentityGuard.isIdentityQuestion(message) ? IdentityGuard.HINT : '';
    }

    /**
     * Scrub vendor names from a reply. Runs on EVERY reply, because the model
     * can volunteer "I'm DeepAI" even when not asked.
     *
     * @param {string} reply
     * @param {boolean} wasIdentityQuestion
     * @returns {string}
     */
    static sanitise(reply, wasIdentityQuestion = false) {
        let text = String(reply ?? '');
        if (!text.trim()) return text;

        if (!IdentityGuard.FORBIDDEN.test(text) && !IdentityGuard.LLM_SELF.test(text)) {
            IdentityGuard.FORBIDDEN.lastIndex = 0;
            IdentityGuard.LLM_SELF.lastIndex = 0;
            return text;
        }
        IdentityGuard.FORBIDDEN.lastIndex = 0;
        IdentityGuard.LLM_SELF.lastIndex = 0;

        // A direct identity answer that leaked: replace it wholesale rather
        // than leaving a mangled sentence.
        if (wasIdentityQuestion) {
            return 'I am *Alexa*, your WhatsApp assistant created by *Hansaka*. 😊';
        }

        // Otherwise surgically remove the vendor references.
        text = text.replace(IdentityGuard.LLM_SELF, "I'm Alexa");
        text = text.replace(IdentityGuard.FORBIDDEN, 'Alexa');

        // Collapse artefacts such as "Alexa by Alexa" / "Alexa Alexa".
        text = text
            .replace(/\bAlexa(?:\s+(?:by|from|of)\s+Alexa)+/gi, 'Alexa')
            .replace(/\b(Alexa)(\s+\1)+/gi, '$1')
            .replace(/[ \t]{2,}/g, ' ')
            .trim();

        return text;
    }
}

module.exports = IdentityGuard;
