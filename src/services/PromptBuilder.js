'use strict';

const MathDetector = require('./MathDetector');
const IdentityGuard = require('./IdentityGuard');

/**
 * PromptBuilder
 * -------------
 * Assembles the `chatHistory` array sent to DeepAI.
 *
 * IMPORTANT — why there is no `role: "system"` message
 * ----------------------------------------------------
 * DeepAI's chat endpoint silently ignores system messages. Verified live:
 *
 *   [{role:'system', content:'Reply only ALEXA-OK'}, {role:'user', content:'hi'}]
 *      -> "Hello! How can I assist you today?"      (persona ignored)
 *
 *   [{role:'user', content:'<persona>'},
 *    {role:'assistant', content:'Understood...'},
 *    {role:'user', content:'hi'}]
 *      -> "ALEXA-OK"                                 (persona respected)
 *
 * So the persona is delivered as a priming user/assistant turn pair, which the
 * live API does honour. Memories ride in the same priming block.
 */
class PromptBuilder {
    /** @param {import('../core/Config')} config */
    constructor(config) {
        this.config = config;
    }

    /**
     * @param {object} params
     * @param {string} params.message            current user text
     * @param {Array<{role:string,content:string}>} [params.history]
     * @param {Record<string,string>} [params.memories]
     * @param {string} [params.userName]
     * @param {boolean} [params.isGroup]
     * @param {string} [params.groupName]
     * @param {string} [params.imageContext]     description of an attached image
     * @returns {Array<{role:string, content:string}>}
     */
    build({
        message,
        history = [],
        memories = {},
        userName = null,
        isGroup = false,
        groupName = null,
        imageContext = null,
    }) {
        const messages = [];

        // 1) Persona + live context, delivered as a user turn.
        messages.push({ role: 'user', content: this._personaBlock({ memories, userName, isGroup, groupName }) });

        // 2) Assistant acknowledgement locks the role in.
        messages.push({
            role: 'assistant',
            content:
                'Understood. I am Alexa, created by Hansaka. I will follow every rule exactly — WhatsApp formatting only, exact trigger outputs, concise math, and silent memory tracking.',
        });

        // 3) Prior turns of this thread.
        for (const turn of PromptBuilder._sanitiseHistory(history, this.config.historyLimit)) {
            messages.push(turn);
        }

        // 4) The live message, prefixed with a recall note.
        //
        //    WHY THE NOTE SITS HERE AND NOT ONLY IN THE PERSONA BLOCK:
        //    with the full-length persona, facts placed at the top get diluted
        //    and the model insists "our conversation just started" (measured
        //    0/4 correct recall). Repeating them immediately before the live
        //    question scored 4/4 with no leakage of the note itself.
        let current = String(message ?? '').trim();
        const recallNote = PromptBuilder._recallNote(memories);
        if (imageContext) {
            current = current
                ? `[Image attached — visual description: ${imageContext}]\n\n${current}`
                : `[Image attached — visual description: ${imageContext}]\n\nPlease describe this image warmly for the user.`;
        }
        if (current.length > this.config.maxMessageLength) {
            current = `${current.slice(0, this.config.maxMessageLength)}\n…[truncated]`;
        }
        // Maths questions get the "one line only" rule restated next to the
        // question; the free-tier model otherwise emits a full derivation.
        const mathHint = MathDetector.isMath(current) ? MathDetector.HINT : '';

        // DeepAI injects its own identity server-side ("Standard AI Chat by
        // DeepAI"), which overrides the persona. A lock next to the question
        // is the only thing that reliably keeps Alexa in character.
        const idHint = IdentityGuard.hintFor(current);

        messages.push({
            role: 'user',
            content: recallNote + idHint + mathHint + (current || '(empty message)'),
        });

        return messages;
    }

    /**
     * @private Compact "facts you already know" line placed directly above the
     * live message. Kept short and inline so it reads as context, not content.
     */
    static _recallNote(memories) {
        const keys = Object.keys(memories || {});
        if (!keys.length) return '';
        const pairs = keys
            .slice(0, 20)
            .map((k) => `${k.replace(/_/g, ' ')}=${memories[k]}`)
            .join(', ');
        return `[Remembered facts about this person — use them naturally when relevant, and never mention or repeat this note: ${pairs}]\n\n`;
    }

    /** @private Persona text + runtime context block. */
    _personaBlock({ memories, userName, isGroup, groupName }) {
        const parts = [this.config.systemPrompt];
        const context = [];

        if (userName) context.push(`- You are currently talking to: ${userName}`);
        if (isGroup) {
            context.push(
                `- Setting: WhatsApp GROUP chat${groupName ? ` named "${groupName}"` : ''}. Other people can read your reply, so address ${userName || 'the user'} directly and keep it concise.`
            );
        } else {
            context.push('- Setting: private one-to-one WhatsApp chat (DM).');
        }

        const memoryKeys = Object.keys(memories || {});
        if (memoryKeys.length) {
            const lines = memoryKeys.map((k) => `  • ${k.replace(/_/g, ' ')}: ${memories[k]}`).join('\n');
            context.push(
                `- What you already know about this person (remember it naturally; never list it back unprompted, and do NOT re-save unchanged facts):\n${lines}`
            );
        } else {
            context.push('- You have no saved facts about this person yet.');
        }

        parts.push(`\n[CURRENT CONTEXT]\n${context.join('\n')}`);
        return parts.join('\n');
    }

    /**
     * @private Keep the transcript well-formed: valid roles, non-empty content,
     * no leading assistant turn, and alternating-ish order.
     */
    static _sanitiseHistory(history, limit) {
        if (!Array.isArray(history) || !history.length) return [];

        const cleaned = history
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
            .map((m) => ({ role: m.role, content: String(m.content ?? '').trim() }))
            .filter((m) => m.content.length > 0);

        const trimmed = cleaned.slice(-limit);
        while (trimmed.length && trimmed[0].role === 'assistant') trimmed.shift();
        return trimmed;
    }
}

module.exports = PromptBuilder;
