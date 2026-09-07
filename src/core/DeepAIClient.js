'use strict';

const { createHash } = require('crypto');

const StreamParser = require('./StreamParser');
const { STANDARD_APIS, TASK_TYPES } = require('./Endpoints');
const { DeepAIError, QuotaExceededError } = require('./errors');

/**
 * DeepAIClient
 * ------------
 * Dependency-free transport for the **whole** DeepAI surface, not just the
 * generative endpoint. Every request shape below was taken from the live
 * deepai.org client source.
 *
 * Chat
 *   POST /hacking_is_a_serious_crime      multipart/form-data, header `api-key`
 *        chat_style, chatHistory, model, session_uuid, sensitivity_request_id,
 *        tool_activity_support, thinking_image_tool_support, enabled_tools,
 *        attachment_uuids, memory_enabled, web_access_enabled, sandbox_enabled,
 *        concierge_enabled, thinking_support, hacker_is_stinky
 *        -> streamed UTF-8 text with embedded packets (see StreamParser), or
 *           `{"task_id": "..."}` when thinking_support is on, or
 *           `{"status": "..."}` on refusal.
 *   GET  /check_chat_task_status?type=&task_id=
 *   GET  /check-sensitivity?request_id=
 *
 * Attachments
 *   POST /chat_attachments/upload         file -> { success, attachment:{uuid,…} }
 *   GET  /chat_attachments/get?uuid=      extraction_status: pending|complete|skipped|failed
 *
 * Sessions            /save_chat_session /get_chat_session /rename_chat_session
 *                     /delete_chat_session /delete_all_chat_history
 * Settings            /chat_memory /chat_sandbox /chat_concierge
 * Moderation          /report_character
 * Classic public API  /api/text2img, /api/image-editor, /api/torch-srgan, …
 */
class DeepAIClient {
    /** @param {import('./Config')} config */
    constructor(config) {
        this.config = config;
        this.log = config.logger;

        this._keys = [...config.keys];
        this._keyIndex = 0;
        this.sessionUuid = DeepAIClient.uuid();
        this._discoveredSalt = null; // { value, at } once /chat has been parsed
        this._saltProbeStarted = false;

        if (typeof fetch !== 'function') {
            throw new DeepAIError(
                'Global fetch() is unavailable. AlexaAI requires Node.js 18+ (or install undici).',
                { code: 'FETCH_UNAVAILABLE' }
            );
        }
    }

    // =====================================================================
    //  Keys
    // =====================================================================

    /** The api-key used for the next request. */
    get apiKey() {
        return this._keys[this._keyIndex] || this.config.key;
    }

    /**
     * Move to the next configured key (or mint an anonymous one when
     * `autoKeyRotation` is enabled). Returns false when nothing is left.
     */
    rotateKey() {
        if (this._keyIndex + 1 < this._keys.length) {
            this._keyIndex++;
            if (this.config.debug) this.log.warn?.('[AlexaAI] Rotating to the next DeepAI key');
            return true;
        }
        if (this.config.autoKeyRotation) {
            const fresh = this.mintTryItKey();
            this._keys.push(fresh);
            this._keyIndex = this._keys.length - 1;
            if (this.config.debug) this.log.warn?.('[AlexaAI] Minted a fresh anonymous DeepAI key');
            return true;
        }
        return false;
    }

    /**
     * Anonymous "try it" key in the shape — and the *hash protocol* —
     * deepai.org's browser client uses. The server verifies the hash chain,
     * so a random `tryit-<digits>-<hex>` string is rejected exactly like an
     * unknown key. Live formula (verified against the minified site code and
     * three independent 2026 clients):
     *
     *   rand = String(Math.round(Math.random() * 100000000000))
     *   h(s) = md5hex(s) reversed
     *   key  = `tryit-${rand}-${h(ua + h(ua + h(ua + rand + SALT)))}`
     *
     * The salt lives in the inline JS of the /chat page and rotates
     * server-side; known salts are tried newest-first and
     * `discoverTryItSalt()` keeps the list fresh at runtime. The key is only
     * valid for the user agent it was hashed with — pass the SAME user agent
     * the requests will send (Config already does this for `mintTryItKey`).
     *
     * @param {string} [userAgent] must be the UA the requests will send
     * @param {string} [salt]      current site salt (default: newest known)
     * @param {string} [rand]      the random middle part (tests only)
     */
    static generateTryItKey(userAgent = 'Mozilla/5.0', salt = DeepAIClient.TRYIT_SALTS[0], rand = String(Math.round(Math.random() * 100000000000))) {
        const rev = (s) => createHash('md5').update(String(s), 'utf8').digest('hex').split('').reverse().join('');
        return `tryit-${rand}-${rev(userAgent + rev(userAgent + rev(userAgent + rand + salt)))}`;
    }

    /** Salts the /chat page has used for the anonymous-key hash chain. */
    static get TRYIT_SALTS() {
        return ['hackers_become_a_little_stinkier_every_time_they_hack', 'suditya_is_a_smelly_hacker'];
    }

    /** The salt used when minting keys: caller override > discovered > newest known. */
    get tryItSalt() {
        if (typeof this.config.tryitSalt === 'string' && this.config.tryitSalt) return this.config.tryitSalt;
        if (this._discoveredSalt && Date.now() - this._discoveredSalt.at < DeepAIClient.SALT_TTL_MS) {
            return this._discoveredSalt.value;
        }
        return DeepAIClient.TRYIT_SALTS[0];
    }

    /**
     * Fetch `/chat` and read the salt out of the inline key-minting script.
     * DeepAI rotates the string every so often; when the regex no longer
     * matches we keep the newest known salt, so this failing is never fatal.
     * Memoized for an hour.
     * @returns {Promise<string|null>} the discovered salt, or null
     */
    async discoverTryItSalt({ force = false, signal = null } = {}) {
        if (!force && this._discoveredSalt && Date.now() - this._discoveredSalt.at < DeepAIClient.SALT_TTL_MS) {
            return this._discoveredSalt.value;
        }
        try {
            const response = await fetch(`${this.config.origin}/chat`, {
                headers: {
                    'User-Agent': this.config.userAgent,
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    Referer: `${this.config.origin}/`,
                },
                signal,
            });
            const html = await response.text();
            const salt = DeepAIClient._extractTryItSalt(html);
            if (salt) {
                this._discoveredSalt = { value: salt, at: Date.now() };
                if (this.config.debug) this.log.debug?.(`[AlexaAI] Discovered DeepAI tryit salt: ${salt}`);
                return salt;
            }
        } catch {
            /* offline or blocked — the known salts still work until rotated */
        }
        return null;
    }

    /** @private pull the salt out of the page source (two shapes observed). */
    static _extractTryItSalt(html) {
        const source = String(html ?? '');
        // Shape 1 (2026): the inline script contains the exact chain
        //   const tryitApiKey='tryit-'+myrandomstr+'-'+myhashfunction(...(userAgent+myrandomstr+'SALT')));
        const tail = source.split("const tryitApiKey='tryit")[1];
        if (tail) {
            const inner = tail.split("t+myrandomstr+'")[1] || tail.split("t + myrandomstr + '")[1];
            if (inner) {
                const salt = inner.split("'")[0];
                if (DeepAIClient._looksLikeSalt(salt)) return salt;
            }
        }
        // Shape 2: same chain without the named variable.
        const match = source.match(/myrandomstr\s*\+\s*['"]([A-Za-z0-9_. -]{8,120})['"]/);
        if (match && DeepAIClient._looksLikeSalt(match[1])) return match[1];
        return null;
    }

    /** @private a salt is a readable sentence-ish token, not code or html. */
    static _looksLikeSalt(value) {
        return typeof value === 'string' && /^[A-Za-z0-9_ -]{8,120}$/.test(value) && /[a-z]/.test(value) && !/<|>|\{|\}/.test(value);
    }

    /** Mint a key with this client's user agent and the best known salt. */
    mintTryItKey() {
        // Fire-and-forget: next mint (an hour from now) uses the live salt.
        if (!this.config.tryitSalt && !this._discoveredSalt && !this._saltProbeStarted) {
            this._saltProbeStarted = true;
            this.discoverTryItSalt().catch(() => {});
        }
        return DeepAIClient.generateTryItKey(this.config.userAgent, this.tryItSalt);
    }

    /** Browser-identical headers. DeepAI rejects requests without an origin. */
    headers(extra = {}) {
        return {
            'api-key': this.apiKey,
            Origin: this.config.origin,
            Referer: `${this.config.origin}/`,
            'User-Agent': this.config.userAgent,
            ...extra,
        };
    }

    // =====================================================================
    //  Chat
    // =====================================================================

    /**
     * Send a chat history and return the assistant's reply.
     *
     * @param {Array<{role:string, content:string}>} messages
     * @param {object} [options]
     * @param {string} [options.model]
     * @param {string[]} [options.attachmentUuids]
     * @param {string[]} [options.models]            explicit fallback chain
     * @param {boolean} [options.thinking]
     * @param {boolean} [options.webAccess]
     * @param {boolean} [options.search]             force the online/search flags
     * @param {string} [options.chatStyle]
     * @param {string} [options.sessionUuid]
     * @param {(chunk:string, full:string)=>void} [options.onToken] streaming callback
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<string>} the assistant text (packets stripped)
     */
    async chat(messages, options = {}) {
        const result = await this.chatDetailed(messages, options);
        return result.text;
    }

    /**
     * Same as `chat()` but returns everything the stream carried:
     * `{ text, payload, images, functionCall, webResults, thinking, toolActivity, model }`.
     */
    async chatDetailed(messages, options = {}) {
        const chain = DeepAIClient._modelChain(options, this.config);
        const maxAttempts = this.config.maxRetries + 1;

        let lastError;
        for (const model of chain) {
            let attempt = 0;
            // A quota refusal is not a failure of the model — it is a failure
            // of the key, so trying the next key does not consume an attempt.
            let keySwaps = this._keys.length + (this.config.autoKeyRotation ? 2 : 0);

            for (;;) {
                attempt++;
                try {
                    const parsed = await this._chatOnce(messages, model, options);
                    return { ...parsed, model };
                } catch (err) {
                    lastError = err;

                    if (err instanceof QuotaExceededError) {
                        if (keySwaps-- > 0 && this.rotateKey()) {
                            attempt = 0;
                            continue;
                        }
                        break; // every key is spent: fall through to the next model
                    }
                    if (err.retryable === false) break;
                    if (attempt >= maxAttempts) break;

                    const delay = this.config.retryDelay * attempt;
                    if (this.config.debug) {
                        this.log.warn?.(
                            `[AlexaAI] DeepAI ${model} attempt ${attempt}/${maxAttempts} failed (${err.message}); retrying in ${delay}ms`
                        );
                    }
                    await DeepAIClient.sleep(delay);
                }
            }
        }
        throw lastError || new DeepAIError('DeepAI request failed', { code: 'DEEPAI_ERROR' });
    }

    /** @private one request against one model. */
    async _chatOnce(messages, model, options) {
        const form = this.buildChatForm(messages, model, options);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeout);
        const signal = DeepAIClient._linkSignals(controller, options.signal);

        let response;
        try {
            response = await fetch(this.config.url('chat'), {
                method: 'POST',
                body: form,
                headers: this.headers(),
                signal,
            });
        } catch (err) {
            clearTimeout(timer);
            if (err.name === 'AbortError' && options.signal?.aborted) {
                throw new DeepAIError('Chat request cancelled', { code: 'ABORTED', retryable: false });
            }
            if (err.name === 'AbortError') {
                throw new DeepAIError(`DeepAI timed out after ${this.config.timeout}ms`, {
                    code: 'DEEPAI_TIMEOUT',
                    retryable: true,
                });
            }
            throw new DeepAIError(`DeepAI network error: ${err.message}`, {
                code: 'DEEPAI_NETWORK',
                retryable: true,
                cause: err,
            });
        }

        try {
            if (response.status > 299) {
                const body = await response.text();
                throw DeepAIClient._toError(response.status, body);
            }

            // Reasoning models answer with { task_id } and finish asynchronously.
            const contentType = response.headers.get('content-type') || '';
            if (options.thinking ?? this.config.thinkingSupport) {
                const body = await response.text();
                const task = DeepAIClient._safeJson(body);
                if (task?.task_id) {
                    const finished = await this.waitForTask(task.task_id, {
                        type: TASK_TYPES.thinking,
                        signal: options.signal,
                    });
                    return StreamParser.parse(DeepAIClient._taskText(finished));
                }
                if (task?.status) throw DeepAIClient._toError(response.status, body);
                return StreamParser.parse(body);
            }

            const raw = await this._readStream(response, options.onToken);

            // Refusals arrive as a short JSON body even with HTTP 200.
            const status = DeepAIClient._detectJsonStatus(raw);
            if (status) throw DeepAIClient._toError(response.status, raw, status);
            if (contentType.includes('application/json') && !raw.trim()) {
                throw new DeepAIError('DeepAI returned an empty body', {
                    code: 'DEEPAI_EMPTY',
                    retryable: true,
                });
            }

            const parsed = StreamParser.parse(raw);
            if (!parsed.text && !parsed.payload) {
                throw new DeepAIError('DeepAI returned an empty reply', {
                    code: 'DEEPAI_EMPTY',
                    retryable: true,
                });
            }
            parsed.raw = raw;
            return parsed;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Exactly the form the browser posts. Exposed so the host bot (and tests)
     * can inspect or extend it.
     * @returns {FormData}
     */
    buildChatForm(messages, model, options = {}) {
        const cfg = this.config;
        const form = new FormData();

        form.append('chat_style', options.chatStyle || cfg.chatStyle);
        form.append('chatHistory', JSON.stringify(messages));
        form.append('model', model || cfg.model);
        form.append('hacker_is_stinky', 'very_stinky');

        if (cfg.sendSessionUuid) form.append('session_uuid', options.sessionUuid || this.sessionUuid);
        if (options.sensitivityRequestId) form.append('sensitivity_request_id', options.sensitivityRequestId);
        if (cfg.toolActivitySupport) form.append('tool_activity_support', '1');
        if (cfg.thinkingImageToolSupport) form.append('thinking_image_tool_support', '1');
        if (options.thinking ?? cfg.thinkingSupport) form.append('thinking_support', '1');

        const memoryEnabled = options.serverMemory ?? cfg.serverMemory;
        if (memoryEnabled !== undefined) form.append('memory_enabled', memoryEnabled ? 'true' : 'false');
        const webAccess = options.webAccess ?? cfg.webAccess;
        if (webAccess !== undefined) form.append('web_access_enabled', webAccess ? 'true' : 'false');
        if (options.sandbox ?? cfg.sandbox) {
            form.append('sandbox_enabled', 'true');
            form.append('sandbox_turn_id', options.sandboxTurnId || DeepAIClient.uuid());
        }
        if (options.concierge ?? cfg.concierge) form.append('concierge_enabled', 'true');

        if (cfg.enabledTools.length) form.append('enabled_tools', JSON.stringify(cfg.enabledTools));

        if (options.summary) form.append('summary', 'summary');
        if (options.search) {
            form.append('online', 'online');
            form.append('search', 'search');
        }

        // Attachments ride as a TOP-LEVEL field. Putting them inside a message
        // object makes DeepAI downgrade the request to a text-only model.
        const uuids = Array.isArray(options.attachmentUuids) ? options.attachmentUuids.filter(Boolean) : [];
        if (uuids.length) form.append('attachment_uuids', JSON.stringify(uuids.map(String)));

        for (const [field, value] of Object.entries(options.extraFields || {})) {
            form.append(field, typeof value === 'string' ? value : JSON.stringify(value));
        }
        return form;
    }

    /** @private Read the streamed body, feeding `onToken` as text arrives. */
    async _readStream(response, onToken) {
        if (!response.body || typeof response.body.getReader !== 'function') {
            return response.text();
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let full = '';
        let emitted = '';

        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            full += decoder.decode(value, { stream: true });
            if (typeof onToken === 'function') {
                // Only hand the caller clean, packet-free prose.
                const visible = StreamParser.parse(full).text;
                if (visible.length > emitted.length) {
                    const delta = visible.slice(emitted.length);
                    emitted = visible;
                    try {
                        onToken(delta, visible);
                    } catch {
                        /* a broken consumer must not kill the stream */
                    }
                }
            }
        }
        full += decoder.decode();
        return full;
    }

    // =====================================================================
    //  Background tasks  (/check_chat_task_status)
    // =====================================================================

    /** One poll of a background task. */
    async taskStatus(taskId, type = TASK_TYPES.thinking) {
        return this._json(this.config.url('taskStatus', { type, task_id: taskId }), { method: 'GET' });
    }

    /** Poll until a task completes, fails, or `taskPollTimeout` elapses. */
    async waitForTask(taskId, { type = TASK_TYPES.thinking, signal = null } = {}) {
        const deadline = Date.now() + this.config.taskPollTimeout;
        let last = null;
        while (Date.now() < deadline) {
            if (signal?.aborted) throw new DeepAIError('Task polling cancelled', { code: 'ABORTED', retryable: false });
            try {
                last = await this.taskStatus(taskId, type);
            } catch (err) {
                if (err instanceof QuotaExceededError) throw err;
                last = null;
            }
            const status = String(last?.status || '').toUpperCase();
            if (status === 'COMPLETED' || status === 'COMPLETE' || status === 'SUCCESS') return last;
            if (status === 'FAILED' || status === 'ERROR') {
                throw new DeepAIError(`DeepAI task failed: ${last?.error || status}`, {
                    code: 'DEEPAI_TASK_FAILED',
                    retryable: false,
                });
            }
            await DeepAIClient.sleep(this.config.taskPollInterval);
        }
        throw new DeepAIError('DeepAI task timed out', { code: 'DEEPAI_TASK_TIMEOUT', retryable: true });
    }

    /** Sensitivity score for a chat turn (`sensitivity_request_id`). */
    async checkSensitivity(requestId) {
        try {
            const data = await this._json(this.config.url('sensitivity', { request_id: requestId }), {
                method: 'GET',
            });
            return typeof data?.score === 'number' ? data.score : null;
        } catch {
            return null; // never let telemetry break a reply
        }
    }

    // =====================================================================
    //  Attachments
    // =====================================================================

    /**
     * Upload a file so it can be referenced by `attachment_uuids`.
     *
     * The upload route is the one DeepAI endpoint that must be called
     * WITHOUT the `api-key` header — with it the server refuses the upload
     * (exactly what the browser client avoids: it strips the header and
     * relies on `Origin` alone).
     *
     * @param {Buffer|Uint8Array} buffer
     * @param {string} [filename]
     * @param {string} [mimetype]
     * @returns {Promise<object>} attachment row
     */
    async uploadAttachment(buffer, filename = 'image.jpg', mimetype = 'image/jpeg') {
        const form = new FormData();
        form.append('file', new Blob([buffer], { type: mimetype }), filename);

        const data = await this._json(this.config.url('attachmentUpload'), {
            method: 'POST',
            body: form,
            errorCode: 'UPLOAD_FAILED',
            apiKeyHeader: false, // rejected when present — anonymous + Origin works
        });
        if (!data.success || !data.attachment) {
            throw new DeepAIError(data.error || 'Attachment upload failed', {
                code: 'UPLOAD_FAILED',
                body: data,
            });
        }
        return data.attachment;
    }

    /**
     * Poll an attachment until server-side extraction finishes.
     * Images normally return `skipped` (vision is a paid feature); documents
     * return `complete` and their text IS injected into the model context.
     * @param {string} uuid
     * @param {number} [attempts=3]
     * @returns {Promise<object|null>}
     */
    async getAttachment(uuid, attempts = 3) {
        for (let i = 0; i < attempts; i++) {
            try {
                const data = await this._json(this.config.url('attachmentGet', { uuid }), { method: 'GET' });
                const status = data?.attachment?.extraction_status;
                if (data?.success && status !== 'pending' && status !== 'processing') return data.attachment;
            } catch {
                /* retry */
            }
            await DeepAIClient.sleep(1200);
        }
        return null;
    }

    // =====================================================================
    //  Server-side chat sessions
    // =====================================================================

    /** Persist a transcript on DeepAI (`/save_chat_session`). */
    async saveSession({ uuid = this.sessionUuid, title = '', messages = [], model, chatStyle } = {}) {
        const form = new FormData();
        form.append('uuid', uuid);
        form.append('title', title || '');
        form.append('chat_style', chatStyle || this.config.chatStyle);
        form.append('chat_model', model || this.config.model);
        form.append('messages', JSON.stringify(messages));
        return this._json(this.config.url('saveSession'), { method: 'POST', body: form });
    }

    /** Load a transcript (`/get_chat_session`). */
    async getSession(uuid) {
        return this._json(this.config.url('getSession', { uuid }), { method: 'GET' });
    }

    /** Rename a transcript (`/rename_chat_session`). */
    async renameSession(uuid, title) {
        const form = new FormData();
        form.append('uuid', uuid);
        form.append('title', String(title ?? ''));
        return this._json(this.config.url('renameSession'), { method: 'POST', body: form });
    }

    /** Delete one transcript (`/delete_chat_session`). */
    async deleteSession(uuid) {
        const form = new FormData();
        form.append('uuid', uuid);
        return this._json(this.config.url('deleteSession'), { method: 'POST', body: form });
    }

    /** Delete every transcript (`/delete_all_chat_history`). */
    async deleteAllSessions(knownUuids = []) {
        const form = new FormData();
        form.append('my_known_uuids', JSON.stringify(knownUuids));
        return this._json(this.config.url('deleteAllSessions'), { method: 'POST', body: form });
    }

    // =====================================================================
    //  Account-level settings
    // =====================================================================

    /**
     * DeepAI's own long-term memory profile (`/chat_memory`).
     * `action` is omitted to read, or one of the site's actions to write
     * (e.g. 'refresh', 'set_enabled', 'set_profile').
     */
    async chatMemory(action = null, fields = {}) {
        return this._settings('memory', action, fields);
    }

    /** Agent-mode toggle (`/chat_sandbox`). */
    async chatSandbox(enabled) {
        return this._settings('sandbox', enabled === undefined ? null : 'set_enabled', {
            enabled: enabled ? 'true' : 'false',
        });
    }

    /** Background-task toggle (`/chat_concierge`). */
    async chatConcierge(enabled) {
        return this._settings('concierge', enabled === undefined ? null : 'set_enabled', {
            enabled: enabled ? 'true' : 'false',
        });
    }

    /** Abuse report for a character chat (`/report_character`). */
    async reportCharacter({ reason, characterUrl = null, history = [] }) {
        const form = new FormData();
        form.append('reason', String(reason ?? ''));
        if (characterUrl) form.append('character_url', characterUrl);
        form.append('chat_history', JSON.stringify(history));
        return this._json(this.config.url('reportCharacter'), { method: 'POST', body: form });
    }

    /** @private GET-to-read / POST-to-write settings endpoints. */
    async _settings(endpoint, action, fields) {
        const url = this.config.url(endpoint);
        if (!action) return this._json(url, { method: 'GET' });
        const form = new FormData();
        form.append('action', action);
        for (const [k, v] of Object.entries(fields || {})) form.append(k, String(v));
        return this._json(url, { method: 'POST', body: form });
    }

    // =====================================================================
    //  Classic public API  (/api/<name>)
    // =====================================================================

    /**
     * Call any endpoint of DeepAI's public API family.
     *
     *   runApi('text2img', { text: 'a cat' })
     *   runApi('torch-srgan', { image: buffer })
     *   runApi('nsfw-detector', { image: 'https://…' })
     *
     * Buffers/Uint8Arrays are uploaded as files, everything else as fields.
     * @returns {Promise<object>} e.g. `{ id, output_url }`
     */
    async runApi(name, fields = {}, options = {}) {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) {
            if (value == null) continue;
            if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
                const mimetype = options.mimetype || DeepAIClient._sniffMime(value) || 'application/octet-stream';
                form.append(key, new Blob([value], { type: mimetype }), options.filename || `${key}.${DeepAIClient._ext(mimetype)}`);
            } else if (typeof value === 'object' && (value.buffer || value.url)) {
                if (value.url && !value.buffer) {
                    form.append(key, String(value.url));
                    continue;
                }
                const bytes = Buffer.isBuffer(value.buffer) ? value.buffer : Buffer.from(value.buffer);
                const mimetype = value.mimetype || DeepAIClient._sniffMime(bytes) || 'application/octet-stream';
                form.append(key, new Blob([bytes], { type: mimetype }), value.filename || `${key}.${DeepAIClient._ext(mimetype)}`);
            } else if (typeof value === 'object') {
                form.append(key, JSON.stringify(value));
            } else {
                form.append(key, String(value));
            }
        }
        const url = `${this.config.url('api')}/${String(name).replace(/^\/+/, '')}`;
        const data = await this._json(url, { method: 'POST', body: form, signal: options.signal });
        // The classic API reports failures as `{ err: "..." }` or `{ status: "..." }` with HTTP 200.
        if (data?.err) {
            throw DeepAIClient._toError(200, JSON.stringify(data), String(data.err));
        }
        if (typeof data?.status === 'string' && !data.output_url && !data.output && !data.id) {
            throw DeepAIClient._toError(200, JSON.stringify(data), data.status);
        }
        return data;
    }

    /** Text-to-image (`/api/text2img`). Returns `{ id, output_url }`. */
    async text2img(text, extra = {}, options = {}) {
        return this.runApi(this.config.imageModel || STANDARD_APIS.text2img, { text, ...extra }, options);
    }

    /** Prompt-driven image edit (`/api/image-editor`). */
    async editImage(image, text, extra = {}) {
        return this.runApi(STANDARD_APIS.imageEditor, { image, text, ...extra });
    }

    /** 4x upscale (`/api/torch-srgan`). */
    async upscaleImage(image, extra = {}) {
        return this.runApi(STANDARD_APIS.superResolution, { image, ...extra });
    }

    /** Colourise a black-and-white photo (`/api/colorizer`). */
    async colorizeImage(image, extra = {}) {
        return this.runApi(STANDARD_APIS.colorizer, { image, ...extra });
    }

    /** NSFW score (`/api/nsfw-detector`). */
    async detectNsfw(image, extra = {}) {
        return this.runApi(STANDARD_APIS.nsfwDetector, { image, ...extra });
    }

    /** Abstractive summary (`/api/summarization`). */
    async summarize(text, extra = {}) {
        return this.runApi(STANDARD_APIS.summarization, { text, ...extra });
    }

    /** Sentiment labels (`/api/sentiment-analysis`). */
    async sentiment(text, extra = {}) {
        return this.runApi(STANDARD_APIS.sentiment, { text, ...extra });
    }

    // =====================================================================
    //  Internals
    // =====================================================================

    /** @private JSON request with uniform timeout + error handling. */
    async _json(url, { method = 'GET', body = null, headers = {}, signal = null, errorCode = null, apiKeyHeader = true } = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeout);
        const linked = DeepAIClient._linkSignals(controller, signal);

        try {
            const allHeaders = this.headers(headers);
            if (!apiKeyHeader) delete allHeaders['api-key'];
            const response = await fetch(url, {
                method,
                body,
                headers: allHeaders,
                signal: linked,
            });
            const text = await response.text();
            const data = DeepAIClient._safeJson(text);

            if (response.status > 299) {
                throw DeepAIClient._toError(response.status, text, data?.status || data?.error);
            }
            if (data === null) {
                throw new DeepAIError(`DeepAI returned non-JSON from ${url}: ${text.slice(0, 200)}`, {
                    code: errorCode || 'BAD_RESPONSE',
                    status: response.status,
                    retryable: true,
                });
            }
            if (typeof data.status === 'string' && DeepAIClient._isRefusal(data.status)) {
                throw DeepAIClient._toError(response.status, text, data.status);
            }
            return data;
        } catch (err) {
            if (err instanceof DeepAIError) throw err;
            if (err.name === 'AbortError') {
                throw new DeepAIError(`DeepAI request to ${url} timed out`, {
                    code: 'DEEPAI_TIMEOUT',
                    retryable: true,
                });
            }
            throw new DeepAIError(`DeepAI request to ${url} failed: ${err.message}`, {
                code: errorCode || 'DEEPAI_NETWORK',
                retryable: true,
                cause: err,
            });
        } finally {
            clearTimeout(timer);
        }
    }

    /** @private models to try, in order. */
    static _modelChain(options, config) {
        if (Array.isArray(options.models) && options.models.length) return options.models;
        const primary = options.model || config.model;
        return [primary, ...config.fallbackModels.filter((m) => m !== primary)];
    }

    /** @private the assistant text carried by a finished thinking task. */
    static _taskText(task) {
        if (!task) return '';
        return (
            task.result ||
            task.response ||
            task.output ||
            task.text ||
            (typeof task.data === 'string' ? task.data : '') ||
            ''
        );
    }

    /** @private tie an external AbortSignal to our timeout controller. */
    static _linkSignals(controller, external) {
        if (external) {
            if (external.aborted) controller.abort();
            else external.addEventListener?.('abort', () => controller.abort(), { once: true });
        }
        return controller.signal;
    }

    static _safeJson(text) {
        try {
            const parsed = JSON.parse(text);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
            return null;
        }
    }

    /**
     * DeepAI signals refusals with a small JSON body `{"status": "..."}`.
     * A normal reply is plain prose, so only treat *short* JSON as a status.
     * @private
     */
    static _detectJsonStatus(text) {
        const trimmed = String(text ?? '').trim();
        if (!trimmed.startsWith('{') || trimmed.length > 600) return null;
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed.status === 'string') return parsed.status;
            if (parsed && typeof parsed.error === 'string') return parsed.error;
        } catch {
            /* genuine prose that merely starts with '{' */
        }
        return null;
    }

    static _isRefusal(status) {
        return /exceeded|paid|credits|api-key|api key|login|not allowed|forbidden|unauthori[sz]ed/i.test(status);
    }

    /** @private magic-number sniff so uploads carry a real content type. */
    static _sniffMime(b) {
        if (!b || b.length < 4) return null;
        if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
        if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
        if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
        if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
        if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
            return 'image/webp';
        }
        return null;
    }

    /** @private file extension for a mimetype. */
    static _ext(mimetype) {
        const map = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf', 'text/plain': 'txt' };
        return map[mimetype] || 'bin';
    }

    /** @private */
    static _toError(status, body, statusMessage) {
        const msg = statusMessage || DeepAIClient._detectJsonStatus(body) || `HTTP ${status}`;
        const lowered = String(msg).toLowerCase();

        const quotaHints = [
            'quota exceeded',
            'try it exceeded',
            'try-it quota exceeded',
            'only paid accounts',
            'paid users',
            'out of credits',
            'invalid authentication',
            'api key',
            'api-key',
            'please login',
        ];
        if (quotaHints.some((h) => lowered.includes(h))) {
            return new QuotaExceededError(`DeepAI refused the request: ${msg}`, { status, body });
        }

        // 5xx and 429 are transient.
        const retryable = status >= 500 || status === 429 || status === 408;
        return new DeepAIError(`DeepAI request failed: ${msg}`, {
            status,
            body: typeof body === 'string' ? body.slice(0, 500) : body,
            retryable,
        });
    }

    /** RFC4122 v4, without pulling in a dependency. */
    static uuid() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
    }

    static sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /** @deprecated kept for older call sites */
    static _uuid() {
        return DeepAIClient.uuid();
    }

    static _sleep(ms) {
        return DeepAIClient.sleep(ms);
    }
}

/** How long a discovered tryit salt stays fresh. */
DeepAIClient.SALT_TTL_MS = 60 * 60 * 1000;

module.exports = DeepAIClient;
