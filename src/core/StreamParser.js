'use strict';

/**
 * StreamParser
 * ------------
 * DeepAI's chat endpoint does NOT return clean prose. It returns a plain-text
 * stream with three kinds of out-of-band packets embedded in it, exactly as
 * decoded by the browser client:
 *
 *   1. Tool-activity packets   \u001C{"tool_activity":"Searching the web…"}\u001C
 *      Sprinkled anywhere in the stream while a tool runs. The browser strips
 *      them and shows them as a status line.
 *
 *   2. A trailing payload      …answer text…\u001C{"type":"generated_image",…}
 *      Everything after the LAST lone \u001C is JSON: either an array of web
 *      search results, or a generated-image / function-call object.
 *
 *   3. Thinking blocks         \u001dTHINKING_START12s\u001e<chain of thought>\u001dTHINKING_END
 *      Emitted by reasoning-capable models.
 *
 * Before this parser existed the engine forwarded the raw stream to WhatsApp,
 * so users could see control characters, JSON blobs and the model's private
 * chain of thought. `parse()` splits it all apart.
 */
const FS = '\u001C'; // file separator — packet delimiter
const GS = '\u001D'; // group separator — thinking markers
const RS = '\u001E'; // record separator — "12s" <RS> "<cot>"

const ACTIVITY_PACKET = /\u001C(\{[^\u001C]*\})\u001C/g;
const THINK_START = `${GS}THINKING_START`;
const THINK_END = `${GS}THINKING_END`;

class StreamParser {
    /**
     * @param {string} raw full (or partial) response body
     * @returns {{
     *   text: string,
     *   payload: any|null,
     *   payloadRaw: string|null,
     *   toolActivity: string[],
     *   thinking: { text: string|null, duration: string|null }|null,
     *   images: string[],
     *   functionCall: { name: string, arguments: any }|null,
     *   webResults: Array<{title:string,url:string,description?:string}>|null
     * }}
     */
    static parse(raw) {
        const source = String(raw ?? '');

        // ---- 1. tool activity ------------------------------------------------
        const toolActivity = [];
        let text = source.replace(ACTIVITY_PACKET, (_m, json) => {
            try {
                const packet = JSON.parse(json);
                if (typeof packet.tool_activity === 'string') toolActivity.push(packet.tool_activity);
            } catch {
                /* not an activity packet — drop it, it is not prose either */
            }
            return '';
        });

        // ---- 2. trailing JSON payload ---------------------------------------
        let payloadRaw = null;
        let payload = null;
        const fsIndex = text.indexOf(FS);
        if (fsIndex !== -1) {
            const candidate = text.slice(fsIndex + 1).trim();
            if (candidate) {
                try {
                    payload = JSON.parse(candidate);
                    payloadRaw = candidate;
                } catch {
                    // Truncated packet (stream cut mid-JSON): discard it rather
                    // than leaking half a JSON blob into a WhatsApp message.
                    payload = null;
                    payloadRaw = null;
                }
            }
            text = text.slice(0, fsIndex);
        }

        // ---- 3. thinking block ----------------------------------------------
        let thinking = null;
        const start = text.indexOf(THINK_START);
        const end = text.indexOf(THINK_END);
        if (start !== -1 && end !== -1 && end > start) {
            const body = text.slice(start + THINK_START.length, end);
            const sep = body.indexOf(RS);
            thinking =
                sep !== -1
                    ? { duration: body.slice(0, sep) || null, text: body.slice(sep + 1) || null }
                    : { duration: null, text: body || null };
            text = text.slice(0, start) + text.slice(end + THINK_END.length);
        }

        // Any stray separators left over (partial packets) must never ship.
        text = text.replace(/[\u001C\u001D\u001E]/g, '').trim();

        return {
            text,
            payload,
            payloadRaw,
            toolActivity,
            thinking,
            images: StreamParser.imagesFrom(payload),
            functionCall: StreamParser.functionCallFrom(payload),
            webResults: Array.isArray(payload) ? payload : null,
        };
    }

    /** Image URLs carried by a `{type:'generated_image'}` payload. */
    static imagesFrom(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
        const urls = [];
        if (payload.type === 'generated_image' || payload.share_url || payload.output_url) {
            const url = payload.share_url || payload.url || payload.output_url;
            if (typeof url === 'string' && url) urls.push(url);
        }
        if (Array.isArray(payload.images)) {
            for (const img of payload.images) {
                const url = typeof img === 'string' ? img : img?.share_url || img?.url;
                if (url) urls.push(url);
            }
        }
        return urls;
    }

    /** `{function_call:{name, arguments}}` — the image tool protocol. */
    static functionCallFrom(payload) {
        const call = payload && !Array.isArray(payload) ? payload.function_call : null;
        if (!call || typeof call.name !== 'string') return null;
        let args = call.arguments;
        if (typeof args === 'string') {
            try {
                args = JSON.parse(args);
            } catch {
                /* keep the raw string */
            }
        }
        return { name: call.name, arguments: args ?? {} };
    }

    /**
     * Build the payload the browser sends when the user presses "Create image",
     * so the engine can drive DeepAI's in-chat image tool the same way.
     */
    static imageToolPayload(prompt, aspectRatio = '1:1') {
        return JSON.stringify({
            function_call: {
                name: 'generate_image',
                arguments: JSON.stringify({ prompt: String(prompt ?? ''), aspect_ratio: aspectRatio }),
            },
        });
    }
}

module.exports = StreamParser;
