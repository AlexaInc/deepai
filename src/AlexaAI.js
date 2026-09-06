'use strict';

const Config = require('./core/Config');
const DeepAIClient = require('./core/DeepAIClient');
const Database = require('./db/Database');
const UserRepository = require('./repositories/UserRepository');
const MemoryRepository = require('./repositories/MemoryRepository');
const ConversationRepository = require('./repositories/ConversationRepository');
const IdentityRepository = require('./repositories/IdentityRepository');
const PromptBuilder = require('./services/PromptBuilder');
const MemoryExtractor = require('./services/MemoryExtractor');
const FactMiner = require('./services/FactMiner');
const ResponseFormatter = require('./services/ResponseFormatter');
const IdentityGuard = require('./services/IdentityGuard');
const AmnesiaGuard = require('./services/AmnesiaGuard');
const IdentityResolver = require('./services/IdentityResolver');
const TriggerDetector = require('./services/TriggerDetector');
const ImageDescriber = require('./services/ImageDescriber');
const WebAnswer = require('./services/WebAnswer');
const WebSearch = require('./services/WebSearch');
const StreamParser = require('./core/StreamParser');
const JidParser = require('./utils/JidParser');
const Media = require('./utils/Media');
const { ValidationError, QuotaExceededError, AlexaAIError } = require('./core/errors');
const { version: PACKAGE_VERSION } = require('../package.json');

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
        this.identities = new IdentityRepository(this.db);

        // One human = one row, whatever jid WhatsApp used this time.
        this.resolver = new IdentityResolver(this.users, this.identities, this.config);

        this.prompts = new PromptBuilder(this.config);
        this.vision = new ImageDescriber(this.client, this.config);
        this.webSearch = new WebSearch(this.config);

        // Persona-aware guards (renaming the assistant renames these too).
        this.identityGuard = new IdentityGuard({
            assistantName: this.config.assistantName,
            creator: this.config.creator,
        });
        this.amnesiaGuard = new AmnesiaGuard({ assistantName: this.config.assistantName });

        /** Direct access to the full DeepAI API surface. */
        this.deepai = this.client;

        this.log = this.config.logger;
        this._trimCounter = 0;
    }

    /** Package version, so a host bot can assert it loaded the build it expects. */
    static get version() {
        return PACKAGE_VERSION;
    }

    get version() {
        return PACKAGE_VERSION;
    }

    /**
     * Names of every public method on the engine. Handy for a startup
     * self-check in the host bot:
     *
     *   for (const m of ['generateImage', 'searchWeb']) {
     *       if (!AlexaAI.methods().includes(m)) throw new Error(`alexa-ai too old: missing ${m}`);
     *   }
     */
    static methods() {
        return Object.getOwnPropertyNames(AlexaAI.prototype)
            .filter((name) => name !== 'constructor' && !name.startsWith('_'))
            .filter((name) => typeof AlexaAI.prototype[name] === 'function')
            .sort();
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
     * @param {string} [params.userLid]            the sender's @lid, when known
     * @param {string} [params.userPhone]          phone jid or bare number behind the @lid
     * @param {string[]} [params.aliases]          any other address for the same human
     * @param {string} [params.groupId]            '120363413125431525@g.us' — omit for DM
     * @param {string} [params.userName]           WhatsApp push name
     * @param {string} [params.groupName]          group subject
     * @param {object} [params.image]              { buffer, mimetype, filename } or { url }
     * @param {string} [params.messageId]          WhatsApp message id (dedupe)
     * @param {boolean} [params.isAdmin]           sender is a group admin
     * @param {string} [params.model]              override the model for this turn
     * @param {boolean} [params.webAccess]         allow DeepAI web search this turn
     * @param {boolean} [params.thinking]          use the async reasoning path
     * @param {function} [params.onToken]          (delta, full) streaming callback
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
        const { message, userId, groupId, userName, groupName, image, messageId, isAdmin, signal, onToken } =
            AlexaAI._normaliseParams(params);

        // Every address WhatsApp gave us for this sender (primary first).
        const aliasList = IdentityResolver.collectAliases({ ...params, userId });

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

        // ---- identity: one row per human, shared across DM + all groups ---
        //
        // WhatsApp addresses the same person as `…@lid` in a group and as
        // `…@s.whatsapp.net` in a DM. Every address supplied (userId, userLid,
        // userPhone, aliases[]) is resolved to a SINGLE user row — merging
        // rows that turn out to be the same human — so memories learned in a
        // DM are available in every group and vice versa.
        const { user, primaryJid, aliases, merged } = await this.resolver.resolve(aliasList, {
            pushName: userName,
        });

        // Threads key off the person's canonical address, so history survives
        // WhatsApp switching the sender between LID and phone addressing.
        const contextKey = JidParser.contextKey(
            primaryJid || userId,
            isGroup ? groupId : null,
            this.config.sharedGroupThread
        );

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
        let attachmentUuids = [];
        if (image) {
            const described = await this.vision.describe(image, message);
            attachmentUuids = described.attachmentUuids || [];
            if (described.ok) {
                imageContext = described.description;
            } else if (attachmentUuids.length && described.reason !== 'unreadable') {
                // The file reached DeepAI even though we could not pre-read it.
                // Forward the attachment with the real conversation: if the
                // account does have vision, the model sees the picture itself.
                imageContext = null;
            } else {
                // Nothing could be read from the image. Be honest instead of
                // letting the model invent a description.
                const fallback = ImageDescriber.fallbackMessage(message);
                await this.conversations.addMessage({
                    conversationId: conversation.id,
                    userId: user.id,
                    role: 'user',
                    content: message || '[image]',
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
            knownFromOtherRooms: Object.keys(memoryMap).length > 0 && history.length === 0,
        });

        // ---- call DeepAI ----------------------------------------------------
        let rawReply;
        let replyImages = [];
        let usedModel = this.config.model;
        try {
            const answer = await this.client.chatDetailed(messages, {
                signal,
                onToken,
                attachmentUuids,
                model: params.model,
                thinking: params.thinking,
                webAccess: params.webAccess,
                search: params.search,
            });
            rawReply = answer.text;
            replyImages = answer.images || [];
            usedModel = answer.model || usedModel;
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

        // Scrub vendor names, model-tier suffixes ("Alexa Mini") and identity
        // denials the backend volunteered.
        finalText = this.identityGuard.sanitise(finalText, this.identityGuard.isIdentityQuestion(message));

        // Repair "sorry, as a bot I can't remember you" when the database says
        // otherwise — the reply would simply be false.
        let repairedMemory = false;
        if (this.config.amnesiaGuard) {
            const repair = this.amnesiaGuard.repair(finalText, {
                memories: memoryMap,
                displayName,
                isRecall: AmnesiaGuard.isRecallQuestion(message),
            });
            finalText = repair.text;
            repairedMemory = repair.repaired;
        }

        // The attachment was forwarded blind (we could not pre-read it). If the
        // model answers "I can't see images", say so honestly instead.
        if (image && !imageContext && ImageDescriber._isRefusal(finalText)) {
            finalText = ImageDescriber.fallbackMessage(message);
        }

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
            model: usedModel,
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
            images: replyImages,
            model: usedModel,
            userId: user.id,
            aliases,
            mergedIdentities: merged,
            repairedMemory,
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

            // Support the { text, files:[...] } shape used by callai.js. The
            // file may be a Buffer, base64, data URI, URL or { buffer | url }.
            if (message && typeof message === 'object') {
                text = message.text || message.body || message.caption || '';
                const file =
                    (Array.isArray(message.files) ? message.files.find(Boolean) : null) ||
                    message.image ||
                    message.file ||
                    message.base64 ||
                    null;
                image = Media.normalize(file) || undefined;
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
    //  Identity helpers  (LID <-> phone linking)
    // =====================================================================

    /**
     * Declare that two WhatsApp addresses belong to the same human.
     *
     * Baileys exposes the mapping on incoming messages
     * (`key.participantAlt` / `key.participantPn`) and through
     * `sock.signalRepository.lidMapping`. Feeding it here (or simply passing
     * both ids to `chat()`) is what makes Alexa recognise a DM user inside a
     * group. Existing rows are merged, memories included.
     *
     * @param {string} jidA
     * @param {string} jidB
     * @returns {Promise<object|null>} the surviving user row
     */
    async linkIdentity(jidA, jidB) {
        return this.resolver.link(jidA, jidB, 'manual');
    }

    /** Every address a person is known under. */
    async getAliases(userJid) {
        const user = await this.users.findByJid(userJid);
        if (!user) return [];
        const rows = await this.identities.aliasesFor(user.id);
        return rows.map((r) => r.jid);
    }

    /** Force-merge two people into one row (the older row wins). */
    async mergeUsers(jidA, jidB) {
        const [a, b] = await Promise.all([this.users.findByJid(jidA), this.users.findByJid(jidB)]);
        if (!a || !b) return null;
        return this.identities.merge(a.id, b.id);
    }

    /** Everything the engine knows about a person: row, aliases, memories. */
    async whoIs(userJid) {
        const user = await this.users.findByJid(userJid);
        if (!user) return null;
        const [aliases, memories] = await Promise.all([
            this.identities.aliasesFor(user.id),
            this.memories.getMap(user.id, this.config.maxMemories),
        ]);
        return { user, aliases: aliases.map((a) => a.jid), memories };
    }

    // =====================================================================
    //  DeepAI capabilities beyond plain chat
    // =====================================================================

    /**
     * Text-to-image.
     *
     * Two routes, tried in order:
     *
     *   1. `POST /api/text2img` — the classic public API. Fast and returns a
     *      plain `output_url`, but it is a PAID endpoint: anonymous `tryit-…`
     *      keys get `{"status": "Out of API credits"}` / "try it exceeded".
     *   2. The in-chat image tool — the same `generate_image` function call the
     *      deepai.org web client sends when you press "Create image". This
     *      works on free chat keys and answers with a `generated_image` packet
     *      carrying a `share_url`.
     *
     * Either way the result is normalised to `{ ok, url, id, error, via }`.
     * Every failure is returned, never thrown, so a bot command can simply
     * check `result.ok`.
     *
     * @param {string} prompt
     * @param {object} [opts]
     * @param {string} [opts.aspectRatio='1:1']   in-chat tool only ('1:1', '16:9', '9:16'…)
     * @param {number} [opts.width] / [opts.height]  /api/text2img only
     * @param {string} [opts.image_generator_version]  /api/text2img only
     * @param {boolean} [opts.chatToolOnly]     skip /api/text2img
     * @param {boolean} [opts.apiOnly]          skip the in-chat tool
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<{ok:boolean, url:string|null, id:string|null, error:string|null, message?:string, via:string|null, raw?:any}>}
     */
    async generateImage(prompt, opts = {}) {
        const text = String(prompt ?? '').trim();
        if (!text) {
            return { ok: false, url: null, id: null, error: 'VALIDATION_ERROR', message: 'generateImage(): prompt is required', via: null };
        }
        const { aspectRatio, chatToolOnly, apiOnly, signal, ...apiFields } = opts || {};
        const errors = [];

        // ---- 1. classic /api/text2img -------------------------------------
        if (!chatToolOnly) {
            try {
                const data = await this.client.text2img(text, apiFields, { signal });
                const url = AlexaAI._outputUrl(data);
                if (url) return { ok: true, url, id: data.id || null, error: null, via: 'api', raw: data };
                errors.push('text2img: no output_url in response');
            } catch (err) {
                errors.push(`text2img: ${err.message}`);
                if (err.code === 'ABORTED') {
                    return { ok: false, url: null, id: null, error: 'ABORTED', message: err.message, via: null };
                }
            }
        }

        // ---- 2. the chat image tool (works on free chat keys) ---------------
        if (!apiOnly) {
            try {
                const answer = await this.client.chatDetailed(
                    [{ role: 'user', content: StreamParser.imageToolPayload(text, aspectRatio || '1:1') }],
                    { signal, extraFields: { image_generation: 'true' } }
                );
                const url = answer.images?.[0] || AlexaAI._outputUrl(answer.payload);
                if (url) {
                    return { ok: true, url, id: answer.payload?.id || null, error: null, via: 'chat', raw: answer.payload };
                }
                errors.push(`chat tool: no image in reply (${String(answer.text || '').slice(0, 80)})`);
            } catch (err) {
                errors.push(`chat tool: ${err.message}`);
            }
        }

        const message = errors.join(' | ');
        this.log.warn?.(`[AlexaAI] generateImage failed: ${message}`);
        return {
            ok: false,
            url: null,
            id: null,
            error: /credits|exceeded|paid|api-key|api key/i.test(message) ? 'DEEPAI_QUOTA_EXCEEDED' : 'IMAGE_FAILED',
            message,
            via: null,
        };
    }

    /**
     * Prompt-driven image edit (`POST /api/image-editor`).
     * `image` may be a Buffer, base64, data URI, URL or `{ buffer | url }`.
     */
    async editImage(image, prompt, opts = {}) {
        const field = Media.toApiField(image);
        if (!field) return AlexaAI._mediaError('editImage', 'IMAGE_EDIT_FAILED');
        try {
            const data = await this.client.editImage(field, String(prompt ?? ''), opts);
            return { ok: true, url: AlexaAI._outputUrl(data), id: data.id || null, error: null, raw: data };
        } catch (err) {
            return { ok: false, url: null, id: null, error: err.code || 'IMAGE_EDIT_FAILED', message: err.message };
        }
    }

    /** 4x upscale (`POST /api/torch-srgan`). Same input shapes as `editImage`. */
    async upscaleImage(image, opts = {}) {
        const field = Media.toApiField(image);
        if (!field) return AlexaAI._mediaError('upscaleImage', 'UPSCALE_FAILED');
        try {
            const data = await this.client.upscaleImage(field, opts);
            return { ok: true, url: AlexaAI._outputUrl(data), id: data.id || null, error: null, raw: data };
        } catch (err) {
            return { ok: false, url: null, id: null, error: err.code || 'UPSCALE_FAILED', message: err.message };
        }
    }

    /** Colourise a black-and-white photo (`POST /api/colorizer`). */
    async colorizeImage(image, opts = {}) {
        const field = Media.toApiField(image);
        if (!field) return AlexaAI._mediaError('colorizeImage', 'COLORIZE_FAILED');
        try {
            const data = await this.client.colorizeImage(field, opts);
            return { ok: true, url: AlexaAI._outputUrl(data), id: data.id || null, error: null, raw: data };
        } catch (err) {
            return { ok: false, url: null, id: null, error: err.code || 'COLORIZE_FAILED', message: err.message };
        }
    }

    /**
     * NSFW score for moderation (`POST /api/nsfw-detector`).
     * @returns {Promise<{ok:boolean, score:number|null, nsfw:boolean|null, error?:string}>}
     */
    async detectNsfw(image, opts = {}) {
        const field = Media.toApiField(image);
        if (!field) return { ...AlexaAI._mediaError('detectNsfw', 'NSFW_FAILED'), score: null, nsfw: null };
        const threshold = typeof opts.threshold === 'number' ? opts.threshold : 0.7;
        try {
            const data = await this.client.detectNsfw(field);
            const score = typeof data?.output?.nsfw_score === 'number' ? data.output.nsfw_score : null;
            return { ok: true, score, nsfw: score == null ? null : score >= threshold, error: null, raw: data };
        } catch (err) {
            return { ok: false, score: null, nsfw: null, error: err.code || 'NSFW_FAILED', message: err.message };
        }
    }

    /**
     * Read an image/document without going through the conversation.
     * Accepts every shape `chat({ image })` accepts, including a bare Buffer.
     */
    async describeImage(image, caption = '') {
        const media = Media.normalize(image);
        if (!media) return { ...ImageDescriber.fallbackResult('no_image'), text: '' };
        const described = await this.vision.describe(media, String(caption ?? ''));
        // `text` is the WhatsApp-ready answer either way (description or a
        // polite "I can't see it" fallback), so a command can just send it.
        return {
            ...described,
            text: described.ok ? ResponseFormatter.format(described.description) : ImageDescriber.fallbackMessage(caption),
        };
    }

    /**
     * Abstractive summary. Tries `POST /api/summarization` first (paid on
     * most keys) and falls back to a stateless chat request, so the call
     * works on free keys too.
     */
    async summarizeText(text, opts = {}) {
        const input = String(text ?? '').trim();
        if (!input) return { ok: false, text: '', error: 'VALIDATION_ERROR', message: 'summarizeText(): text is required' };
        const errors = [];
        try {
            const data = await this.client.summarize(input);
            const summary = String(data?.output || '').trim();
            if (summary) return { ok: true, text: summary, via: 'api', raw: data };
            errors.push('summarization: empty output');
        } catch (err) {
            errors.push(`summarization: ${err.message}`);
        }
        try {
            const answer = await this.client.chatDetailed(
                [
                    {
                        role: 'user',
                        content:
                            'Summarise the following text clearly and concisely in a few short bullet points. ' +
                            'Use WhatsApp formatting only (*bold*, _italic_), no markdown headers.\n\n' +
                            input.slice(0, this.config.maxMessageLength),
                    },
                ],
                { model: opts.model, signal: opts.signal }
            );
            const summary = ResponseFormatter.format(MemoryExtractor.strip(answer.text));
            if (summary) return { ok: true, text: summary, via: 'chat' };
            errors.push('chat: empty reply');
        } catch (err) {
            errors.push(`chat: ${err.message}`);
        }
        return { ok: false, text: '', error: 'SUMMARY_FAILED', message: errors.join(' | ') };
    }

    /**
     * One-off, stateless web research request — for "search the web for X"
     * commands that must not touch anyone's memory.
     *
     * HOW IT WORKS
     * ------------
     * 1. The engine searches the web itself (`WebSearch`: DuckDuckGo, Bing
     *    News, Google News, Wikipedia — no API key needed) and collects real
     *    pages with titles, snippets and dates.
     * 2. Those results go to the model as numbered material. The model writes
     *    the report from them and cites result numbers; it is told never to
     *    write a URL.
     * 3. The `*Sources:*` block is built from the search results only —
     *    cited ones first. A URL the model wrote itself is never shown.
     *
     * When the search returns nothing (offline host, all providers blocked)
     * the request falls back to DeepAI's server-side web access, which is
     * unreliable on free models: it may skip the search and invent pages.
     * `grounded` in the result tells you which path answered.
     *
     * Default output is long-form: an intro, three to five `*Heading:*`
     * sections with numbered `*Headline*: detail` points (about 300–450
     * words), then one `*Sources:*` block. A long-form reply under `minWords`
     * is retried once; the longer reply wins.
     *
     * @param {string} query
     * @param {object} [opts]
     * @param {'long'|'short'} [opts.detail='long']   `short` = 2–4 sentences
     * @param {Array<{title?:string,url:string,description?:string,date?:string}>} [opts.results]
     *        results from the host application's own search API (skips the built-in search)
     * @param {boolean} [opts.search=true]            `false` = skip the built-in search, use DeepAI's
     * @param {string[]} [opts.providers]             subset of WebSearch.PROVIDERS for this call
     * @param {number}  [opts.maxResults]             results handed to the model (default config.webSearchResults)
     * @param {number}  [opts.minWords=150]           long form only: retry once below this (0 disables)
     * @param {boolean} [opts.includeSources=true]    append the *Sources:* block to `text`
     * @param {number}  [opts.maxSources=5]           sources listed in `text` (the array is not capped)
     * @param {string}  [opts.language]               answer language, e.g. 'Sinhala'
     * @param {string}  [opts.instructions]           extra guidance for the model
     * @param {string}  [opts.model]
     * @param {string}  [opts.userName]
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<{ok:boolean, text:string, answer:string, sources:Array<{title:string|null,url:string|null,description:string|null,date?:string|null,provider?:string,cited?:boolean}>, grounded:boolean, providers:string[], words:number, attempts:number, via:'model'|'digest', model?:string|null, error?:string, message?:string}>}
     */
    async searchWeb(query, opts = {}) {
        const question = String(query ?? '').trim();
        const failure = (error, message, extra = {}) => ({
            ok: false, text: '', answer: '', sources: [], grounded: false, providers: [], words: 0, attempts: 0, via: 'model', error, message, ...extra,
        });
        if (!question) return failure('VALIDATION_ERROR', 'searchWeb(): query is required');

        const detail = WebAnswer.detailOf(opts.detail);
        const includeSources = opts.includeSources !== false;
        const maxSources = Number.isFinite(opts.maxSources) ? opts.maxSources : 5;
        const minWords = detail === 'long' && Number.isFinite(opts.minWords) ? Math.max(0, opts.minWords) : detail === 'long' ? 150 : 0;

        // ---- 1. search ------------------------------------------------------
        let results = WebSearch.normalise(opts.results, 'caller');
        let providers = results.length ? ['caller'] : [];
        if (!results.length && opts.search !== false) {
            const found = await this.webSearch.search(question, {
                providers: opts.providers,
                maxResults: opts.maxResults,
                signal: opts.signal,
            });
            results = found.results;
            providers = found.providers;
            if (!results.length && this.config.debug) {
                this.log.debug?.(
                    `[AlexaAI] searchWeb: no web results for "${question}" ` +
                        (found.errors.length ? `(${found.errors.map((e) => `${e.provider}: ${e.message}`).join('; ')})` : '') +
                        ' — falling back to DeepAI web access'
                );
            }
        }
        const grounded = results.length > 0;

        // ---- 2. ask the model ---------------------------------------------
        const request = { search: !grounded, webAccess: !grounded, model: opts.model, signal: opts.signal };
        const messages = this.prompts.build({
            message: WebAnswer.prompt(question, {
                detail,
                results: grounded ? results : null,
                language: opts.language,
                instructions: opts.instructions,
            }),
            memories: {},
            history: [],
            userName: opts.userName || null,
        });

        let reply;
        let result;
        let attempts = 0;
        try {
            reply = await this.client.chatDetailed(messages, request);
            result = this._webAnswerFrom(reply, results);
            attempts = 1;

            if (minWords && result.words < minWords && result.answer) {
                // Second chance: keep the first reply in the transcript so the
                // model sees what it wrote, then demand the full layout.
                const retryMessages = [
                    ...messages,
                    { role: 'assistant', content: reply.text },
                    { role: 'user', content: WebAnswer.expandPrompt(question, result.words, { grounded }) },
                ];
                attempts = 2;
                try {
                    const second = await this.client.chatDetailed(retryMessages, request);
                    const candidate = this._webAnswerFrom(second, results, result.sources);
                    if (candidate.words > result.words) {
                        reply = second;
                        result = candidate;
                    }
                } catch (err) {
                    this.log.debug?.(`[AlexaAI] searchWeb expansion failed, keeping first reply: ${err.message}`);
                }
            }
        } catch (err) {
            this.log.warn?.(`[AlexaAI] searchWeb failed: ${err.message}`);
            if (!grounded) return failure(err.code || 'SEARCH_FAILED', err.message, { attempts });
            // The search worked even though the model did not: show the results.
            const sources = AlexaAI._groundedSources(results, []);
            return {
                ok: true,
                text: WebAnswer.render(WebAnswer.digest(results), sources, { includeSources, maxSources }),
                answer: WebAnswer.digest(results),
                sources,
                grounded,
                providers,
                words: 0,
                attempts,
                via: 'digest',
                model: null,
                error: err.code || 'SEARCH_FAILED',
                message: err.message,
            };
        }

        // ---- 3. assemble ----------------------------------------------------
        const { answer, sources, words } = result;
        if (!answer && !sources.length) return failure('DEEPAI_EMPTY', 'DeepAI returned no answer', { attempts, grounded, providers });

        const text = WebAnswer.render(answer, sources, { includeSources: includeSources || !answer, maxSources });
        return { ok: true, text, answer, sources, grounded, providers, words, attempts, via: 'model', model: reply.model || null };
    }

    /**
     * @private Turn one chat reply into `{ answer, sources, words }`.
     *
     * Grounded (we searched): citation markers `[n]` are removed from the
     * prose and decide the order of the sources; any URL the model wrote is
     * discarded. Ungrounded: DeepAI's web-results packet comes first (it
     * carries descriptions), then whatever the model listed; duplicates
     * collapse by URL.
     */
    _webAnswerFrom(reply, results = [], carried = []) {
        let formatted = ResponseFormatter.format(MemoryExtractor.strip(reply.text));
        // Keep third-party vendor names: this is research output, not the
        // assistant introducing herself. WebAnswer removes the sentences in
        // which the model talks about *itself*.
        formatted = this.identityGuard.sanitise(formatted, false, { vendors: false });
        const parsed = WebAnswer.parse(formatted);

        if (results.length) {
            const { text, cited } = WebAnswer.extractCitations(WebAnswer.stripUrls(parsed.text, results), results.length);
            return { answer: text, sources: AlexaAI._groundedSources(results, cited), words: WebAnswer.wordCount(text) };
        }
        const sources = WebAnswer.mergeSources(AlexaAI._sources(reply.webResults), parsed.sources, carried);
        return { answer: parsed.text, sources, words: WebAnswer.wordCount(parsed.text) };
    }

    /** @private search results as sources: cited ones first, in citation order. */
    static _groundedSources(results, cited) {
        const order = [...cited.map((n) => n - 1), ...results.map((_, i) => i).filter((i) => !cited.includes(i + 1))];
        return order
            .filter((i) => results[i])
            .map((i) => ({
                title: results[i].title || null,
                url: results[i].url,
                description: results[i].description || null,
                date: results[i].date || null,
                provider: results[i].provider || null,
                cited: cited.includes(i + 1),
            }));
    }

    /** Is DeepAI reachable and is the key still good? */
    async deepaiHealth() {
        const started = Date.now();
        try {
            const text = await this.client.chat([{ role: 'user', content: 'Reply with the single word: ok' }], {
                models: [this.config.model],
            });
            return { ok: true, latencyMs: Date.now() - started, reply: text.slice(0, 60), model: this.config.model };
        } catch (err) {
            return { ok: false, latencyMs: Date.now() - started, error: err.code || 'DEEPAI_ERROR', message: err.message };
        }
    }

    /**
     * Legacy helper kept for callers that used it directly.
     * Prefer `Media.toApiField()`; this now accepts the same input shapes.
     * @deprecated
     */
    static _imageField(image) {
        return Media.toApiField(image);
    }

    /** @private the image url carried by an /api/* or tool response. */
    static _outputUrl(data) {
        if (!data || typeof data !== 'object') return null;
        const url = data.output_url || data.share_url || data.url || (Array.isArray(data.output) ? data.output[0] : null);
        return typeof url === 'string' && url ? url : null;
    }

    /** @private consistent error for an unusable media argument. */
    static _mediaError(method, code) {
        return {
            ok: false,
            url: null,
            id: null,
            error: code,
            message: `${method}(): pass a Buffer, base64 string, data URI, URL or { buffer | url } object`,
        };
    }

    /** @private normalise DeepAI's web-result payload to {title, url, description}. */
    static _sources(webResults) {
        if (!Array.isArray(webResults)) return [];
        return webResults
            .map((r) => {
                if (typeof r === 'string') return { title: null, url: r, description: null };
                if (!r || typeof r !== 'object') return null;
                return {
                    title: r.title || r.name || null,
                    url: r.url || r.link || r.href || null,
                    description: r.description || r.snippet || r.content || null,
                };
            })
            .filter((r) => r && (r.url || r.title));
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
        // Threads are keyed by the person's canonical address, so resolve the
        // alias the caller happened to use.
        const user = await this.users.findByJid(userJid);
        const canonical = user ? await this.identities.primaryJid(user.id, user.jid) : userJid;
        const contextKey = JidParser.contextKey(canonical, groupJid, this.config.sharedGroupThread);
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

    /**
     * Block a person from using the AI. Works with ANY address they are known
     * under (their @lid or their phone jid) and creates the row if they have
     * never messaged, so a pre-emptive block sticks.
     * @returns {Promise<object>} the user row
     */
    async blockUser(userJid) {
        return this.users.setBlocked(userJid, true);
    }

    /** @returns {Promise<object|null>} the user row (null if never seen) */
    async unblockUser(userJid) {
        return this.users.setBlocked(userJid, false);
    }

    /** Is this person blocked? Follows aliases like everything else. */
    async isBlocked(userJid) {
        return this.users.isBlocked(userJid);
    }

    /**
     * Turn the AI on/off inside one group. Creates the group row when the bot
     * has not seen the group yet, so the setting applies from the first message.
     * @returns {Promise<object>} the group row
     */
    async setGroupEnabled(groupJid, enabled = true) {
        return this.users.setGroupEnabled(groupJid, enabled);
    }

    /** Is the AI enabled in this group? (unknown groups are enabled) */
    async isGroupEnabled(groupJid) {
        const group = await this.users.findGroupByJid(groupJid);
        return group ? group.is_enabled !== false : true;
    }

    async stats() {
        return this.users.stats();
    }

    // =====================================================================
    //  Internals
    // =====================================================================

    /** @private */
    static _normaliseParams(params) {
        // `image` may be a Buffer, base64, data URI, URL, or a { buffer | url }
        // object (see utils/Media). `file` / `media` / `attachment` are aliases.
        const rawImage = params.image ?? params.file ?? params.media ?? params.attachment ?? null;
        return {
            message: params.message == null ? '' : String(params.message).trim(),
            userId: params.userId ?? params.user ?? params.jid,
            groupId: params.groupId ?? params.group ?? null,
            userName: params.userName ?? params.pushName ?? null,
            groupName: params.groupName ?? params.subject ?? null,
            image: Media.normalize(rawImage),
            messageId: params.messageId ?? null,
            isAdmin: Boolean(params.isAdmin),
            signal: params.signal,
            onToken: typeof params.onToken === 'function' ? params.onToken : null,
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
        images = [],
        model = null,
        userId = null,
        aliases = [],
        mergedIdentities = false,
        repairedMemory = false,
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
            images,
            model,
            userId,
            aliases,
            mergedIdentities,
            repairedMemory,
        };
    }
}

module.exports = AlexaAI;
