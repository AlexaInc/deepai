'use strict';

/**
 * TriggerDetector
 * ---------------
 * The persona demands four EXACT outputs (`weather <city>`, `menu`, `ping`,
 * `doc`) that the WhatsApp bot parses as commands. Small models are not
 * reliable enough for that: live testing showed DeepAI's `standard` model
 * answering "What is the weather in Colombo today?" with a chatty forecast,
 * and "send me the docs" with a 200-word essay, instead of the required
 * one-word outputs.
 *
 * Because a wrong string here breaks the host bot's command routing, these
 * four intents are detected deterministically in code and short-circuit the
 * model entirely. Everything else goes to DeepAI as normal.
 *
 * Strategy: strip politeness/filler words, then match what remains against a
 * small core vocabulary. This is far more robust than one giant regex.
 *
 * Set `triggers: false` in the constructor options to disable.
 */
class TriggerDetector {
    /** Leading filler stripped before matching ("can you please show me the …"). */
    static FILLER = new RegExp(
        '^(?:' +
            [
                'hey', 'hi', 'hello', 'ok', 'okay', 'so', 'now', 'just', 'please', 'pls', 'plz',
                'kindly', 'can', 'could', 'would', 'will', 'you', 'u', 'i', 'we', 'want', 'wanna',
                'need', 'like', 'to', 'get', 'give', 'send', 'show', 'display', 'share', 'tell',
                'let', 'see', 'view', 'open', 'read', 'fetch', 'bring', 'me', 'us', 'my', 'the',
                'a', 'an', 'your', 'ur', 'bot', 'this', 'that', 'what', 'whats', 'which', 'is',
                'are', 'do', 'does', 'have', 'has', 'any', 'all', 'some', 'about', 'of', 'for',
                'alexa', 'main', 'full', 'list', 'help',
            ].join('|') +
            ')\\b[\\s,]*',
        'i'
    );

    static MENU_CORE = /^(?:menu|menus|option|options|command|commands|cmd|cmds|commandlist|feature|features|functions?|capabilities)\b/i;
    static PING_CORE = /^(?:ping|pong|alive|online|up|working|status|uptime|systemstatus|serverstatus|botstatus|test|testing|speedtest)\b/i;
    static DOC_CORE = /^(?:(?:user\s+|usage\s+|quick\s+|start(?:er)?\s+)?(?:doc|docs|documentation|documentations|guide|guides|manual|readme|instruction|instructions|tutorial))\b/i;

    /** Whole-phrase forms that filler-stripping would mangle. */
    static PING_PHRASE = /^(?:are\s+you\s+(?:alive|online|there|up|working|ok)|is\s+(?:the\s+)?(?:bot|server|system)\s+(?:up|online|working|alive)|how\s+to\s+use(?:\s+.*)?)$/i;
    static DOC_PHRASE = /^(?:how\s+(?:do\s+i|to)\s+use(?:\s+(?:you|this|the\s+bot|it))?|where\s+(?:are|is)\s+the\s+(?:docs?|documentation|guide))$/i;

    static WEATHER_WORD = /\b(weather|forecast|temperature|temp|raining|humidity|climate)\b/i;

    /** Never a city name. */
    static STOPWORDS = new Set([
        'today', 'tomorrow', 'now', 'right', 'currently', 'current', 'the', 'a', 'an', 'is', 'it',
        'in', 'at', 'on', 'for', 'of', 'like', 'there', 'here', 'this', 'that', 'what', 'whats',
        'hows', 'how', 'please', 'pls', 'tell', 'me', 'you', 'know', 'check', 'give', 'show',
        'weather', 'forecast', 'temperature', 'temp', 'raining', 'rain', 'sunny', 'humidity',
        'climate', 'hot', 'cold', 'snow', 'windy', 'outside', 'morning', 'evening', 'night',
        'afternoon', 'week', 'weekend', 'and', 'be', 'will', 'going', 'to', 'my', 'area',
        'city', 'town', 'condition', 'conditions', 'report', 'update', 'degrees', 'joke',
        'about', 'man', 'story', 'song', 'poem', 'write', 'explain', 'why', 'when', 'who',
        'talk', 'say', 'said', 'think', 'feel', 'love', 'hate', 'good', 'bad', 'nice',
    ]);

    /** Words implying a creative/verbose request — never a trigger. */
    static CREATIVE = /\b(joke|story|poem|song|essay|write|explain|compose|imagine|pretend|translate|summar|meaning|difference|recipe)\b/i;

    /**
     * @param {string} message
     * @returns {{ type:'weather'|'menu'|'ping'|'doc', output:string }|null}
     */
    static detect(message) {
        const raw = String(message ?? '').trim();
        if (!raw || raw.length > 160) return null;

        // Strip WhatsApp formatting + leading command prefixes + trailing punctuation.
        let text = raw
            .replace(/[*_~`]/g, '')
            .replace(/^[/!.#]+\s*/, '')
            .replace(/[?!.]+$/g, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
        if (!text) return null;

        // A creative request is never a command, even if it mentions "weather".
        if (TriggerDetector.CREATIVE.test(text)) return null;

        // Whole-phrase checks before filler stripping.
        if (TriggerDetector.DOC_PHRASE.test(text)) return { type: 'doc', output: 'doc' };
        if (TriggerDetector.PING_PHRASE.test(text)) return { type: 'ping', output: 'ping' };

        // --- weather needs the raw text (city may be a stripped filler word) ---
        if (TriggerDetector.WEATHER_WORD.test(text)) {
            const city = TriggerDetector._extractCity(text);
            if (city) return { type: 'weather', output: `weather ${city}` };
            return null; // no city -> let the model ask which city
        }

        // --- strip politeness/filler, then match a short core phrase ----------
        const core = TriggerDetector._stripFiller(text);
        if (!core) return null;

        // Only accept short residues: "menu", "commands list", "docs please".
        const wordCount = core.split(/\s+/).length;
        if (wordCount > 3) return null;

        if (TriggerDetector.MENU_CORE.test(core)) return { type: 'menu', output: 'menu' };
        if (TriggerDetector.DOC_CORE.test(core)) return { type: 'doc', output: 'doc' };
        if (TriggerDetector.PING_CORE.test(core)) return { type: 'ping', output: 'ping' };

        return null;
    }

    /** @private Repeatedly remove leading filler words. */
    static _stripFiller(text) {
        let out = text.toLowerCase().trim();
        let guard = 0;
        while (guard++ < 15) {
            const next = out.replace(TriggerDetector.FILLER, '').trim();
            if (next === out) break;
            out = next;
        }
        // Drop trailing politeness.
        return out.replace(/\b(?:please|pls|plz|now|list|thanks|thank\s+you)\b\s*$/i, '').trim();
    }

    /**
     * @private Pull the location out of a weather question.
     * Prefers explicit "in/at/for <City>", then a strict "<City> weather" form.
     */
    static _extractCity(text) {
        const cleaned = text.replace(/[?!.,]+$/g, '').trim();

        // "weather in Colombo", "forecast for New York"
        const prep = cleaned.match(
            /\b(?:in|at|for|near|around)\s+([A-Za-z][A-Za-z .'\u00C0-\u024F-]{1,40})$/i
        );
        if (prep) {
            const city = TriggerDetector._clean(prep[1]);
            if (city) return city;
        }

        // "weather in Kandy right now"
        const prepMid = cleaned.match(
            /\b(?:in|at|for|near|around)\s+([A-Za-z][A-Za-z .'\u00C0-\u024F-]{1,40}?)\s+(?:today|tomorrow|now|right\s+now|currently|please|this\s+\w+|tonight)\b/i
        );
        if (prepMid) {
            const city = TriggerDetector._clean(prepMid[1]);
            if (city) return city;
        }

        // Strict "<City> weather" — at most 3 leading words, none of them verbs.
        const leading = cleaned.match(
            /^((?:[A-Za-z][A-Za-z'\u00C0-\u024F-]{1,20}\s+){0,2}[A-Za-z][A-Za-z'\u00C0-\u024F-]{1,20})\s+(?:weather|forecast|temperature|temp|climate)\b/i
        );
        if (leading) {
            const city = TriggerDetector._clean(leading[1]);
            if (city) return city;
        }

        // Capitalised proper nouns elsewhere in the sentence.
        const capitals = cleaned.match(/\b[A-Z][a-z\u00C0-\u024F]{2,}\b/g);
        if (capitals) {
            const candidates = capitals.filter((w) => !TriggerDetector.STOPWORDS.has(w.toLowerCase()));
            if (candidates.length) return candidates.join(' ').slice(0, 60);
        }

        return null;
    }

    /** @private Remove stopwords; reject if nothing meaningful remains. */
    static _clean(value) {
        const words = String(value)
            .trim()
            .split(/\s+/)
            .map((w) => w.replace(/[^A-Za-z'\u00C0-\u024F-]/g, ''))
            .filter((w) => w && !TriggerDetector.STOPWORDS.has(w.toLowerCase()));

        if (!words.length || words.length > 4) return null;
        const city = words.join(' ').replace(/\s{2,}/g, ' ').trim();
        return city.length >= 2 ? city.slice(0, 60) : null;
    }
}

module.exports = TriggerDetector;
