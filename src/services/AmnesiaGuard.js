'use strict';

/**
 * AmnesiaGuard
 * ------------
 * Stops the assistant from denying a memory it demonstrably has.
 *
 * THE BUG THIS FIXES
 * ------------------
 * The engine stores facts per human and injects them into every prompt, but the
 * free DeepAI tier still loves to answer:
 *
 *   user  (in a group): "do you remember me?"
 *   model:              "Unfortunately, as a bot I can't remember you."
 *
 * …while the database is holding `name=Nimal, location=Galle, hobby=cricket`.
 * The reply is simply false, and it is the single most damaging thing the bot
 * can say.
 *
 * Two layers:
 *   1. `directiveFor()` — a short, explicit instruction (plus the answer the
 *      model should give) placed immediately before a recall question.
 *   2. `repair()`       — if the reply still denies having a memory while we
 *      hold facts, the denial is rewritten from the database. Deterministic:
 *      no second round-trip, no extra latency, and it can never be wrong.
 */
class AmnesiaGuard {
    /** "do you remember me", "what's my name", "who am I", … */
    static RECALL_QUESTION =
        /\b(?:do (?:you|u) (?:still )?(?:remember|know|recall)|remember me|remember my|you remember|what(?:'s| is)? my (?:name|age|city|town|country|job|hobby|favou?rite)|who am i|do you know (?:me|my|who i am)|mata mathakada|mage nama)\b/i;

    /** Denials of having any memory at all. */
    static DENIAL =
        /(?:\b(?:i|we)\s+(?:really\s+)?(?:can(?:'|no)?t|cannot|can not|do(?:n'?t| not)|am unable to|are unable to|have no (?:way|ability)|don'?t have (?:the )?(?:ability|capability|memory|access)|lack the ability)\s+(?:to\s+)?(?:really\s+)?(?:remember|recall|retain|store|save|access|keep track of)\b)|(?:\bas an? (?:ai|bot|assistant|language model)[^.!?]{0,60}(?:remember|recall|memory|retain)\b)|(?:\bi\s+(?:have|hold|retain)\s+no\s+(?:memory|memories|record|recollection)\b)|(?:\bno memory of (?:you|our|previous|past|earlier)\b)|(?:\bi\s+don'?t\s+(?:have|keep|retain|store)\s+(?:any\s+)?(?:memory|memories|records?|information about you)\b)|(?:\b(?:our|this) conversation (?:has )?just started\b)|(?:\bi don'?t have access to (?:previous|past|prior|earlier) (?:conversations|chats|messages)\b)|(?:\bevery (?:conversation|chat) (?:starts|begins) (?:fresh|anew)\b)|(?:\bi start(?: over)? fresh\b)/i;

    /** Human-friendly labels for the keys we store most often. */
    static LABELS = {
        name: 'your name is',
        full_name: 'your full name is',
        nickname: 'you also go by',
        age: "you're",
        location: "you're from",
        city: "you're from",
        country: "you're from",
        hobby: 'you love',
        favourite_food: 'your favourite food is',
        favorite_food: 'your favourite food is',
        favourite_team: 'you support',
        favorite_team: 'you support',
        job: 'you work as',
        occupation: 'you work as',
        studies: "you're studying",
        language: 'you speak',
        birthday: 'your birthday is',
    };

    /**
     * @param {object} [persona]
     * @param {string} [persona.assistantName='Alexa']
     */
    constructor({ assistantName = 'Alexa' } = {}) {
        this.name = String(assistantName || 'Alexa').trim() || 'Alexa';
    }

    /** Is the user asking the assistant to recall something about them? */
    static isRecallQuestion(message) {
        const text = String(message ?? '').trim();
        if (!text || text.length > 400) return false;
        return AmnesiaGuard.RECALL_QUESTION.test(text);
    }

    /** Does this reply deny having a memory? */
    static isDenial(reply) {
        const text = String(reply ?? '');
        if (!text.trim()) return false;
        return AmnesiaGuard.DENIAL.test(text);
    }

    /**
     * Instruction injected right before a recall question, carrying the answer.
     * @param {object} params
     * @param {Record<string,string>} params.memories
     * @param {string} [params.displayName]
     * @param {boolean} params.isRecall
     * @param {boolean} [params.isGroup]
     * @returns {string} '' when nothing needs saying
     */
    directiveFor({ memories = {}, displayName = null, isRecall = false, isGroup = false } = {}) {
        const keys = Object.keys(memories || {});
        if (!isRecall) return '';

        if (!keys.length) {
            return (
                '[MEMORY CHECK: You DO have a permanent memory, but you have not saved any facts about this ' +
                'person yet. Say warmly that you do not have their details saved yet and ask them to tell you. ' +
                'Do NOT say you are unable to remember things.]\n\n'
            );
        }

        const facts = keys.map((k) => `${k.replace(/_/g, ' ')}: ${memories[k]}`).join('; ');
        const where = isGroup
            ? 'You know this person from their private chat with you, and this message is in a group — the same person, same memory. '
            : '';
        return (
            `[MEMORY CHECK: You DO remember this person. ${where}Saved facts: ${facts}. ` +
            `Answer their question directly and warmly using these facts${displayName ? `, greeting them as ${displayName}` : ''}. ` +
            'NEVER say you cannot remember, have no memory, or that the conversation just started.]\n\n'
        );
    }

    /**
     * Rewrite a reply that denies having a memory.
     *
     * @param {string} reply
     * @param {object} params
     * @param {Record<string,string>} params.memories
     * @param {string} [params.displayName]
     * @param {boolean} [params.isRecall]
     * @returns {{ text: string, repaired: boolean }}
     */
    repair(reply, { memories = {}, displayName = null, isRecall = false } = {}) {
        const text = String(reply ?? '');
        if (!AmnesiaGuard.isDenial(text)) return { text, repaired: false };

        const known = Object.keys(memories || {}).length > 0;

        // Drop only the sentences that contain the denial; keep the rest.
        const sentences = AmnesiaGuard.splitSentences(text);
        const kept = sentences.filter((s) => !AmnesiaGuard.DENIAL.test(s)).join(' ').trim();

        if (known) {
            const recall = this.recallSentence(memories, displayName);
            if (isRecall || !kept) return { text: recall, repaired: true };
            return { text: `${recall} ${kept}`.trim(), repaired: true };
        }

        const honest = displayName
            ? `I don't have any details saved about you yet, ${displayName} — tell me and I'll remember. 😊`
            : "I don't have any details saved about you yet — tell me and I'll remember. 😊";
        return { text: kept ? `${honest} ${kept}`.trim() : honest, repaired: true };
    }

    /**
     * A warm, WhatsApp-formatted sentence built from stored facts.
     * @param {Record<string,string>} memories
     * @param {string} [displayName]
     */
    recallSentence(memories, displayName = null) {
        const entries = Object.entries(memories || {}).filter(([, v]) => v);
        const name = memories.name || memories.full_name || displayName;

        const parts = [];
        for (const [key, value] of entries.slice(0, 6)) {
            if (key === 'name' || key === 'full_name') continue;
            const label = AmnesiaGuard.LABELS[key] || `your ${key.replace(/_/g, ' ')} is`;
            parts.push(`${label} _${value}_`);
        }

        const opener = name ? `Of course I remember you, *${name}*! 😊` : 'Of course I remember you! 😊';
        if (!parts.length) return opener;

        const list =
            parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
        return `${opener} I remember that ${list}.`;
    }

    /** @private naive but dependable sentence splitter. */
    static splitSentences(text) {
        return String(text)
            .split(/(?<=[.!?])\s+/)
            .map((s) => s.trim())
            .filter(Boolean);
    }
}

module.exports = AmnesiaGuard;
