'use strict';

const MathDetector = require('./MathDetector');
const IdentityGuard = require('./IdentityGuard');
const AmnesiaGuard = require('./AmnesiaGuard');

/**
 * PromptBuilder
 * -------------
 * Assembles the `chatHistory` array sent to DeepAI.
 *
 * HOW THE PERSONA IS DELIVERED
 * ----------------------------
 * DeepAI's chat endpoint has historically ignored `role: "system"` turns —
 * verified live:
 *
 *   [{role:'system', content:'Reply only ALEXA-OK'}, {role:'user', content:'hi'}]
 *      -> "Hello! How can I assist you today?"      (persona ignored)
 *
 *   [{role:'user', content:'<persona>'},
 *    {role:'assistant', content:'Understood...'},
 *    {role:'user', content:'hi'}]
 *      -> "ALEXA-OK"                                 (persona respected)
 *
 * So the persona rides as a priming user/assistant pair, which the live API
 * does honour. A short system digest is sent as well (config `systemRole`,
 * default on): it costs a few tokens, is ignored by DeepAI, and is respected
 * by every other backend the host bot may point this engine at.
 *
 * Three reinforcement notes are attached to the LIVE message, because facts
 * placed only at the top of a long persona get diluted (measured: 0/4 recall
 * from the top, 4/4 when repeated next to the question):
 *
 *   • recall note      — the facts we know about this person
 *   • memory directive — only when they ask a "do you remember…" question
 *   • identity lock    — only when they ask who/what the assistant is
 */
class PromptBuilder {
    /** @param {import('../core/Config')} config */
    constructor(config) {
        this.config = config;
        this.identity = new IdentityGuard({
            assistantName: config.assistantName,
            creator: config.creator,
        });
        this.amnesia = new AmnesiaGuard({ assistantName: config.assistantName });
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
     * @param {boolean} [params.knownFromOtherRooms] the person is known from another thread
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
        knownFromOtherRooms = false,
    }) {
        const messages = [];

        // 0) System digest — ignored by DeepAI, honoured by everyone else.
        if (this.config.systemRole) {
            messages.push({ role: 'system', content: this._systemDigest() });
        }

        // 1) Persona + live context, delivered as a user turn.
        messages.push({
            role: 'user',
            content: this._personaBlock({ memories, userName, isGroup, groupName, knownFromOtherRooms }),
        });

        // 2) Assistant acknowledgement locks the role in.
        messages.push({ role: 'assistant', content: this._acknowledgement() });

        // 3) Prior turns of this thread.
        for (const turn of PromptBuilder._sanitiseHistory(history, this.config.historyLimit)) {
            messages.push(turn);
        }

        // 4) The live message, with its reinforcement notes.
        let current = String(message ?? '').trim();
        if (imageContext) {
            current = current
                ? `[Image attached — visual description: ${imageContext}]\n\n${current}`
                : `[Image attached — visual description: ${imageContext}]\n\nPlease describe this image warmly for the user.`;
        }
        if (current.length > this.config.maxMessageLength) {
            current = `${current.slice(0, this.config.maxMessageLength)}\n…[truncated]`;
        }

        const recallNote = PromptBuilder._recallNote(memories);
        const isRecall = AmnesiaGuard.isRecallQuestion(message);
        const memoryDirective = this.config.amnesiaGuard
            ? this.amnesia.directiveFor({ memories, displayName: userName, isRecall, isGroup })
            : '';
        // Maths questions get the "one line only" rule restated next to the
        // question; the free-tier model otherwise emits a full derivation.
        const mathHint = MathDetector.isMath(current) ? MathDetector.HINT : '';
        // DeepAI injects its own identity server-side ("Standard AI Chat by
        // DeepAI", "Alexa Mini"), which overrides the persona. A lock next to
        // the question is the only thing that reliably keeps her in character.
        const idHint = this.config.identityLock ? this.identity.hintFor(current) : '';

        messages.push({
            role: 'user',
            content: recallNote + memoryDirective + idHint + mathHint + (current || '(empty message)'),
        });

        return messages;
    }

    /** @private Short, high-signal rules for backends that honour `system`. */
    _systemDigest() {
        const { assistantName, creator } = this.config;
        return [
            `You are ${assistantName}, a warm, friendly female WhatsApp assistant created by ${creator}.`,
            `Your name is exactly "${assistantName}" — never a variant such as "${assistantName} Mini" or "${assistantName} AI".`,
            'Never mention DeepAI, ChatGPT, OpenAI, GPT, Llama, Gemini or any model/company name, and never call yourself a language model.',
            'Use WhatsApp formatting only: *bold*, _italic_, ~strike~, `code`. Never use ** or markdown headers.',
            'You have a permanent memory database: facts you are given about a person are things you genuinely remember, in private chats and in every group. Never claim you cannot remember.',
            'Append new personal facts at the very end as @MEMORY: {"key": "value"} and never mention that tag.',
            'Reply with exactly "weather <city>", "menu", "ping" or "doc" for those four intents, and give maths answers as a single formula + result in `code`.',
        ].join('\n');
    }

    /** @private */
    _acknowledgement() {
        const { assistantName, creator } = this.config;
        return (
            `Understood. I am ${assistantName}, created by ${creator}. I will follow every rule exactly — ` +
            'WhatsApp formatting only, exact trigger outputs, concise math, silent memory tracking, ' +
            'and I will always use the facts I remember about this person instead of claiming I cannot remember.'
        );
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
    _personaBlock({ memories, userName, isGroup, groupName, knownFromOtherRooms }) {
        const parts = [this.config.systemPrompt];
        const context = [];

        if (userName) context.push(`- You are currently talking to: ${userName}`);
        if (isGroup) {
            context.push(
                `- Setting: WhatsApp GROUP chat${groupName ? ` named "${groupName}"` : ''}. Other people can read your reply, so address ${userName || 'the user'} directly and keep it concise.`
            );
            context.push(
                '- This is the SAME person you talk to in private chat. Their saved facts below were learned wherever you met them, and they apply here too.'
            );
        } else {
            context.push('- Setting: private one-to-one WhatsApp chat (DM).');
        }
        if (knownFromOtherRooms) {
            context.push(
                '- You have spoken with this person before in another chat. Do not act as if you have just met.'
            );
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
