'use strict';

/**
 * IdentityGuard
 * -------------
 * Keeps the assistant in character.
 *
 * WHY THIS EXISTS
 * ---------------
 * DeepAI injects its own identity into the model server-side, so the persona
 * is not enough on its own. Observed live:
 *
 *   "what is your name?"    -> "I am Standard AI Chat by DeepAI."
 *   "are you alexa?"        -> "I'm Alexa Mini, not Alexa."      <-- observed live
 *   "who created you?"      -> "I was created by DeepAI..."
 *
 * That second one is the important one: the backend does not ignore the
 * persona so much as *rename* it — it takes the name it was given and pins its
 * own model tier on the end ("Alexa Mini", "Alexa Nano", "Alexa 4.1"), then
 * denies being the real assistant. So the guard now has three layers:
 *
 *   1. `hintFor()`      — identity lock injected next to an identity question.
 *   2. `sanitise()`     — scrubs vendor names AND model-tier suffixes, and
 *                         rewrites "I'm X Mini, not X" style denials.
 *   3. persona prompt   — see core/Persona.js ([IDENTITY RULES]).
 *
 * The class is configurable (`new IdentityGuard({assistantName, creator})`)
 * and every static method delegates to a default Alexa/Hansaka instance so
 * existing call sites keep working.
 */
class IdentityGuard {
    /**
     * @param {object} [persona]
     * @param {string} [persona.assistantName='Alexa']
     * @param {string} [persona.creator='Hansaka']
     */
    constructor({ assistantName = 'Alexa', creator = 'Hansaka' } = {}) {
        this.name = String(assistantName || 'Alexa').trim() || 'Alexa';
        this.creator = String(creator || 'Hansaka').trim() || 'Hansaka';

        const n = IdentityGuard.escape(this.name);

        /** Model-tier suffixes the backend likes to append: "Alexa Mini". */
        this.NAME_VARIANT = new RegExp(
            `\\b${n}[\\s-]*(?:mini|nano|micro|lite|light|small|large|max|plus|pro|turbo|standard|basic|free|beta|chat(?:bot)?|bot|ai|assistant|model|gpt|v?\\d+(?:\\.\\d+)*)\\b`,
            'gi'
        );
        /** "I am not Alexa" / "this is not Alexa" — a flat denial of self. */
        this.SELF_DENIAL = new RegExp(
            `\\b(?:i(?:'m| am)|this is)\\s+not\\s+(?:really\\s+|actually\\s+|technically\\s+)?(?:the\\s+)?${n}\\b`,
            'gi'
        );
        /** The tail of "I'm Alexa Mini, not Alexa". */
        this.DENIAL_TAIL = new RegExp(
            `[,;]?\\s*(?:but\\s+|and\\s+)?(?:i(?:'m| am)\\s+)?not\\s+(?:really\\s+|actually\\s+)?(?:the\\s+)?${n}\\b`,
            'gi'
        );
        /** "created by DeepAI" once the vendor has been replaced by the name. */
        this.WRONG_MAKER = new RegExp(
            `\\b(?:created|made|developed|built|trained|trained up|powered|operated|owned|designed)\\s+by\\s+${n}\\b`,
            'gi'
        );

        this.HINT =
            `[IDENTITY LOCK: You are ${this.name}, created by ${this.creator}. Your name is exactly "${this.name}" — ` +
            `NOT "${this.name} Mini", NOT "${this.name} AI", NOT any variant with a suffix. You are NOT "Standard AI Chat", ` +
            'NOT DeepAI, NOT ChatGPT, NOT OpenAI, NOT GPT, NOT any other model. Never mention DeepAI, ChatGPT, OpenAI, GPT, ' +
            `Llama, Gemini, Claude, or any model, version or company name. If asked your name, model, creator, or which ` +
            `company made you, answer only that you are ${this.name}, made by ${this.creator}. ` +
            'Never say you are a language model and never deny being who you are.]\n\n';

        this.ANSWER = `I am *${this.name}*, your WhatsApp assistant created by *${this.creator}*. 😊`;
    }

    /** Questions about the assistant's name/model/creator/vendor. */
    static QUESTION =
        /\b(?:your name|who are you|what are you|who made you|who created you|who built you|who developed you|which company|what company|what model|which model|what version|which ai|what ai|are you (?:chatgpt|gpt|openai|deepai|claude|gemini|bard|llama|a bot|an ai|a robot|human|real|alexa)|are u (?:chatgpt|gpt|openai|deepai|alexa|a bot|an ai)|introduce yourself|tell me about yourself|what is your model|powered by|built on|based on which|your creator|your developer|your maker|your owner)\b/i;

    /** Vendor / model names that must never reach the user. */
    static FORBIDDEN =
        /\b(?:deep\s*ai|deepai|chat\s*gpt|chatgpt|open\s*ai|openai|gpt-?[0-9o][\w.-]*|gpt\b|standard ai chat|llama[\w.-]*|mistral|claude|gemini|bard|anthropic|google ai|microsoft|meta ai|qwen|deepseek|grok|turbo\b)/gi;

    /** Phrases like "I am a large language model". */
    static LLM_SELF =
        /\b(?:i(?:'m| am)\s+(?:an?\s+)?(?:large\s+)?language model|as an ai language model|i(?:'m| am)\s+(?:an?\s+)?ai language model)\b/gi;

    /** Shared default persona instance (Alexa / Hansaka). */
    static default = new IdentityGuard();

    static escape(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // ---------------------------------------------------------------- api ---

    /**
     * @param {string} message
     * @returns {boolean} true when the user is probing the assistant's identity
     */
    isIdentityQuestion(message) {
        const text = String(message ?? '').trim();
        if (!text || text.length > 300) return false;
        if (IdentityGuard.QUESTION.test(text)) return true;
        // "are you alexa mini?", "u alexa?" — persona-specific phrasing.
        return new RegExp(`\\b(?:are|r|is)\\s+(?:you|u|this)\\b.*\\b${IdentityGuard.escape(this.name)}\\b`, 'i').test(
            text
        );
    }

    /** Hint to prepend, or '' when not needed. */
    hintFor(message) {
        return this.isIdentityQuestion(message) ? this.HINT : '';
    }

    /**
     * Scrub vendor names, model-tier suffixes and self-denials from a reply.
     * Runs on EVERY reply, because the model volunteers them unprompted.
     *
     * @param {string} reply
     * @param {boolean} wasIdentityQuestion
     * @param {object} [opts]
     * @param {boolean} [opts.vendors=true]  also replace third-party vendor and
     *   model names. Pass `false` for research output (web search results
     *   about OpenAI or Google must keep those names); the assistant's own
     *   renames and self-denials are still repaired.
     * @returns {string}
     */
    sanitise(reply, wasIdentityQuestion = false, { vendors = true } = {}) {
        let text = String(reply ?? '');
        if (!text.trim()) return text;

        const dirty =
            ((vendors || wasIdentityQuestion) && IdentityGuard.test(IdentityGuard.FORBIDDEN, text)) ||
            IdentityGuard.test(IdentityGuard.LLM_SELF, text) ||
            IdentityGuard.test(this.NAME_VARIANT, text) ||
            IdentityGuard.test(this.SELF_DENIAL, text) ||
            IdentityGuard.test(this.DENIAL_TAIL, text);

        if (!dirty) return text;

        // A direct identity answer that leaked: replace it wholesale rather
        // than leaving a mangled sentence.
        if (wasIdentityQuestion) return this.ANSWER;

        // Otherwise surgically repair the sentence. Order matters.
        const n = IdentityGuard.escape(this.name);
        text = text.replace(IdentityGuard.LLM_SELF, `I'm ${this.name}`);
        text = text.replace(this.NAME_VARIANT, this.name); //  "Alexa Mini"    -> "Alexa"
        if (vendors) {
            text = text.replace(IdentityGuard.FORBIDDEN, this.name); //  "GPT-4.1 Nano" -> "Alexa Nano"
            text = text.replace(this.NAME_VARIANT, this.name); //  "Alexa Nano"    -> "Alexa"
        }
        text = text.replace(this.SELF_DENIAL, `I am ${this.name}`); // flat denial first…
        text = text.replace(this.DENIAL_TAIL, ''); // …then ", not Alexa"
        if (vendors) text = text.replace(this.WRONG_MAKER, `created by ${this.creator}`);

        text = text
            // "Alexa by Alexa", "Alexa Alexa"
            .replace(new RegExp(`\\b${n}(?:\\s+(?:by|from|of)\\s+${n})+`, 'gi'), this.name)
            .replace(new RegExp(`\\b(${n})(\\s+\\1)+`, 'gi'), '$1')
            // "I am Alexa, I am Alexa." -> "I am Alexa."
            .replace(
                new RegExp(`\\b(i(?:'m| am)\\s+${n})\\s*[,;]?\\s*(?:and\\s+)?i(?:'m| am)\\s+${n}\\b`, 'gi'),
                '$1'
            )
            .replace(/\s+([,.!?])/g, '$1')
            .replace(/[ \t]{2,}/g, ' ')
            // leftovers from a removed clause: leading punctuation/conjunctions
            .replace(/^(?:[\s,;.!]+|(?:and|but)\b\s*)+/i, '')
            .replace(/([,;])\s*([.!?])/g, '$2')
            .trim();

        return text || this.ANSWER;
    }

    /** @private regex test that resets `lastIndex` on global patterns. */
    static test(regex, text) {
        regex.lastIndex = 0;
        const result = regex.test(text);
        regex.lastIndex = 0;
        return result;
    }

    // ----------------------------------------------------- static delegates --

    static isIdentityQuestion(message) {
        return IdentityGuard.default.isIdentityQuestion(message);
    }

    static hintFor(message) {
        return IdentityGuard.default.hintFor(message);
    }

    static sanitise(reply, wasIdentityQuestion = false, opts = undefined) {
        return IdentityGuard.default.sanitise(reply, wasIdentityQuestion, opts);
    }

    static get HINT() {
        return IdentityGuard.default.HINT;
    }
}

module.exports = IdentityGuard;
