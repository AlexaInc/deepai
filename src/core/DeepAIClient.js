'use strict';

const { DeepAIError, QuotaExceededError } = require('./errors');

/**
 * DeepAIClient
 * ------------
 * Thin, dependency-free transport for DeepAI's chat endpoint.
 *
 * Wire format was reverse-engineered from the live deepai.org client and
 * verified end-to-end against the production API:
 *
 *   POST https://api.deepai.org/hacking_is_a_serious_crime
 *   headers: { 'api-key': '<tryit key>' }
 *   multipart/form-data:
 *     chat_style       = "chat"
 *     chatHistory      = JSON.stringify([{role, content}, ...])
 *     model            = "standard" | "gpt-4o-mini" | ...
 *     hacker_is_stinky = "very_stinky"
 *
 * The response body is plain streamed UTF-8 text (NOT JSON, NOT SSE).
 * Errors arrive as a JSON object shaped `{"status": "..."}`.
 */
class DeepAIClient {
    /** @param {import('./Config')} config */
    constructor(config) {
        this.config = config;
        this.log = config.logger;

        if (typeof fetch !== 'function') {
            throw new DeepAIError(
                'Global fetch() is unavailable. AlexaAI requires Node.js 18+ (or install undici).',
                { code: 'FETCH_UNAVAILABLE' }
            );
        }
    }

    /**
     * Send a chat history and return the assistant's raw reply text.
     * @param {Array<{role:string, content:string, attachment_uuids?:string[]}>} messages
     * @param {object} [options]
     * @param {string} [options.model]
     * @param {string[]} [options.attachmentUuids]
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<string>}
     */
    async chat(messages, options = {}) {
        const model = options.model || this.config.model;
        const attempts = this.config.maxRetries + 1;
        let lastError;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                return await this._request(messages, model, options);
            } catch (err) {
                lastError = err;

                // Never retry a definitive refusal (quota / paid model / bad key).
                if (err instanceof QuotaExceededError || err.retryable === false) throw err;
                if (attempt === attempts) break;

                const delay = this.config.retryDelay * attempt;
                if (this.config.debug) {
                    this.log.warn?.(`[AlexaAI] DeepAI attempt ${attempt}/${attempts} failed (${err.message}); retrying in ${delay}ms`);
                }
                await DeepAIClient._sleep(delay);
            }
        }
        throw lastError;
    }

    /** @private */
    async _request(messages, model, options) {
        const form = new FormData();
        form.append('chat_style', this.config.chatStyle);
        form.append('chatHistory', JSON.stringify(messages));
        form.append('model', model);
        form.append('hacker_is_stinky', 'very_stinky');

        if (Array.isArray(options.attachmentUuids) && options.attachmentUuids.length) {
            form.append('attachment_uuids', JSON.stringify(options.attachmentUuids));
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeout);

        // Caller-supplied signal chains into ours.
        if (options.signal) {
            if (options.signal.aborted) controller.abort();
            else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }

        let response;
        try {
            response = await fetch(this.config.chatUrl, {
                method: 'POST',
                body: form,
                headers: {
                    'api-key': this.config.key,
                    Origin: 'https://deepai.org',
                    Referer: 'https://deepai.org/',
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                },
                signal: controller.signal,
            });
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new DeepAIError(`DeepAI request timed out after ${this.config.timeout}ms`, {
                    code: 'DEEPAI_TIMEOUT',
                    retryable: true,
                    cause: err,
                });
            }
            throw new DeepAIError(`Network error contacting DeepAI: ${err.message}`, {
                code: 'DEEPAI_NETWORK',
                retryable: true,
                cause: err,
            });
        } finally {
            clearTimeout(timer);
        }

        const text = (await response.text()) ?? '';

        if (!response.ok) {
            throw DeepAIClient._toError(response.status, text);
        }

        // A 200 can still carry a JSON refusal such as
        // {"status": "Only paid accounts can use genius"}.
        const refusal = DeepAIClient._detectJsonStatus(text);
        if (refusal) throw DeepAIClient._toError(200, text, refusal);

        const reply = text.trim();
        if (!reply) {
            throw new DeepAIError('DeepAI returned an empty response', {
                code: 'DEEPAI_EMPTY',
                retryable: true,
            });
        }
        return reply;
    }

    /**
     * Upload a file and return its attachment descriptor.
     * IMPORTANT: this endpoint rejects the `api-key` header ("Invalid
     * authentication credentials") but accepts an anonymous request that
     * carries an Origin header. Verified against the live API.
     * @param {Buffer} buffer
     * @param {string} filename
     * @param {string} mimetype
     * @returns {Promise<{uuid:string, download_url:string, content_type:string}>}
     */
    async uploadAttachment(buffer, filename = 'image.jpg', mimetype = 'image/jpeg') {
        const form = new FormData();
        form.append('file', new Blob([buffer], { type: mimetype }), filename);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeout);

        try {
            const response = await fetch(this.config.uploadUrl, {
                method: 'POST',
                body: form,
                headers: { Origin: 'https://deepai.org', Referer: 'https://deepai.org/' },
                signal: controller.signal,
            });
            const text = await response.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch {
                throw new DeepAIError(`Attachment upload returned non-JSON: ${text.slice(0, 200)}`, {
                    code: 'UPLOAD_BAD_RESPONSE',
                    status: response.status,
                    retryable: true,
                });
            }
            if (!data.success || !data.attachment) {
                throw new DeepAIError(data.error || 'Attachment upload failed', {
                    code: 'UPLOAD_FAILED',
                    status: response.status,
                    body: data,
                });
            }
            return data.attachment;
        } catch (err) {
            if (err instanceof DeepAIError) throw err;
            if (err.name === 'AbortError') {
                throw new DeepAIError('Attachment upload timed out', { code: 'UPLOAD_TIMEOUT', retryable: true });
            }
            throw new DeepAIError(`Attachment upload error: ${err.message}`, {
                code: 'UPLOAD_NETWORK',
                retryable: true,
                cause: err,
            });
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * DeepAI signals refusals with a small JSON body `{"status": "..."}`.
     * A normal reply is plain prose, so only treat *short* JSON as a status.
     * @private
     */
    static _detectJsonStatus(text) {
        const trimmed = text.trim();
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

    /** @private */
    static _toError(status, body, statusMessage) {
        const msg = statusMessage || DeepAIClient._detectJsonStatus(body) || `HTTP ${status}`;
        const lowered = msg.toLowerCase();

        const quotaHints = [
            'quota exceeded',
            'try it exceeded',
            'only paid accounts',
            'paid users',
            'out of credits',
            'invalid authentication',
            'api key',
        ];
        if (quotaHints.some((h) => lowered.includes(h))) {
            return new QuotaExceededError(`DeepAI refused the request: ${msg}`, { status, body });
        }

        // 5xx and 429 are transient.
        const retryable = status >= 500 || status === 429 || status === 408;
        return new DeepAIError(`DeepAI request failed: ${msg}`, {
            status,
            body: body?.slice?.(0, 500),
            retryable,
        });
    }

    static _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

module.exports = DeepAIClient;
