'use strict';

/**
 * ImageDescriber
 * --------------
 * Turns an attached image into a short text description that PromptBuilder
 * injects into the conversation.
 *
 * ⚠️ VERIFIED LIMITATION OF ANONYMOUS DEEPAI KEYS
 * ------------------------------------------------
 * Vision was tested end-to-end against the live API:
 *
 *  1. Uploading works (`/chat_attachments/upload` — note it must be called
 *     WITHOUT the `api-key` header but WITH an `Origin` header).
 *  2. Referencing the upload then returns, for every model we may use:
 *       "The selected model (llama-3.1-8b-instruct-turbo) does not support
 *        image attachments. Please use a vision-capable model like GPT-4.1
 *        or switch to Genius mode."
 *     DeepAI silently downgrades anonymous "tryit" keys to a text-only model.
 *  3. Vision-capable models (`gpt-4.1`, `claude-opus-5`, Genius) answer:
 *       {"status": "Only paid accounts can use genius"}
 *  4. Passing a base64 data-URI in the text does NOT work — the model replies
 *     "It appears to be an image pattern encoded in base64."
 *  5. Passing a public image URL makes the model *guess from the filename/URL*,
 *     not actually see the image. Proof: an image containing the text
 *     "SECRET CODE: ZQ7412" hosted at a neutral URL produced
 *     "I can't read or repeat the code in an image."
 *
 * Conclusion: real vision needs a PAID DeepAI key. This class is written so
 * that the moment a paid key is supplied it works automatically, and until
 * then it degrades gracefully instead of hallucinating.
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
        this._visionUnavailable = false; // latch after first refusal
    }

    /**
     * Attempt to describe an image.
     * @param {object} image
     * @param {Buffer} [image.buffer]
     * @param {string} [image.url]     public URL (used if no buffer)
     * @param {string} [image.mimetype]
     * @param {string} [image.filename]
     * @param {string} [caption] user's caption, guides the description
     * @returns {Promise<{ ok: boolean, description: string|null, reason: string|null }>}
     */
    async describe(image, caption = '') {
        if (!image || (!image.buffer && !image.url)) {
            return { ok: false, description: null, reason: 'no_image' };
        }
        if (this._visionUnavailable) {
            return { ok: false, description: null, reason: 'vision_unavailable' };
        }

        try {
            let attachmentUuid = null;

            if (image.buffer) {
                const attachment = await this.client.uploadAttachment(
                    image.buffer,
                    image.filename || 'image.jpg',
                    image.mimetype || 'image/jpeg'
                );
                attachmentUuid = attachment?.uuid || null;
            }

            const prompt = caption
                ? `Look at the attached image and answer: ${caption}`
                : 'Describe the attached image in 2-3 clear sentences: the main subject, setting, and any visible text.';

            const messages = [
                {
                    role: 'user',
                    content: prompt,
                    ...(attachmentUuid ? { attachment_uuids: [attachmentUuid] } : {}),
                },
            ];

            const reply = await this.client.chat(messages, {
                model: this.config.visionModel,
                attachmentUuids: attachmentUuid ? [attachmentUuid] : undefined,
            });

            if (ImageDescriber._isRefusal(reply)) {
                this._visionUnavailable = true;
                return { ok: false, description: null, reason: 'vision_unsupported_plan' };
            }

            return { ok: true, description: reply.trim(), reason: null };
        } catch (err) {
            const msg = String(err?.message || '').toLowerCase();
            if (
                msg.includes('does not support image') ||
                msg.includes('only paid accounts') ||
                msg.includes('vision-capable')
            ) {
                this._visionUnavailable = true;
                if (this.config.debug) {
                    this.log.warn?.('[AlexaAI] Vision disabled: DeepAI plan does not allow image attachments.');
                }
                return { ok: false, description: null, reason: 'vision_unsupported_plan' };
            }
            if (this.config.debug) this.log.warn?.(`[AlexaAI] Image description failed: ${err.message}`);
            return { ok: false, description: null, reason: 'error' };
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
            lowered.includes("i'm not able to see") ||
            lowered.includes('not able to view') ||
            lowered.includes('does not support image') ||
            lowered.includes("can't read or repeat the code in an image")
        );
    }

    /** Friendly WhatsApp-formatted fallback when vision is unavailable. */
    static fallbackMessage(caption) {
        if (caption && caption.trim()) {
            return (
                "I can see you've sent me an image, but I'm not able to view images right now. 🙏\n\n" +
                'Could you describe what it shows? Then I can help you with it straight away!'
            );
        }
        return (
            "Thanks for the picture! 📸 I'm not able to view images at the moment, " +
            'but if you tell me what it shows I would love to help.'
        );
    }
}

module.exports = ImageDescriber;
