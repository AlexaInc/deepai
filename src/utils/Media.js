'use strict';

/**
 * Media
 * -----
 * One place that turns "whatever the bot handed us" into the media shape the
 * engine works with:
 *
 *     { buffer: Buffer, mimetype: 'image/png', filename: 'image.png' }
 *     { url: 'https://…' }
 *
 * Every public method that takes an image (`chat({ image })`, `describeImage`,
 * `editImage`, `upscaleImage`, `detectNsfw`, `ask()`) runs its input through
 * `normalize()`, so all of them accept the same inputs:
 *
 *   Buffer · Uint8Array · ArrayBuffer
 *   'data:image/png;base64,…'            data URI
 *   '<raw base64>'                        e.g. whatsapp-web.js `media.data`
 *   'https://…'                           remote URL
 *   { buffer, mimetype?, filename? }      Baileys downloadMediaMessage()
 *   { base64 } · { data }                 whatsapp-web.js MessageMedia
 *   { url }
 *
 * Before this existed each method had its own partial check: a bare Buffer
 * was "unreadable" to `describeImage()`, and `{ base64 }` was silently dropped
 * by the `/api/*` helpers, so the request went out with no image at all.
 */
class Media {
    static DEFAULT_IMAGE_MIME = 'image/jpeg';

    /** Extension used for the default filename of each mimetype. */
    static EXTENSIONS = {
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/bmp': 'bmp',
        'application/pdf': 'pdf',
        'text/plain': 'txt',
        'text/markdown': 'md',
        'text/csv': 'csv',
        'application/json': 'json',
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    };

    /**
     * @param {any} input see the list above
     * @returns {{buffer?:Buffer, url?:string, mimetype?:string, filename?:string}|null}
     */
    static normalize(input) {
        if (input == null) return null;

        // ---- raw bytes -------------------------------------------------------
        const bytes = Media._toBuffer(input);
        if (bytes) return Media._withDefaults({ buffer: bytes });

        // ---- strings: data URI, URL, raw base64 ---------------------------------
        if (typeof input === 'string') {
            const str = input.trim();
            if (!str) return null;

            const dataUri = Media._decodeDataUri(str);
            if (dataUri) return Media._withDefaults(dataUri);

            if (/^https?:\/\//i.test(str)) return { url: str };

            const decoded = Media._decodeBase64(str);
            if (decoded) return Media._withDefaults({ buffer: decoded });
            return null;
        }

        if (typeof input !== 'object') return null;

        // ---- objects -------------------------------------------------------------
        const meta = {
            mimetype: Media._cleanMime(input.mimetype || input.mimeType || input.type),
            filename: Media._cleanName(input.filename || input.fileName || input.name),
        };

        const inner = Media._toBuffer(input.buffer);
        if (inner) return Media._withDefaults({ ...input, ...meta, buffer: inner });

        const inline = input.base64 ?? input.data;
        if (typeof inline === 'string' && inline.trim()) {
            const asUri = Media._decodeDataUri(inline.trim());
            if (asUri) {
                return Media._withDefaults({ ...input, ...meta, mimetype: meta.mimetype || asUri.mimetype, buffer: asUri.buffer });
            }
            const decoded = Media._decodeBase64(inline);
            if (decoded) return Media._withDefaults({ ...input, ...meta, buffer: decoded });
        }
        // `data` may also be a nested Buffer/Uint8Array (some libraries do this).
        const nested = Media._toBuffer(input.data);
        if (nested) return Media._withDefaults({ ...input, ...meta, buffer: nested });

        if (typeof input.url === 'string' && /^https?:\/\//i.test(input.url.trim())) {
            const out = { ...input, url: input.url.trim() };
            delete out.buffer;
            delete out.base64;
            delete out.data;
            return out;
        }

        return null;
    }

    /**
     * Shape used for DeepAI's classic `/api/*` family (`runApi`): a URL string
     * is sent as a plain field, bytes as a file upload that keeps its mimetype
     * and filename.
     * @returns {string|{buffer:Buffer, mimetype:string, filename:string}|null}
     */
    static toApiField(input) {
        const media = Media.normalize(input);
        if (!media) return null;
        if (media.url) return media.url;
        return { buffer: media.buffer, mimetype: media.mimetype, filename: media.filename };
    }

    /** True when the media is a text-bearing document rather than a picture. */
    static isDocument(media) {
        if (!media) return false;
        const mime = String(media.mimetype || '').toLowerCase();
        const name = String(media.filename || '').toLowerCase();
        if (mime.startsWith('image/')) return false;
        return (
            /^(text\/|application\/(pdf|json|xml|rtf|msword|vnd\.))/.test(mime) ||
            /\.(txt|pdf|docx?|csv|md|json|xml|rtf|pptx?|xlsx?|log)$/.test(name)
        );
    }

    /**
     * Detect the real content type from the first bytes. Bots frequently
     * label everything `image/jpeg`; DeepAI's upload uses the Blob type.
     * @returns {string|null}
     */
    static sniff(buffer) {
        if (!buffer || buffer.length < 4) return null;
        const b = buffer;
        if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
        if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
        if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
        if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
        if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
        if (
            b.length >= 12 &&
            b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
            b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
        ) {
            return 'image/webp';
        }
        return null;
    }

    // ------------------------------------------------------------ helpers ---

    /** @private Buffer | Uint8Array | ArrayBuffer -> Buffer (null otherwise). */
    static _toBuffer(value) {
        if (value == null) return null;
        if (Buffer.isBuffer(value)) return value.length ? value : null;
        if (value instanceof Uint8Array) return value.length ? Buffer.from(value) : null;
        if (value instanceof ArrayBuffer) return value.byteLength ? Buffer.from(value) : null;
        return null;
    }

    /** @private `data:<mime>;base64,<payload>` -> { buffer, mimetype } */
    static _decodeDataUri(str) {
        const match = /^data:([a-z0-9.+/-]+)?(?:;[a-z0-9=-]+)*;base64,([\s\S]+)$/i.exec(str);
        if (!match) return null;
        const buffer = Media._decodeBase64(match[2]);
        if (!buffer) return null;
        return { buffer, mimetype: Media._cleanMime(match[1]) };
    }

    /**
     * @private Raw base64 -> Buffer. Only strings that really look like base64
     * qualify, so an ordinary sentence is never mistaken for an image.
     */
    static _decodeBase64(str) {
        const raw = String(str);
        // Real base64 payloads contain no spaces (only line breaks, if
        // anything). A sentence with spaces is prose, not an image.
        if (/[ \t]/.test(raw.trim())) return null;
        const compact = raw.replace(/\s+/g, '');
        if (compact.length < 32) return null;
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) && !/^[A-Za-z0-9_-]+={0,2}$/.test(compact)) return null;
        // Base64 of any real file mixes cases and digits; a lower-case word
        // run ("helloworldhelloworld…") is not media.
        if (!/[A-Z]/.test(compact) || !/[a-z]/.test(compact) || !/[0-9+/_-]/.test(compact)) return null;
        try {
            const buffer = Buffer.from(compact, compact.includes('-') || compact.includes('_') ? 'base64url' : 'base64');
            return buffer.length ? buffer : null;
        } catch {
            return null;
        }
    }

    /** @private fill mimetype (sniffed when missing/generic) and filename. */
    static _withDefaults(media) {
        const out = { ...media };
        delete out.base64;
        delete out.data;
        delete out.url;

        const sniffed = Media.sniff(out.buffer);
        const declared = Media._cleanMime(out.mimetype);
        out.mimetype = (declared && declared !== 'application/octet-stream' ? declared : null) || sniffed || Media.DEFAULT_IMAGE_MIME;
        // A wrong label ("image/jpeg" for a PNG) is corrected when the bytes say otherwise.
        if (sniffed && declared && declared.startsWith('image/') && sniffed.startsWith('image/') && sniffed !== declared) {
            out.mimetype = sniffed;
        }

        if (!out.filename) {
            const ext = Media.EXTENSIONS[out.mimetype] || (out.mimetype.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
            out.filename = `${out.mimetype.startsWith('image/') ? 'image' : 'document'}.${ext}`;
        }
        return out;
    }

    static _cleanMime(value) {
        if (!value || typeof value !== 'string') return null;
        const mime = value.trim().toLowerCase().split(';')[0];
        return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime : null;
    }

    static _cleanName(value) {
        if (!value || typeof value !== 'string') return null;
        const name = value.trim().replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').slice(0, 128);
        return name || null;
    }
}

module.exports = Media;
