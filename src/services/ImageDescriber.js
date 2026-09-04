'use strict';

/**
 * ImageDescriber
 * --------------
 * Turns an attached image into text that PromptBuilder injects into the
 * conversation, so Alexa can answer questions about it.
 *
 * PROVIDER CHAIN (first success wins)
 * -----------------------------------
 *  1. DeepAI attachments  — upload + `attachment_uuids`. This is the "real"
 *     vision path and works on PAID keys. On free `tryit-` keys DeepAI
 *     downgrades every model to `llama-3.1-8b-instruct-turbo` and replies
 *     "does not support image attachments", so we latch it off after the first
 *     refusal instead of burning a request on every image.
 *  2. OCR (ocr.space)     — extracts text from screenshots, documents, error
 *     messages, bills, notes. Verified live: an image containing
 *     "SECRET CODE: ZQ7412" came back correctly. This covers the majority of
 *     images people actually send a WhatsApp bot.
 *  3. Honest fallback     — ask the user to describe it, rather than inventing
 *     a description (the model will happily hallucinate one otherwise).
 *
 * Every provider is optional and independently switchable.
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

        // Latches: once a provider proves unavailable, stop calling it.
        this._deepaiVisionOff = false;
        this._ocrOff = !config.ocrEnabled;
    }

    /**
     * @param {object} image  { buffer, url, mimetype, filename }
     * @param {string} [caption]
     * @returns {Promise<{ok:boolean, description:string|null, source:string|null, reason:string|null}>}
     */
    async describe(image, caption = '') {
        if (!image || (!image.buffer && !image.url)) {
            return { ok: false, description: null, source: null, reason: 'no_image' };
        }

        // Make sure we have bytes; OCR needs them and so does the upload.
        const buffer = await this._resolveBuffer(image);

        // ---- 0. Documents: server-side extraction genuinely works --------
        // Verified live: a .txt upload returns extraction_status 'complete'
        // and its contents ARE injected into the model context.
        if (buffer && ImageDescriber._isDocument(image)) {
            const viaDoc = await this._tryDocument(buffer, image, caption);
            if (viaDoc.ok) return viaDoc;
        }

        // ---- 1. DeepAI native vision (paid keys) --------------------------
        if (!this._deepaiVisionOff && buffer) {
            const viaDeepAI = await this._tryDeepAI(buffer, image, caption);
            if (viaDeepAI.ok) return viaDeepAI;
        }

        // ---- 2. OCR ---------------------------------------------------------
        if (!this._ocrOff && buffer) {
            const viaOcr = await this._tryOcr(buffer, image);
            if (viaOcr.ok) return viaOcr;
        }

        return { ok: false, description: null, source: null, reason: 'vision_unavailable' };
    }

    // ------------------------------------------------------------ providers --

    /**
     * @private DeepAI native attachment flow — the exact sequence the browser
     * performs: upload -> get (await extraction) -> chat.
     *
     * Two important details learned from probing the live API:
     *
     *  • Putting `attachment_uuids` INSIDE the message object force-downgrades
     *    the request to `llama-3.1-8b-instruct-turbo` and returns
     *    "does not support image attachments". Sending it ONLY as a top-level
     *    form field keeps the chosen vision model selected.
     *
     *  • `extraction_status` tells us what the server actually did:
     *      'complete' -> the file's text WAS injected into the model context
     *      'skipped'  -> nothing was injected (images, on non-vision plans)
     *      'failed'   -> extraction error
     */
    async _tryDeepAI(buffer, image, caption) {
        try {
            const attachment = await this.client.uploadAttachment(
                buffer,
                image.filename || 'image.jpg',
                image.mimetype || 'image/jpeg'
            );
            const uuid = attachment?.uuid;
            if (!uuid) throw new Error('no uuid returned');

            // Mirror the browser: confirm extraction state before chatting.
            const settled = (await this.client.getAttachment(uuid)) || attachment;
            const status = settled.extraction_status;

            // 'skipped' means the server attached NOTHING to the model context
            // (no native vision on this plan). Calling chat now would only
            // produce "I can't see images", so latch off and let OCR handle it.
            if (status === 'skipped' || status === 'failed') {
                this._deepaiVisionOff = true;
                if (this.config.debug) {
                    this.log.warn?.(
                        `[AlexaAI] DeepAI did not process the image (extraction_status=${status}). ` +
                            'Native vision requires a paid DeepAI plan — using OCR instead.'
                    );
                }
                return { ok: false, description: null, source: null, reason: 'plan' };
            }

            const prompt = caption
                ? `Look at the attached image and answer: ${caption}`
                : 'Describe the attached image in 2-3 sentences: the main subject, the setting, and any visible text.';

            const reply = await this.client.chat([{ role: 'user', content: prompt }], {
                model: this.config.visionModel,
                attachmentUuids: [uuid],
            });

            if (ImageDescriber._isRefusal(reply)) {
                // Only latch vision off when the server told us it skipped the
                // file. A one-off refusal on a 'complete' attachment may be
                // transient, so don't disable the provider permanently.
                if (status === 'skipped' || status === 'failed') {
                    this._deepaiVisionOff = true;
                    if (this.config.debug) {
                        this.log.warn?.(
                            `[AlexaAI] DeepAI did not process the image (extraction_status=${status}). ` +
                                'Native vision requires a paid DeepAI plan — falling back to OCR.'
                        );
                    }
                }
                return { ok: false, description: null, source: null, reason: 'plan' };
            }

            return { ok: true, description: reply.trim(), source: 'deepai', reason: null };
        } catch (err) {
            const msg = String(err?.message || '').toLowerCase();
            if (
                msg.includes('does not support image') ||
                msg.includes('only paid accounts') ||
                msg.includes('vision-capable')
            ) {
                this._deepaiVisionOff = true;
                if (this.config.debug) {
                    this.log.warn?.('[AlexaAI] DeepAI vision unavailable on this plan — falling back to OCR.');
                }
                return { ok: false, description: null, source: null, reason: 'plan' };
            }
            if (this.config.debug) this.log.warn?.(`[AlexaAI] DeepAI vision failed: ${err.message}`);
            return { ok: false, description: null, source: null, reason: 'error' };
        }
    }

    /**
     * @private Documents (txt / pdf / docx / csv ...) are extracted server-side
     * and their text is injected into the model context — this works on FREE
     * keys, unlike image vision.
     */
    async _tryDocument(buffer, image, caption) {
        try {
            const attachment = await this.client.uploadAttachment(
                buffer,
                image.filename || 'document.txt',
                image.mimetype || 'text/plain'
            );
            const uuid = attachment?.uuid;
            if (!uuid) return { ok: false, description: null, source: null, reason: 'error' };

            const settled = (await this.client.getAttachment(uuid)) || attachment;
            if (settled.extraction_status !== 'complete') {
                return { ok: false, description: null, source: null, reason: 'not_extracted' };
            }

            const prompt = caption
                ? `Using the attached document, answer: ${caption}`
                : 'Summarise the attached document clearly and concisely.';

            const reply = await this.client.chat([{ role: 'user', content: prompt }], {
                model: this.config.visionModel,
                attachmentUuids: [uuid],
            });

            if (ImageDescriber._isRefusal(reply)) {
                return { ok: false, description: null, source: null, reason: 'refused' };
            }
            return { ok: true, description: reply.trim(), source: 'document', reason: null };
        } catch (err) {
            if (this.config.debug) this.log.warn?.(`[AlexaAI] Document extraction failed: ${err.message}`);
            return { ok: false, description: null, source: null, reason: 'error' };
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
                return { ok: false, description: null, source: null, reason: 'ocr_error' };
            }

            const text = String(data?.ParsedResults?.[0]?.ParsedText || '')
                .replace(/\r/g, '')
                .replace(/\n{3,}/g, '\n\n')
                .trim();

            // Empty = a photo with no text. Not a failure, just nothing to read.
            if (text.length < 2) {
                return { ok: false, description: null, source: null, reason: 'no_text' };
            }

            const clipped = text.length > 2500 ? `${text.slice(0, 2500)}…` : text;
            return {
                ok: true,
                source: 'ocr',
                reason: null,
                description: `The image contains the following text (extracted by OCR):\n"""\n${clipped}\n"""`,
            };
        } catch (err) {
            if (this.config.debug) this.log.warn?.(`[AlexaAI] OCR failed: ${err.message}`);
            return { ok: false, description: null, source: null, reason: 'ocr_error' };
        } finally {
            clearTimeout(timer);
        }
    }

    // -------------------------------------------------------------- helpers --

    /** @private Ensure we have raw bytes, downloading a URL if needed. */
    async _resolveBuffer(image) {
        if (image.buffer && Buffer.isBuffer(image.buffer)) return image.buffer;
        if (!image.url) return null;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.ocrTimeout);
        try {
            const response = await fetch(image.url, { signal: controller.signal });
            if (!response.ok) return null;
            const arrayBuffer = await response.arrayBuffer();
            const buf = Buffer.from(arrayBuffer);
            // Guard against someone linking a 50 MB file.
            return buf.length > 12 * 1024 * 1024 ? null : buf;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
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
            lowered.includes("not able to see") ||
            lowered.includes('not able to view') ||
            lowered.includes("can't read or repeat") ||
            lowered.includes('does not support image') ||
            lowered.includes('no image') ||
            lowered.includes("didn't receive an image")
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
