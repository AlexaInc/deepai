'use strict';

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

        // Stable per-instance device id sent as the `deepai_device_id`
        // cookie (see Config.deviceId).
        this.deviceId = this.config.deviceId || DeepAIClient.randomDeviceId();

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
            const fresh = DeepAIClient.generateTryItKey(this.config.userAgent);
            this._keys.push(fresh);
            this._keyIndex = this._keys.length - 1;
            if (this.config.debug) this.log.warn?.('[AlexaAI] Minted a fresh anonymous DeepAI key');
            return true;
        }
        return false;
    }

    /**
     * Anonymous "try it" key: `tryit-<digits>-<32 hex>`.
     *
     * The hex part is a deterministic hash over the User-Agent:
     *      H(UA + H(UA + H(UA + digits + SALT)))
     * and is validated server-side against the request's User-Agent header,
     * so the key must be derived from the UA the request will carry.
     *
     * Anonymous keys are single-use (one key == one request); `headers()`
     * mints a fresh key per request whenever the active key is anonymous.
     *
     * @param {string} [userAgent] the User-Agent the request will carry
     * @returns {string}
     */
    static generateTryItKey(userAgent) {
        const ua = String(
            userAgent ||
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
        );
        const digits = String(Math.round(Math.random() * 100000000000));
        const salt = 'hackers_become_a_little_stinkier_every_time_they_hack';
        const H = DeepAIClient._islandHash;
        const hash = H(ua + H(ua + H(ua + digits + salt)));
        return `tryit-${digits}-${hash}`;
    }

    /** True for anonymous `tryit-…` keys (single-use, hash-validated). */
    static isTryItKey(key) {
        return /^tryit-\d+-[0-9a-f]{32}$/i.test(String(key || ''));
    }

    /**
     * Random device id for the `deepai_device_id` cookie:
     * 32 random bytes encoded as base64url.
     */
    static randomDeviceId() {
        const bytes = typeof crypto !== 'undefined' && crypto.getRandomValues
            ? crypto.getRandomValues(new Uint8Array(32))
            : Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)));
        return Buffer.from(bytes).toString('base64url');
    }

    /**
     * Deterministic hash used to derive anonymous key material from the
     * User-Agent (see `generateTryItKey`). The integer/bit-level behaviour
     * is intentional — do not simplify it.
     * @private
     */
    static _islandHash(input) {
        const a = [];
        for (let b = 0; 64 > b; ) a[b] = 0 | (4294967296 * Math.sin(++b % Math.PI));
        let d, e, f, g = [(d = 1732584193), (e = 4023233417), ~d, ~e], h = [];
        const l = unescape(encodeURI(input)) + '\u0080';
        let k = l.length;
        let c = (--k / 4 + 2) | 15;
        for (h[--c] = 8 * k; ~k; ) h[k >> 2] |= l.charCodeAt(k) << (8 * k--);
        for (let b = 0, m = 0; b < c; b += 16) {
            for (k = g; 64 > m; k = [ (f = k[3]), d + (((f = k[0] + [d & e | ~d & f, f & d | ~f & e, d ^ e ^ f, e ^ (d | ~f)][(k = m >> 4)] + a[m] + ~~h[b | [m, 5 * m + 1, 3 * m + 5, 7 * m][k] & 15]) << (k = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21][4 * k + (m++ % 4)])) | (f >>> -k)), d, e ]) {
                d = k[1] | 0;
                e = k[2];
            }
            for (m = 4; m; ) g[--m] += k[m];
        }
        let result = '';
        for (let i = 0; 32 > i; ) result += ((g[i >> 3] >> 4 * (1 ^ i++)) & 15).toString(16);
        return result.split('').reverse().join('');
    }


    /** True when the active key is an anonymous single-use `tryit-…` key. */
    get usingTryItKey() {
        return DeepAIClient.isTryItKey(this.apiKey);
    }

    /**
     * Browser-identical headers. DeepAI rejects requests without an origin.
     *
     * Anonymous `tryit-…` keys are single-use and validated against a hash
     * of the User-Agent, so whenever the active key is anonymous a fresh
     * key is minted here for this request.
     */
    headers(extra = {}) {
        let apiKey = this.apiKey;
        if (DeepAIClient.isTryItKey(apiKey)) {
            apiKey = DeepAIClient.generateTryItKey(this.config.userAgent);
            this._keys[this._keyIndex] = apiKey;
        }
        return {
            'api-key': apiKey,
            Origin: this.config.origin,
            Referer: `${this.config.origin}/`,
            'User-Agent': this.config.userAgent,
            ...(this.deviceId ? { Cookie: `deepai_device_id=${this.deviceId}` } : {}),
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
        try {
            const url = `${this.config.url('api')}/${String(name).replace(/^\/+/, '')}`;
            const entries = this._buildApiFields(fields, options);
            return await this._apiFormRequest(url, entries, options);
        } catch (err) {
            // A registered key refused for plan reasons ("Pro members in
            // good standing") gets one anonymous browser-shaped retry, the
            // same way the website keeps serving free visitors.
            if (
                err instanceof QuotaExceededError &&
                this.config.anonymousApiFallback !== false &&
                !options._anonymous &&
                !this.usingTryItKey
            ) {
                const anonFields = { ...(options.anonymousExtraFields || {}), ...fields };
                if (this.config.debug) this.log.warn?.(`[AlexaAI] ${name} refused for the registered key; retrying anonymously`);
                return this._runAnonymousApi(name, anonFields, options).catch((anonErr) => {
                    anonErr.message = `${err.message} | anonymous retry: ${anonErr.message}`;
                    throw anonErr;
                });
            }
            throw err;
        }
    }

    /**
     * Run one `/api/<name>` call with a one-shot anonymous key regardless of
     * the configured key. The active keys are swapped out for the duration
     * of the call and restored afterwards.
     * @private
     */
    async _runAnonymousApi(name, fields, options = {}) {
        const previousKeys = this._keys;
        const previousIndex = this._keyIndex;
        this._keys = [DeepAIClient.generateTryItKey(this.config.userAgent)];
        this._keyIndex = 0;
        try {
            return await this.runApi(name, fields, { ...options, _anonymous: true });
        } finally {
            this._keys = previousKeys;
            this._keyIndex = previousIndex;
        }
    }

    /**
     * Normalise API form fields into a transport-neutral entry list:
     * `[[key, { value | buffer, mimetype, filename }], …]`.
     * @private
     */
    _buildApiFields(fields, options = {}) {
        const entries = [];
        for (const [key, value] of Object.entries(fields || {})) {
            if (value == null) continue;
            if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof Blob) {
                entries.push([key, { buffer: value, mimetype: options.mimetype, filename: options.filename }]);
            } else if (typeof value === 'object' && (value.buffer || value.url)) {
                if (value.url && !value.buffer) {
                    entries.push([key, { value: String(value.url) }]);
                } else {
                    entries.push([
                        key,
                        {
                            buffer: Buffer.isBuffer(value.buffer) ? value.buffer : Buffer.from(value.buffer),
                            mimetype: value.mimetype,
                            filename: value.filename,
                        },
                    ]);
                }
            } else if (typeof value === 'object') {
                entries.push([key, { value: JSON.stringify(value) }]);
            } else {
                entries.push([key, { value: String(value) }]);
            }
        }
        return entries;
    }

    /**
     * POST a multipart form to a `/api/*` URL across the configured transport
     * chain. A refusal of the form "Please try this model on deepai.org" can
     * be transport-specific (non-browser TLS stacks receive it even with a
     * perfectly valid key), so on that error the next transport is tried;
     * every other error (quota, auth, network) is final for this request.
     * @private
     */
    async _apiFormRequest(url, entries, options = {}) {
        const chain = await this._transportChain();
        let lastError;
        for (const transport of chain) {
            try {
                const raw = await this._runApiTransport(transport, url, entries, options);
                const data = DeepAIClient._safeJson(raw.body);
                if (raw.status > 299 || data === null) {
                    throw DeepAIClient._toError(raw.status, raw.body, data?.status || data?.error);
                }
                if (data?.err) {
                    throw DeepAIClient._toError(200, JSON.stringify(data), String(data.err));
                }
                if (typeof data?.status === 'string' && !data.share_url && !data.output_url && !data.output && !data.id) {
                    throw DeepAIClient._toError(200, JSON.stringify(data), data.status);
                }
                return data;
            } catch (err) {
                if (DeepAIClient._isTransportRejected(err) && chain.length > 1) {
                    lastError = err;
                    if (this.config.debug) this.log.warn?.(`[AlexaAI] ${transport} transport refused for ${url}; trying the next`);
                    continue;
                }
                if (err instanceof QuotaExceededError || err.retryable === false || err.code === 'ABORTED') throw err;
                throw err;
            }
        }
        throw lastError || new DeepAIError('DeepAI request failed', { code: 'DEEPAI_ERROR' });
    }

    /** @private */
    static _isTransportRejected(err) {
        return /try this model on deepai\.org/i.test(String(err?.message || ''));
    }

    /** Ordered transport list for /api/* calls. @private */
    async _transportChain() {
        const t = this.config.transport;
        if (t === 'fetch') return ['fetch'];
        if (t === 'curl') return ['curl'];
        if (t === 'impersonate') return ['impersonate'];
        // A proxy can only be honoured by the curl transports.
        const chain = this.config.proxy ? ['curl'] : ['fetch', 'curl'];
        if (await DeepAIClient.resolveImpersonateBinary(this.config)) chain.push('impersonate');
        return chain;
    }

    /** @private */
    async _runApiTransport(transport, url, entries, options) {
        if (transport === 'fetch') return this._runApiFetch(url, entries, options);
        const impersonate = transport === 'impersonate';
        const binary = impersonate
            ? await DeepAIClient.resolveImpersonateBinary(this.config)
            : this.config.curlPath;
        return this._runApiCurl(binary, url, entries, options, { impersonate });
    }

    /** @private global-fetch transport (previous behaviour). */
    async _runApiFetch(url, entries, options = {}) {
        const form = new FormData();
        for (const [key, field] of entries) {
            if (field.buffer != null) {
                const bytes = field.buffer instanceof Blob ? Buffer.from(await field.buffer.arrayBuffer()) : field.buffer;
                const mimetype = field.mimetype || DeepAIClient._sniffMime(bytes) || 'application/octet-stream';
                form.append(key, new Blob([bytes], { type: mimetype }), field.filename || `${key}.${DeepAIClient._ext(mimetype)}`);
            } else {
                form.append(key, field.value);
            }
        }
        const data = await this._json(url, { method: 'POST', body: form, signal: options.signal, errorCode: 'BAD_RESPONSE' });
        return { status: 200, body: JSON.stringify(data) };
    }

    /**
     * The User-Agent a curl-impersonate binary sends for the configured
     * target profile. The anonymous key hash must be derived from the exact
     * UA the request carries, so impersonated requests use the profile's own
     * UA instead of `config.userAgent`.
     * @private
     */
    static _impersonateUserAgent(target) {
        const m = /chrome(\d+)/i.exec(String(target || ''));
        const v = m ? m[1] : '136';
        return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`;
    }

    /** @private curl / curl-impersonate subprocess transport. */
    async _runApiCurl(binary, url, entries, options = {}, { impersonate = false } = {}) {
        const ua = impersonate ? DeepAIClient._impersonateUserAgent(this.config.curlImpersonateTarget) : this.config.userAgent;
        const apiKey = DeepAIClient.isTryItKey(this.apiKey)
            ? DeepAIClient.generateTryItKey(ua)
            : this.apiKey;

        const args = impersonate ? ['--impersonate', this.config.curlImpersonateTarget] : [];
        if (this.config.proxy) args.push('-x', this.config.proxy);
        args.push(
            url,
            '-sS', '--compressed',
            '--max-time', String(Math.max(1, Math.round(this.config.timeout / 1000))),
            '-X', 'POST',
            '-H', `api-key: ${apiKey}`,
            '-H', `User-Agent: ${ua}`,
            '-H', `Origin: ${this.config.origin}`,
            '-H', `Referer: ${this.config.origin}/machine-learning-model/${this.config.imageModel}`,
            '-H', 'Accept: */*',
            '-H', 'Accept-Language: en-US,en;q=0.9',
            '-w', '\n%{http_code}'
        );
        if (this.deviceId) args.push('-H', `Cookie: deepai_device_id=${this.deviceId}`);

        const tmpFiles = [];
        try {
            for (const [key, field] of entries) {
                if (field.buffer != null) {
                    const bytes = field.buffer instanceof Blob ? Buffer.from(await field.buffer.arrayBuffer()) : field.buffer;
                    const mimetype = field.mimetype || DeepAIClient._sniffMime(bytes) || 'application/octet-stream';
                    const ext = DeepAIClient._ext(mimetype);
                    const tmp = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'alexa-')) + `/${key}.${ext}`;
                    require('fs').writeFileSync(tmp, bytes);
                    tmpFiles.push(tmp);
                    args.push('-F', `${key}=@${tmp};type=${mimetype}`);
                } else {
                    args.push('-F', `${key}=${field.value}`);
                }
            }
            const out = await DeepAIClient.execCurl(binary, args, this.config.timeout, options.signal);
            const body = String(out).replace(/\r/g, '');
            const idx = body.lastIndexOf('\n');
            const status = Number(body.slice(idx + 1).trim());
            if (!Number.isFinite(status)) {
                throw new DeepAIError(`curl transport failed for ${url}: ${body.slice(0, 200)}`, {
                    code: 'DEEPAI_NETWORK', retryable: true,
                });
            }
            return { status, body: body.slice(0, idx) };
        } finally {
            for (const f of tmpFiles) { try { require('fs').unlinkSync(f); } catch { /* best effort */ } try { require('fs').rmSync(require('path').dirname(f), { recursive: true, force: true }); } catch { /* best effort */ } }
        }
    }

    /**
     * Locate a curl-impersonate binary: explicit path, then the usual
     * executable names on PATH. Cached per path. Tests may override.
     * @private
     */
    static async resolveImpersonateBinary(config) {
        if (config.curlImpersonatePath) return config.curlImpersonatePath;
        if (config._noImpersonateBinary) return null;
        if (!DeepAIClient._impersonateCache) {
            const { execFile } = require('child_process');
            const names = process.platform === 'win32' ? ['curl-impersonate.exe', 'curl-impersonate'] : ['curl-impersonate'];
            DeepAIClient._impersonateCache = new Promise((resolve) => {
                let i = 0;
                const tryNext = () => {
                    if (i >= names.length) return resolve(null);
                    const name = names[i++];
                    execFile(name, ['--version'], { timeout: 5000 }, (err) => resolve(err ? tryNext() : name));
                };
                tryNext();
            });
        }
        return DeepAIClient._impersonateCache;
    }

    /**
     * Run a curl-compatible binary and capture stdout. Separated so tests
     * can stub the subprocess layer.
     * @private
     */
    static async execCurl(binary, args, timeoutMs, signal) {
        const { execFile } = require('child_process');
        return new Promise((resolve, reject) => {
            const child = execFile(binary, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
                if (err && stdout == null) return reject(new DeepAIError(`curl transport error: ${err.message}`, { code: 'DEEPAI_NETWORK', retryable: true }));
                resolve(stdout != null ? stdout : '');
                void stderr;
            });
            if (signal) {
                if (signal.aborted) child.kill();
                else signal.addEventListener('abort', () => child.kill(), { once: true });
            }
        });
    }

    /** Text-to-image (`/api/text2img`). Returns `{ id, output_url }`. */
    async text2img(text, extra = {}, options = {}) {
        return this.runApi(this.config.imageModel || STANDARD_APIS.text2img, { text, ...extra }, options);
    }

    /**
     * Run a classic `/api/<name>` call with a one-shot anonymous key,
     * regardless of the configured key (public wrapper).
     */
    async runApiWithTryItKey(name, fields = {}, options = {}) {
        return this._runAnonymousApi(name, { ...(options.anonymousExtraFields || {}), ...fields }, { ...options, _anonymous: true });
    }

    /** Prompt-driven image edit (`/api/image-editor`). */
    async editImage(image, text, extra = {}, options = {}) {
        return this.runApi(STANDARD_APIS.imageEditor, { image, text, ...extra }, options);
    }

    /** 4x upscale (`/api/torch-srgan`). */
    async upscaleImage(image, extra = {}, options = {}) {
        return this.runApi(STANDARD_APIS.superResolution, { image, ...extra }, options);
    }

    /** Colourise a black-and-white photo (`/api/colorizer`). */
    async colorizeImage(image, extra = {}, options = {}) {
        return this.runApi(STANDARD_APIS.colorizer, { image, ...extra }, {
            anonymousExtraFields: { generation_source: 'img' },
            ...options,
        });
    }

    /** NSFW score (`/api/nsfw-detector`). */
    async detectNsfw(image, extra = {}, options = {}) {
        return this.runApi(STANDARD_APIS.nsfwDetector, { image, ...extra }, {
            anonymousExtraFields: { generation_source: 'img' },
            ...options,
        });
    }

    /** Abstractive summary (`/api/summarization`). */
    async summarize(text, extra = {}, options = {}) {
        return this.runApi(STANDARD_APIS.summarization, { text, ...extra }, {
            anonymousExtraFields: { generation_source: 'img' },
            ...options,
        });
    }

    /** Sentiment labels (`/api/sentiment-analysis`). */
    async sentiment(text, extra = {}) {
        return this.runApi(STANDARD_APIS.sentiment, { text, ...extra });
    }

    // =====================================================================
    //  Internals
    // =====================================================================

    /** @private JSON request with uniform timeout + error handling. */
    async _json(url, { method = 'GET', body = null, headers = {}, signal = null, errorCode = null } = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeout);
        const linked = DeepAIClient._linkSignals(controller, signal);

        try {
            const response = await fetch(url, {
                method,
                body,
                headers: this.headers(headers),
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
        return /exceeded|paid|credits|api-key|api key|login|not allowed|forbidden|unauthori[sz]ed|pro members|good standing|model only available|please try this model/i.test(
            status
        );
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

        // Login-gated models cannot be recovered by key rotation, anonymous
        // retries or another transport — report them as their own error.
        if (lowered.includes('model only available to logged in users')) {
            return new DeepAIError(`DeepAI refused the request: ${msg}`, {
                code: 'DEEPAI_LOGIN_REQUIRED',
                status,
                body,
                retryable: false,
            });
        }

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
            // refusal statuses returned by the API:
            'pro members', // "APIs are only available for Pro members in good standing…"
            'good standing',
            'model only available', // "model only available to (logged in|paid) users"
            'signed in try-it quota exceeded',
            'insufficient_credits',
            'pro user out of credits',
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

module.exports = DeepAIClient;
