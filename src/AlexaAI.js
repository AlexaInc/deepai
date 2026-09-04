'use strict';

const Config = require('./core/Config');
const DeepAIClient = require('./core/DeepAIClient');
const Database = require('./db/Database');
const UserRepository = require('./repositories/UserRepository');
const MemoryRepository = require('./repositories/MemoryRepository');
const ConversationRepository = require('./repositories/ConversationRepository');
const PromptBuilder = require('./services/PromptBuilder');
const MemoryExtractor = require('./services/MemoryExtractor');
const FactMiner = require('./services/FactMiner');
const ResponseFormatter = require('./services/ResponseFormatter');
const TriggerDetector = require('./services/TriggerDetector');
const ImageDescriber = require('./services/ImageDescriber');
const JidParser = require('./utils/JidParser');
const { ValidationError, QuotaExceededError, AlexaAIError } = require('./core/errors');

/**
 * AlexaAI
 * =======
 * The single object the WhatsApp bot talks to.
 *
 *   const AlexaAI = require('alexa-ai');
 *   const ai = new AlexaAI({ key: 'deepaikey', postgresUrl: 'connection string' });
 *
 *   const reply = await ai.chat({
 *       message: 'Hi, I am Nimal and I love cricket',
 *       userId : '78151912841263@lid',
 *       groupId: '120363413125431525@g.us',   // omit/empty for a DM
 *       userName: 'Nimal',
 *   });
 *   // -> { text, memories, trigger, ... }
 *
 * Everything else (users, groups, threads, memories) is handled internally.
 */
class AlexaAI {
    /**
     * @param {object} options see Config for the full list
     */
    constructor(options = {}) {
        this.config = new Config(options);

        // Deterministic trigger short-circuit; disable with `triggers:false`.
        this.triggersEnabled = options.triggers !== false;
        // Auto-learn @MEMORY facts; disable with `memory:false`.
        this.memoryEnabled = options.memory !== false;
        // Local heuristic fact mining (safety net when the model omits the
        // @MEMORY tag). Disable with `factMining:false`.
        this.factMiningEnabled = options.factMining !== false;

        this.db = new Database(this.config);
        this.client = new DeepAIClient(this.config);

        this.users = new UserRepository(this.db);
        this.memories = new MemoryRepository(this.db);
        this.conversations = new ConversationRepository(this.db);

        this.prompts = new PromptBuilder(this.config);
        this.vision = new ImageDescriber(this.client, this.config);

        this.log = this.config.logger;
        this._trimCounter = 0;
    }

    // =====================================================================
    //  Lifecycle
    // =====================================================================

    /** Open the pool and run migrations. Optional — `chat()` does it lazily. */
    async init() {
        await this.db.connect();
        return this;
    }

    /** Close the pool. Call on bot shutdown. */
    async close() {
        await this.db.close();
    }

    /** `{ ok, now, database }` */
    async health() {
        return this.db.healthCheck();
    }

    /** Run migrations against a bare connection string (used by `npm run migrate`). */
    static async migrate(postgresUrl) {
        const instance = new AlexaAI({ key: 'migration-only', postgresUrl });
        await instance.db.connect();
        await instance.db.migrate();
        await instance.close();
    }

    // =====================================================================
    //  Main entry point
    // =====================================================================

    /**
     * Handle one incoming WhatsApp message.
     *
     * @param {object} params
     * @param {string} params.message              user text ('' if image-only)
     * @param {string} params.userId               '78151912841263@lid' | '...@s.whatsapp.net'
     * @param {string} [params.groupId]            '120363413125431525@g.us' — omit for DM
     * @param {string} [params.userName]           WhatsApp push name
     * @param {string} [params.groupName]          group subject
     * @param {object} [params.image]              { buffer, mimetype, filename } or { url }
     * @param {string} [params.messageId]          WhatsApp message id (dedupe)
     * @param {boolean} [params.isAdmin]           sender is a group admin
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<{
     *   text: string, raw: string, memories: Record<string,string>,
     *   trigger: string|null, isGroup: boolean, contextKey: string,
     *   userName: string, latencyMs: number, chunks: string[], error: string|null
     * }>}
     */
    async chat(params = {}) {
        const started = Date.now();

        // ---- validate ----------------------------------------------------
        const { message, userId, groupId, userName, groupName, image, messageId, isAdmin, signal } =
            AlexaAI._normaliseParams(params);

        const parsedUser = JidParser.parse(userId);
        if (!parsedUser.valid || parsedUser.isGroup) {
            throw new ValidationError(
                `chat(): 'userId' must be a user jid such as '78151912841263@lid'. Received: ${JSON.stringify(params.userId)}`
            );
        }
        if (!message && !image) {
            throw new ValidationError("chat(): provide 'message' text and/or an 'image'.");
        }

        const isGroup = Boolean(groupId && JidParser.isGroup(groupId));
        const contextKey = JidParser.contextKey(userId, isGroup ? groupId : null, this.config.sharedGroupThread);

        // ---- identity: one row per human, shared across DM + all groups ---
        const user = await this.users.upsertUser(userId, { pushName: userName });
        const group = isGroup ? await this.users.upsertGroup(groupId, { subject: groupName }) : null;
        if (group) await this.users.linkMember(group.id, user.id, isAdmin);

        if (user.is_blocked) {
            return AlexaAI._result({
                text: '',
                contextKey,
                isGroup,
                userName: userName || '',
                latencyMs: Date.now() - started,
                error: 'user_blocked',
            });
        }
        if (group && group.is_enabled === false) {
            return AlexaAI._result({
                text: '',
                contextKey,
                isGroup,
                userName: userName || '',
                latencyMs: Date.now() - started,
                error: 'group_disabled',
            });
        }

        const conversation = await this.conversations.upsertConversation({
            contextKey,
            userId: user.id,
            groupId: group ? group.id : null,
            title: isGroup ? groupName || null : userName || null,
        });

        const displayName = await this.users.resolveDisplayName(user.id, userName || 'there');

        // ---- deterministic triggers (must be byte-exact for the bot) ------
        if (this.triggersEnabled && message) {
            const trigger = TriggerDetector.detect(message);
            if (trigger) {
                await this.conversations.addMessage({
                    conversationId: conversation.id,
                    userId: user.id,
                    role: 'user',
                    content: message,
                    waMessageId: messageId,
                });
                await this.conversations.addMessage({
                    conversationId: conversation.id,
                    userId: null,
                    role: 'assistant',
                    content: trigger.output,
                    metadata: { trigger: trigger.type },
                });
                await this.users.incrementMessageCount(user.id, message.length);

                return AlexaAI._result({
                    text: trigger.output,
                    raw: trigger.output,
                    trigger: trigger.type,
                    contextKey,
                    isGroup,
                    userName: displayName,
                    latencyMs: Date.now() - started,
                });
            }
        }

        // ---- optional vision ----------------------------------------------
        let imageContext = null;
        if (image) {
            const described = await this.vision.describe(image, message);
            if (described.ok) {
                imageContext = described.description;
            } else if (!message) {
                // Image with no caption and no vision: answer honestly rather
                // than letting the model invent a description.
                const fallback = ImageDescriber.fallbackMessage(message);
                await this.conversations.addMessage({
                    conversationId: conversation.id,
                    userId: user.id,
                    role: 'user',
                    content: '[image]',
                    hasMedia: true,
                    mediaType: image.mimetype || 'image',
                    waMessageId: messageId,
                });
                await this.conversations.addMessage({
                    conversationId: conversation.id,
                    userId: null,
                    role: 'assistant',
                    content: fallback,
                });
                return AlexaAI._result({
                    text: fallback,
                    raw: fallback,
                    contextKey,
                    isGroup,
                    userName: displayName,
                    latencyMs: Date.now() - started,
                    error: 'vision_unavailable',
                });
            }
        }

        // ---- build the prompt ---------------------------------------------
        const [history, memoryMap] = await Promise.all([
            this.conversations.getHistory(conversation.id, this.config.historyLimit),
            this.memoryEnabled ? this.memories.getMap(user.id, this.config.maxMemories) : Promise.resolve({}),
        ]);

        const messages = this.prompts.build({
            message,
            history,
            memories: memoryMap,
            userName: displayName,
            isGroup,
            groupName: group?.subject || groupName || null,
            imageContext,
        });

        // ---- call DeepAI ----------------------------------------------------
        let rawReply;
        try {
            rawReply = await this.client.chat(messages, { signal });
        } catch (err) {
            await this.conversations.logUsage({
                userId: user.id,
                conversationId: conversation.id,
                model: this.config.model,
                ok: false,
                errorCode: err.code || 'UNKNOWN',
                latencyMs: Date.now() - started,
            });

            // Persist the user turn so context is not lost on a transient error.
            await this.conversations.addMessage({
                conversationId: conversation.id,
                userId: user.id,
                role: 'user',
                content: message || '[image]',
                hasMedia: Boolean(image),
                waMessageId: messageId,
            });

            const friendly =
                err instanceof QuotaExceededError
                    ? "I've hit my usage limit for now. 🙏 Please try again in a little while."
                    : "Sorry, I couldn't reach my brain just now. 😔 Please try again in a moment.";

            return AlexaAI._result({
                text: friendly,
                raw: '',
                contextKey,
                isGroup,
                userName: displayName,
                latencyMs: Date.now() - started,
                error: err.code || 'DEEPAI_ERROR',
            });
        }

        // ---- extract memories, then format --------------------------------
        const extracted = MemoryExtractor.extract(rawReply);
        let finalText = ResponseFormatter.format(extracted.text);

        // Guarantee no @MEMORY remnant ever reaches WhatsApp.
        if (/@\s*MEMORY/i.test(finalText)) finalText = MemoryExtractor.strip(finalText);

        if (!finalText.trim()) {
            finalText = 'Sorry, I did not quite catch that. Could you say it again?';
        }

        // ---- persist --------------------------------------------------------
        await this.conversations.addMessage({
            conversationId: conversation.id,
            userId: user.id,
            role: 'user',
            content: message || '[image]',
            hasMedia: Boolean(image),
            mediaType: image ? image.mimetype || 'image' : null,
            waMessageId: messageId,
        });
        await this.conversations.addMessage({
            conversationId: conversation.id,
            userId: null,
            role: 'assistant',
            content: finalText,
        });

        // Merge locally-mined facts with any the model tagged. The model's own
        // @MEMORY output wins on conflict, since it has full context.
        // FactMiner is the safety net for when the model ignores the tag rule
        // (common on DeepAI's free tier — verified in live testing).
        let learnedFacts = extracted.memories;
        if (this.memoryEnabled) {
            const mined = this.factMiningEnabled && message ? FactMiner.mine(message) : {};
            learnedFacts = { ...mined, ...extracted.memories };

            // Don't rewrite facts we already store with an identical value.
            for (const [k, v] of Object.entries(learnedFacts)) {
                if (memoryMap[k] === v) delete learnedFacts[k];
            }

            if (Object.keys(learnedFacts).length) {
                try {
                    await this.memories.rememberMany(user.id, learnedFacts, {
                        source: 'auto',
                        learnedIn: contextKey,
                    });
                } catch (err) {
                    this.log.warn?.(`[AlexaAI] Failed to save memories: ${err.message}`);
                }
            }
        }

        await this.users.incrementMessageCount(user.id, (message || '').length + finalText.length);
        await this.conversations.logUsage({
            userId: user.id,
            conversationId: conversation.id,
            model: this.config.model,
            ok: true,
            latencyMs: Date.now() - started,
            promptChars: JSON.stringify(messages).length,
            replyChars: finalText.length,
        });

        // Opportunistic housekeeping every 50 turns.
        if (++this._trimCounter % 50 === 0) {
            this.conversations.trim(conversation.id, 200).catch(() => {});
        }

        return AlexaAI._result({
            text: finalText,
            raw: rawReply,
            memories: learnedFacts,
            contextKey,
            isGroup,
            userName: displayName,
            latencyMs: Date.now() - started,
        });
    }

    /**
     * Callback-style wrapper matching the existing `callai.js` signature so it
     * can be dropped into the current bot with no call-site changes.
     *
     *   ai(message, userId, groupId, userName, (err, reply) => { ... })
     *
     * @returns {Promise<string>} reply text
     */
    async ask(message, userId, groupId = '', userName = 'User', callback) {
        try {
            let text = message;
            let image;

            // Support the { text, files:[...] } shape used by callai.js.
            if (message && typeof message === 'object') {
                text = message.text || '';
                const file = Array.isArray(message.files) ? message.files[0] : null;
                if (file) {
                    image = Buffer.isBuffer(file)
                        ? { buffer: file }
                        : typeof file === 'string'
                          ? { url: file }
                          : file;
                }
            }

            const result = await this.chat({
                message: text,
                userId,
                groupId,
                userName,
                image,
            });

            if (typeof callback === 'function') callback(null, result.text);
            return result.text;
        } catch (err) {
            const msg = err instanceof AlexaAIError ? err.message : String(err?.message || err);
            this.log.error?.(`[AlexaAI] ask() failed: ${msg}`);
            if (typeof callback === 'function') callback(msg, null);
            return '';
        }
    }

    // =====================================================================
    //  Memory / admin helpers
    // =====================================================================

    /** All remembered facts for a user, as `{key: value}`. */
    async getMemories(userJid) {
        const user = await this.users.findByJid(userJid);
        if (!user) return {};
        return this.memories.getMap(user.id, this.config.maxMemories);
    }

    /** Manually store a fact. */
    async remember(userJid, key, value) {
        const user = await this.users.upsertUser(userJid);
        return this.memories.remember(user.id, key, value, { source: 'manual' });
    }

    /** Delete one fact. */
    async forget(userJid, key) {
        const user = await this.users.findByJid(userJid);
        if (!user) return false;
        return this.memories.forget(user.id, key);
    }

    /** Delete every fact for a user. */
    async forgetAll(userJid) {
        const user = await this.users.findByJid(userJid);
        if (!user) return 0;
        return this.memories.forgetAll(user.id);
    }

    /** Wipe one thread's transcript (memories survive). */
    async clearHistory(userJid, groupJid = null) {
        const contextKey = JidParser.contextKey(userJid, groupJid, this.config.sharedGroupThread);
        return this.conversations.clearHistory(contextKey);
    }

    /** Full profile: user row, memories, threads. */
    async getProfile(userJid) {
        const user = await this.users.findByJid(userJid);
        if (!user) return null;
        const [memories, conversations] = await Promise.all([
            this.memories.getAll(user.id, this.config.maxMemories),
            this.conversations.listForUser(userJid),
        ]);
        return { user, memories, conversations };
    }

    async blockUser(userJid) {
        return this.users.setBlocked(userJid, true);
    }

    async unblockUser(userJid) {
        return this.users.setBlocked(userJid, false);
    }

    async setGroupEnabled(groupJid, enabled = true) {
        return this.users.setGroupEnabled(groupJid, enabled);
    }

    async stats() {
        return this.users.stats();
    }

    // =====================================================================
    //  Internals
    // =====================================================================

    /** @private */
    static _normaliseParams(params) {
        return {
            message: params.message == null ? '' : String(params.message).trim(),
            userId: params.userId ?? params.user ?? params.jid,
            groupId: params.groupId ?? params.group ?? null,
            userName: params.userName ?? params.pushName ?? null,
            groupName: params.groupName ?? params.subject ?? null,
            image: params.image ?? null,
            messageId: params.messageId ?? null,
            isAdmin: Boolean(params.isAdmin),
            signal: params.signal,
        };
    }

    /** @private */
    static _result({
        text,
        raw = '',
        memories = {},
        trigger = null,
        contextKey,
        isGroup,
        userName,
        latencyMs,
        error = null,
    }) {
        return {
            text,
            raw,
            memories,
            trigger,
            isGroup,
            contextKey,
            userName,
            latencyMs,
            chunks: ResponseFormatter.chunk(text),
            error,
        };
    }
}

module.exports = AlexaAI;
