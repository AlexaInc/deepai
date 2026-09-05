'use strict';

/**
 * ImageDescriber
 * --------------
 * Turns an attached photo or document into text the model can reason about,
 * and — when the account really does have vision — hands the attachment
 * straight to the chat call so the model sees the picture itself.
 *
 * PROVIDER CHAIN (first success wins)
 * -----------------------------------
 *  0. Documents           — upload + server-side extraction. Works on FREE
 *                           keys: a .txt/.pdf comes back `complete` and its
 *                           text IS injected into the model context.
 *  1. DeepAI vision       — upload once, then try every model in
 *                           `config.visionModels` (gpt-4o-mini, gpt-4.1-mini,
 *                           gpt-4o, standard …). Anonymous "tryit" keys are
 *                           downgraded server-side and answer "does not
 *                           support image attachments", so a refusal puts the
 *                           provider on a cooldown instead of a permanent
 *                           latch (a plan upgrade then just starts working).
 *  2. OCR (ocr.space)     — reads screenshots, bills, error messages, notes.
 *                           This covers most images people send a WhatsApp bot.
 *  3. Honest fallback     — ask the user to describe it rather than inventing
 *                           a description (the model will happily hallucinate).
 *
 * `describe()` also returns `attachmentUuids`, so AlexaAI can forward the file
 * with the real conversation instead of a one-off side request.
 */
class ImageDescriber {
    /**
     * @param {import('../core/DeepAIClient')} client
     * @param {import('../core/Config')} config
     */
    constructor(client, config) {
        this.client = client;
        this.config = config;
        this.log = config.logger;

        // Cooldown instead of a hard latch: vision may become available later.
        this._visionCooldownUntil = 0;
        this._visionCooldownMs = 30 * 60 * 1000;
        this._modelsRefused = new Set();
        this._ocrOff = !config.ocrEnabled;
    }

    /** True while DeepAI vision is known to be unavailable. */
    get visionUnavailable() {
        return Date.now() < this._visionCooldownUntil;
    }

    /**
     * @param {object} image  { buffer, url, base64, mimetype, filename }
     * @param {string} [caption]
     * @returns {Promise<{
     *   ok:boolean, description:string|null, source:string|null,
     *   reason:string|null, attachmentUuids:string[]
     * }>}
     */
    async describe(image, caption = '') {
        if (!image || (!image.buffer && !image.url && !image.base64 && !image.data)) {
            return ImageDescriber._fail('no_image');
        }

        // Make sure we have bytes; OCR needs them and so does the upload.
        const buffer = await this._resolveBuffer(image);
        if (!buffer) return ImageDescriber._fail('unreadable');

        const isDocument = ImageDescriber._isDocument(image);

        // Upload once and reuse the uuid for every provider attempt.
        let uuid = null;
        let extraction = null;
        try {
            const attachment = await this.client.uploadAttachment(
                buffer,
                image.filename || (isDocument ? 'document.txt' : 'image.jpg'),
                image.mimetype || (isDocument ? 'text/plain' : 'image/jpeg')
            );
            uuid = attachment?.uuid ? String(attachment.uuid) : null;
            if (uuid) {
                const settled = (await this.client.getAttachment(uuid)) || attachment;
                extraction = settled?.extraction_status || null;
            }
        } catch (err) {
            if (this.config.debug) this.log.warn?.(`[AlexaAI] Attachment upload failed: ${err.message}`);
        }

        const uuids = uuid ? [uuid] : [];

        // ---- 0. Documents: extraction genuinely works on free keys --------
        if (uuid && isDocument && extraction === 'complete') {
            const viaDoc = await this._ask(uuid, caption, {
                document: true,
                models: [this.config.model, ...this.config.visionModels],
            });
            if (viaDoc.ok) return { ...viaDoc, source: 'document', attachmentUuids: uuids };
        }

        // ---- 1. DeepAI native vision --------------------------------------
        if (uuid && !isDocument && !this.visionUnavailable && extraction !== 'failed') {
            const viaDeepAI = await this._ask(uuid, caption, { models: this.config.visionModels });
            if (viaDeepAI.ok) return { ...viaDeepAI, source: 'deepai', attachmentUuids: uuids };
            if (viaDeepAI.reason === 'plan') this._coolDownVision(extraction);
        }

        // ---- 2. OCR ---------------------------------------------------------
        if (!this._ocrOff) {
            const viaOcr = await this._tryOcr(buffer, image);
            if (viaOcr.ok) return { ...viaOcr, attachmentUuids: uuids };
        }

        return { ...ImageDescriber._fail('vision_unavailable'), attachmentUuids: uuids };
    }

    // ------------------------------------------------------------ providers --

    /**
     * @private Ask the model about an uploaded attachment, walking the model
     * chain until one of them actually looks at it.
     *
     * IMPORTANT: `attachment_uuids` must be a TOP-LEVEL form field. Putting it
     * inside the message object makes DeepAI downgrade the request to
     * `llama-3.1-8b-instruct-turbo`, which then answers "does not support
     * image attachments".
     */
    async _ask(uuid, caption, { models = [], document = false } = {}) {
        const prompt = document
            ? caption
                ? `Using the attached document, answer: ${caption}`
                : 'Summarise the attached document clearly and concisely.'
            : caption
              ? `Look at the attached image and answer: ${caption}`
              : 'Describe the attached image in 2-3 sentences: the main subject, the setting, and any visible text.';

        let sawRefusal = false;
        for (const model of models.filter(Boolean)) {
            if (this._modelsRefused.has(model)) continue;
            try {
                const reply = await this.client.chat([{ role: 'user', content: prompt }], {
                    models: [model], // no silent fallback: we walk the chain ourselves
                    attachmentUuids: [uuid],
                });

                if (ImageDescriber._isRefusal(reply)) {
                    sawRefusal = true;
                    this._modelsRefused.add(model);
                    if (this.config.debug) {
                        this.log.warn?.(`[AlexaAI] ${model} cannot see attachments — trying the next model`);
                    }
                    continue;
                }
                const text = String(reply || '').trim();
                if (text) return { ok: true, description: text, source: null, reason: null };
            } catch (err) {
                const msg = String(err?.message || '').toLowerCase();
                if (
                    msg.includes('does not support image') ||
                    msg.includes('only paid accounts') ||
                    msg.includes('vision-capable') ||
                    msg.includes('quota') ||
                    msg.includes('paid users')
                ) {
                    sawRefusal = true;
                    this._modelsRefused.add(model);
                    continue;
                }
                if (this.config.debug) this.log.warn?.(`[AlexaAI] Vision via ${model} failed: ${err.message}`);
            }
        }
        return ImageDescriber._fail(sawRefusal ? 'plan' : 'error');
    }

    /** @private Park DeepAI vision for a while after a plan refusal. */
    _coolDownVision(extraction) {
        this._visionCooldownUntil = Date.now() + this._visionCooldownMs;
        this._modelsRefused.clear();
        if (this.config.debug) {
            this.log.warn?.(
                `[AlexaAI] DeepAI did not process the image (extraction_status=${extraction}). ` +
                    'Native vision needs a paid DeepAI plan — using OCR for the next 30 minutes.'
            );
        }
    }

    /** @private Is this a text-bearing document rather than an image? */
    static _isDocument(image) {
        const mime = String(image.mimetype || '').toLowerCase();
        const name = String(image.filename || '').toLowerCase();
        if (mime.startsWith('image/')) return false;
        return (
            /^(text\/|application\/(pdf|json|xml|rtf|msword|vnd\.))/.test(mime) ||
            /\.(txt|pdf|docx?|csv|md|json|xml|rtf|pptx?|xlsx?|log)$/.test(name)
        );
    }

    /** @private OCR text extraction. */
    async _tryOcr(buffer, image) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.ocrTimeout);
        try {
            const form = new FormData();
            form.append(
                'base64Image',
                `data:${image.mimetype || 'image/jpeg'};base64,${buffer.toString('base64')}`
            );
            form.append('language', this.config.ocrLanguage);
            form.append('OCREngine', '2');
            form.append('scale', 'true');
            form.append('isTable', 'false');

            const response = await fetch(this.config.ocrUrl, {
                method: 'POST',
                body: form,
                headers: { apikey: this.config.ocrApiKey },
                signal: controller.signal,
            });

            const data = await response.json();
            if (data.IsErroredOnProcessing) {
                if (this.config.debug) {
                    this.log.warn?.(`[AlexaAI] OCR error: ${JSON.stringify(data.ErrorMessage)}`);
                }
                return ImageDescriber._fail('ocr_error');
            }

            const text = String(data?.ParsedResults?.[0]?.ParsedText || '')
                .replace(/\r/g, '')
                .replace(/\n{3,}/g, '\n\n')
                .trim();

            // Empty = a photo with no text. Not a failure, just nothing to read.
            if (text.length < 2) return ImageDescriber._fail('no_text');

            const clipped = text.length > 2500 ? `${text.slice(0, 2500)}…` : text;
            return {
                ok: true,
                source: 'ocr',
                reason: null,
                description: `The image contains the following text (extracted by OCR):\n"""\n${clipped}\n"""`,
            };
        } catch (err) {
            if (this.config.debug) this.log.warn?.(`[AlexaAI] OCR failed: ${err.message}`);
            return ImageDescriber._fail('ocr_error');
        } finally {
            clearTimeout(timer);
        }
    }

    // -------------------------------------------------------------- helpers --

    /** @private Ensure we have raw bytes: buffer, base64/data-URI, or URL. */
    async _resolveBuffer(image) {
        if (Buffer.isBuffer(image.buffer)) return ImageDescriber._cap(image.buffer, this.config.maxImageBytes);
        if (image.buffer instanceof Uint8Array) {
            return ImageDescriber._cap(Buffer.from(image.buffer), this.config.maxImageBytes);
        }

        const inline = image.base64 || image.data;
        if (typeof inline === 'string' && inline) {
            const payload = inline.startsWith('data:') ? inline.slice(inline.indexOf(',') + 1) : inline;
            try {
                return ImageDescriber._cap(Buffer.from(payload, 'base64'), this.config.maxImageBytes);
            } catch {
                return null;
            }
        }

        if (!image.url) return null;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.ocrTimeout);
        try {
            const response = await fetch(image.url, { signal: controller.signal });
            if (!response.ok) return null;
            const arrayBuffer = await response.arrayBuffer();
            return ImageDescriber._cap(Buffer.from(arrayBuffer), this.config.maxImageBytes);
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    static _cap(buffer, max) {
        if (!buffer || !buffer.length) return null;
        return buffer.length > max ? null : buffer;
    }

    static _fail(reason) {
        return { ok: false, description: null, source: null, reason, attachmentUuids: [] };
    }

    /** @private Model said it cannot see the image. */
    static _isRefusal(reply) {
        const lowered = String(reply || '').toLowerCase();
        return (
            lowered.includes("can't see") ||
            lowered.includes('cannot see') ||
            lowered.includes("can't view") ||
            lowered.includes('cannot view') ||
            lowered.includes('unable to view') ||
            lowered.includes('unable to see') ||
            lowered.includes('not able to see') ||
            lowered.includes('not able to view') ||
            lowered.includes("can't read or repeat") ||
            lowered.includes('does not support image') ||
            lowered.includes('no image') ||
            lowered.includes("didn't receive an image") ||
            lowered.includes('i do not have the ability to view')
        );
    }

    /** Friendly WhatsApp-formatted fallback when nothing could be read. */
    static fallbackMessage(caption) {
        if (caption && caption.trim()) {
            return (
                "I can see you've sent me an image, but I'm not able to view pictures right now. 🙏\n\n" +
                'Could you tell me what it shows? Then I can help you straight away!'
            );
        }
        return (
            "Thanks for the picture! 📸 I can't view images at the moment, " +
            'but if you tell me what it shows I would love to help.'
        );
    }
}

module.exports = ImageDescriber;
