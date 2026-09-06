'use strict';

/**
 * WebAnswer
 * ---------
 * Prompt and post-processing for `AlexaAI.searchWeb()`.
 *
 * WHY THIS EXISTS
 * ---------------
 * DeepAI's chat endpoint reports web-search results in two different ways,
 * depending on the model that answered:
 *
 *   1. Structured — a trailing JSON packet after the prose
 *        …answer…\u001C[{"title":…,"url":…,"description":…}]
 *      which StreamParser exposes as `webResults`.
 *
 *   2. Unstructured — nothing extra on the wire. The model simply writes a
 *      "Sources:" list of `title (url)` lines at the end of its answer
 *      (observed live with `gpt-4o-mini`: `sources: []`, links inside `text`).
 *
 * On top of that, a plain "search the web and answer" request yields one or
 * two sentences, and some models prepend "I'm a large language model, I don't
 * have the ability to browse the web…" even though the search tool ran.
 *
 * So this module owns three things:
 *
 *   • `prompt()`  — asks for a long, sectioned, WhatsApp-formatted answer with
 *                   numbered points and an explicit trailing "Sources:" list.
 *   • `parse()`   — lifts that list (and inline "(Source: url)" citations) out
 *                   of the prose into `{title, url}` objects, and removes
 *                   first-person "I cannot browse the web" boilerplate.
 *   • `render()`  — appends one clean, de-duplicated *Sources:* block, so the
 *                   WhatsApp message still carries the links exactly once.
 *
 * `parse()` runs on text that ResponseFormatter has already normalised, so it
 * only has to understand WhatsApp-style output: `*Sources:*`, `• title (url)`,
 * `1. title — url`, bare URLs, and a title line followed by a URL line.
 *
 * Third-party names are deliberately left alone: a research answer about
 * Google, Microsoft or OpenAI must not be rewritten the way IdentityGuard
 * rewrites the assistant's own identity. Only sentences in which the model
 * talks about *itself* are removed.
 */

/** A URL, allowing one level of balanced parentheses (Wikipedia_(disambiguation)). */
const URL = String.raw`https?:\/\/(?:[^\s<>()\[\]"'“”]|\([^\s()]*\))+`;
/** Optional list marker: "•", "-", "*", "1.", "1)", "(1)". */
const MARK = String.raw`(?:(?:[-•*·]|\d{1,2}[.)]|[(\[]\d{1,2}[)\]])\s*)?`;
const MARK_ONLY = /^(?:[-•*·]|\d{1,2}[.)]|[(\[]\d{1,2}[)\]])\s+/;
const MARK_ONLY_LINE = /^\s*(?:[-•*·]|\d{1,2}[.)]|[(\[]\d{1,2}[)\]])\s+/gm;

const LINE = {
    /** `Title (https://…)`, `Title [https://…]`, `Title <https://…>` */
    titleParen: new RegExp(`^\\s*${MARK}(.{1,160}?)\\s*[\\(\\[<]\\s*(${URL})\\s*[\\)\\]>]\\s*[.,;]?\\s*$`, 'i'),
    /** `Title — https://…`, `Title: https://…`, `Title | https://…` */
    titleSep: new RegExp(`^\\s*${MARK}(.{1,160}?)\\s*(?:[-–—|]|→|=>|:)\\s*(${URL})\\s*[.,;]?\\s*$`, 'i'),
    /** `Title https://…` (whitespace only — accepted under a heading, not in prose) */
    titleSpace: new RegExp(`^\\s*${MARK}(.{1,160}?)\\s+(${URL})\\s*[.,;]?\\s*$`, 'i'),
    /** `https://… — Title` */
    urlSep: new RegExp(`^\\s*${MARK}(${URL})\\s*(?:[-–—|:]|→)\\s*(.{1,160}?)\\s*$`, 'i'),
    /** `https://…` on its own */
    bareUrl: new RegExp(`^\\s*${MARK}(${URL})\\s*[.,;]?\\s*$`, 'i'),
};

/** A whole line that only introduces the list: "Sources:", "*References*", "Here are the sources I used:" … */
const HEADING = new RegExp(
    '^\\s*[*_~#>•\\-\\s]*' +
        '(?:(?:here|these|below)\\s+are\\s+)?' +
        '(?:(?:some|the|my|a\\s+few|a\\s+couple\\s+of|all|useful|helpful|relevant|main|key|top|additional|related|recommended|official|primary|selected|trusted|reliable|web|online)\\s+)*' +
        '(?:sources?|references?|citations?|links?|reading|further\\s+reading|read\\s+more|learn\\s+more|for\\s+more\\s+(?:information|details|info)|where\\s+to\\s+read\\s+more|(?:sources?|links?)\\s+(?:and|&)\\s+(?:references?|links?))' +
        '(?:\\s+(?:(?:that\\s+)?i\\s+)?(?:used|consulted|found|referenced|cited))?' +
        '(?:\\s+for\\s+this\\s+(?:answer|response))?' +
        '\\s*[*_~]*\\s*:?\\s*[*_~]*\\s*$',
    'i'
);

/** "Sources: https://a, https://b" — heading and items on one line. */
const HEADING_INLINE = /^\s*[*_~#>•\-\s]*(?:sources?|references?|citations?|links?)\s*[*_~]*\s*:\s*[*_~]*\s*(\S.*)$/i;

/** "(Source: https://…)" / "[via https://…]" inside a sentence. */
const INLINE_CITATION = new RegExp(
    `\\s*[(\\[]\\s*(?:sources?|src|via|ref(?:erence)?s?|read\\s+more|more\\s+(?:info|information))\\s*:?\\s*(${URL}(?:\\s*[,;]\\s*${URL})*)\\s*[)\\]]`,
    'gi'
);

/** Titles that are really just labels ("Link", "See also"). */
const LABEL_TITLE = /^(?:sources?|links?|references?|citations?|read\s+more|see|see\s+also|via|from|url|link|website|site|more|here)$/i;
/** Placeholder "sources" that name nothing: "None", "General knowledge, no specific pages". */
const PLACEHOLDER_TITLE =
    /^(?:none|n\/a|not\s+applicable|no\s+(?:specific\s+|particular\s+|external\s+)?(?:sources?|links?|urls?|pages?|websites?)|general\s+knowledge|(?:my|internal|prior|existing)\s+(?:knowledge|training)|based\s+on\s+(?:my|general)\b|various(?:\s+(?:online\s+)?(?:sources?|websites?))?|multiple(?:\s+(?:online\s+)?(?:sources?|websites?))?)\b/i;
/** Trailing prepositions left on a title: "Read the full report at". */
const TITLE_TAIL = /\s+(?:at|from|on|via|in|here|see|visit|to|by)$/i;

/** Vendor / product names the assistant must never attribute itself to. */
const VENDORS =
    'deep\\s*ai|open\\s*ai|chat\\s*gpt|gpt-?\\d[\\w.-]*|claude|gemini|bard|llama[\\w.-]*|mistral|grok|deepseek|qwen|anthropic|google ai|meta ai|standard ai chat|copilot';

/**
 * Sentences in which the model talks about itself instead of the topic.
 * Every alternative is first-person or self-attributing, so an article about
 * "the training data" or "an AI assistant from Google" is untouched. The
 * whole sentence is removed.
 */
const DISCLAIMER = new RegExp(
    '[^.!?\\n]*(?:' +
        // "I'm a large language model", "I am an AI"
        "\\bi(?:'m| am)\\s+(?:just\\s+|only\\s+|merely\\s+)?(?:an?\\s+)?(?:large\\s+)?(?:ai\\s+)?(?:language\\s+)?(?:model|ai)\\b|" +
        // "As an AI (language model), I …"
        '\\bas an? (?:ai|artificial intelligence|(?:large\\s+)?language model)(?:\\s+(?:language\\s+)?(?:model|assistant|system))?\\s*,?\\s+i\\b|' +
        // "I'm ChatGPT", "I was trained by OpenAI", "my developers at OpenAI"
        `\\bi(?:'m| am)\\s+(?:${VENDORS})\\b|` +
        '\\bi\\s+(?:was|am|have\\s+been)\\s+(?:created|made|developed|built|trained|designed)\\s+by\\b|' +
        `\\b(?:i(?:'m| am| use| run on| was| have been)|my (?:developers?|creators?|makers?|team|model|training|underlying model|architecture))\\b[^.!?\\n]{0,60}?\\b(?:${VENDORS})\\b|` +
        // "This response was generated by ChatGPT", "Powered by GPT-4"
        `\\b(?:this|the)\\s+(?:answer|response|report|summary|information|content|text)\\s+(?:was|is|has been)\\s+(?:generated|produced|written|compiled|created|provided)\\s+by\\b[^.!?\\n]{0,40}?\\b(?:${VENDORS})\\b|` +
        `\\bpowered\\s+by\\s+(?:an?\\s+)?(?:${VENDORS})\\b|` +
        // "I can't / don't have the ability to browse the web / access real-time data"
        "\\bi\\s+(?:can(?:'t|not)|cannot|am\\s+(?:not\\s+able|unable)\\s+to|do\\s+not\\s+have|don't\\s+have|lack|have\\s+no)\\b[^.!?\\n,]{0,60}?" +
        '\\b(?:brows\\w*|surf\\w*|(?:the\\s+)?internet|(?:the\\s+)?web\\b|real[- ]time(?:\\s+\\w+)?|live\\s+(?:data|information|updates|access)|up-to-date\\s+information|current\\s+(?:information|data|events)|internet\\s+access|web\\s+access|external\\s+(?:websites?|links?|sources?))|' +
        // knowledge cut-off / training-data caveats
        '\\bmy\\s+(?:knowledge|training)\\s+(?:cut-?off|data)\\b|\\bas of my (?:last|latest|most recent) (?:update|training)\\b|' +
        '\\bbased on (?:my|the) (?:training|available) (?:data|information)\\b' +
        ')[^.!?\\n]*[.!?]*',
    'gi'
);

/** `<Headline>` / `<…>` tokens copied from the layout template. */
const PLACEHOLDER = /<(?!https?:\/\/)(?=[^\s<>])[^<>\n]{0,80}(?<=[^\s<>])>/g;
/** A line with nothing left but list/heading scaffolding once placeholders are gone: "1. **: ", "*:*". */
const SCAFFOLD_LINE = /^[\s\d.)(\-•*_~:…]*$/;

/** "However, " left dangling at the start of the reply once a disclaimer went. */
const DANGLING_CONJUNCTION = /^(?:but|however|that said|still|anyway|nevertheless|nonetheless|instead)\s*,?\s+/i;

class WebAnswer {
    /** Normalise the `detail` option. */
    static detailOf(value) {
        return /^(?:short|brief|concise|quick)$/i.test(String(value ?? '')) ? 'short' : 'long';
    }

    /**
     * The user turn sent to DeepAI.
     *
     * With `results` (the engine's own web search) the model is a writer, not
     * a researcher: it gets numbered search results as material and must
     * build the report from them, citing the numbers. Without results it
     * falls back to DeepAI's server-side search, which is unreliable on free
     * models and frequently invents sources.
     *
     * The long form hands the model a fill-in-the-blanks template rather than
     * a description of one: small models (`gpt-4o-mini`, `standard`) follow a
     * visible layout far more reliably than "write several sections".
     *
     * @param {string} question
     * @param {object} [opts]
     * @param {'short'|'long'} [opts.detail='long']
     * @param {Array<{title?:string,url:string,description?:string,date?:string}>} [opts.results]
     * @param {string} [opts.language]        "Sinhala", "Tamil", … (default: the language of the query)
     * @param {string} [opts.instructions]    extra guidance ("focus on Sri Lanka")
     * @param {Date} [opts.now]
     * @returns {string}
     */
    static prompt(question, { detail = 'long', results = null, language = '', instructions = '', now = new Date() } = {}) {
        const topic = String(question ?? '').trim();
        const today = WebAnswer._isoDate(now);
        const grounded = Array.isArray(results) && results.length > 0;
        const extras = [];
        if (String(language ?? '').trim()) extras.push(`Write the entire answer in ${String(language).trim()}.`);
        if (String(instructions ?? '').trim()) extras.push(String(instructions).trim());
        const extra = extras.length ? `\n\nAdditional instructions: ${extras.join(' ')}` : '';

        const formatting =
            'WhatsApp formatting only: *bold* with single asterisks, _italic_ with underscores, "1." numbered lists. ' +
            'No markdown headers (#), no double asterisks, no tables.';
        const conduct =
            'Do not add notes about training data, knowledge cut-offs or being unable to browse the web, and do not ' +
            'describe yourself or your origins — just present the findings. Never reply with a one-word command.';

        const material = grounded ? WebAnswer.formatResults(results) : '';
        const opening = grounded
            ? 'Below are web search results for the topic. Use them as your material: ' +
              'build the answer from what they say, and put the result number in square brackets after each fact you take from one, like [2]. ' +
              'You may add well-known background knowledge, but do not invent events, figures, dates or quotes.'
            : 'Use your web search tool to research the topic below, then write';
        const sourcesRule = grounded
            ? 'Do NOT write a "Sources" list — the sources are attached automatically from the search results. Never write a URL.'
            : 'End with a line that says exactly "Sources:" followed by the pages you used, one per line, written as "title (url)".';

        if (WebAnswer.detailOf(detail) === 'short') {
            return (
                (grounded
                    ? `${opening}\n\nTopic: ${topic}\nToday's date: ${today}\n\nSearch results:\n${material}\n\n` +
                      'Answer directly in 2 to 4 sentences with the most important current facts (figures, names, dates).\n\n'
                    : `${opening.replace(', then write', '')}, then answer directly in 2 to 4 sentences ` +
                      `with the most important current facts (figures, names, dates).\n\nTopic: ${topic}\nToday's date: ${today}\n\n`) +
                `Rules:\n1. ${formatting}\n2. ${sourcesRule}\n3. ${conduct}` +
                extra
            );
        }

        const layoutSources = grounded ? '' : 'Sources:\n<Page title> (<url>)\n<Page title> (<url>)\n<Page title> (<url>)\n\n';
        const layoutPoint = grounded
            ? '<Two sentences with specific facts, names, figures and dates from the results.> [<result number>]'
            : '<Two sentences with specific facts, names, figures and dates from your search.>';

        return (
            (grounded
                ? `${opening}\n\nTopic: ${topic}\nToday's date: ${today}\n\nSearch results:\n${material}\n\n` +
                  'Write a detailed, well-organised report on the topic for a WhatsApp reader.\n\n'
                : `${opening} a detailed, well-organised report on it for a WhatsApp reader.\n\n` +
                  `Topic: ${topic}\nToday's date: ${today}\n\n`) +
            'Required layout — follow it exactly, replacing every <placeholder> (do not print the angle brackets):\n\n' +
            '<One or two sentences that directly answer or introduce the topic.>\n\n' +
            '*<Section heading 1>:*\n' +
            `1. *<Headline>*: ${layoutPoint}\n` +
            '2. *<Headline>*: <…>\n' +
            '3. *<Headline>*: <…>\n' +
            '4. *<Headline>*: <…>\n\n' +
            '*<Section heading 2>:*\n' +
            '1. *<Headline>*: <…>\n' +
            '2. *<Headline>*: <…>\n' +
            '3. *<Headline>*: <…>\n' +
            '4. *<Headline>*: <…>\n\n' +
            '*<Section heading 3>:*\n' +
            '1. *<Headline>*: <…>\n' +
            '2. *<Headline>*: <…>\n' +
            '3. *<Headline>*: <…>\n\n' +
            layoutSources +
            'Rules:\n' +
            '1. Write 3 to 5 sections with 3 to 4 numbered points each — about 300 to 450 words in total. ' +
            'Never stop after one paragraph.\n' +
            '2. Choose headings that fit the topic. For the topic "coffee" they could be *Recent Coffee News:*, ' +
            '*Coffee Trends:* and *Other Coffee News:*; for a price or exchange-rate question, *Current Rate:*, ' +
            '*Recent Movement:* and *What Is Driving It:*; for a person or company, *Latest News:*, *Background:* ' +
            'and *Key Facts:*.\n' +
            '3. Every point must carry concrete, current information (numbers, names, places, dates) — no filler ' +
            'and no repetition.' +
            (grounded
                ? ' If the results contain little about the topic, say so in the intro and cover what they do contain — never fill the gap with invented details.\n'
                : '\n') +
            `4. ${formatting}\n` +
            `5. ${sourcesRule}${grounded ? '' : ' List at least 3 pages if you can.'}\n` +
            `6. ${conduct}` +
            extra
        );
    }

    /** Numbered search results as prompt material. */
    static formatResults(results, { maxDescription = 300 } = {}) {
        return (Array.isArray(results) ? results : [])
            .map((r, i) => {
                const title = String(r.title || '').trim() || WebAnswer._hostOf(r.url) || 'Untitled';
                const date = r.date ? ` (${r.date})` : '';
                const host = WebAnswer._hostOf(r.url);
                const desc = String(r.description || '').replace(/\s+/g, ' ').trim();
                const body = desc ? `\n   ${desc.length > maxDescription ? `${desc.slice(0, maxDescription - 1).trim()}…` : desc}` : '';
                return `[${i + 1}] ${title}${date}${host ? ` — ${host}` : ''}${body}`;
            })
            .join('\n');
    }

    /**
     * Plain list of the search results — the reply when the model is
     * unavailable but the search worked.
     */
    static digest(results, { max = 6 } = {}) {
        const items = (Array.isArray(results) ? results : []).slice(0, max);
        if (!items.length) return '';
        const lines = items.map((r, i) => {
            const title = String(r.title || '').trim() || WebAnswer._hostOf(r.url) || 'Untitled';
            const date = r.date ? ` _(${r.date})_` : '';
            const desc = String(r.description || '').replace(/\s+/g, ' ').trim();
            return `${i + 1}. *${title}*${date}${desc ? `: ${desc}` : ''}`;
        });
        return `Here is what I found:\n\n${lines.join('\n')}`;
    }

    /** @private */
    static _hostOf(url) {
        try {
            // `URL` above is the regex source; use the WHATWG constructor.
            return new globalThis.URL(String(url)).hostname.replace(/^www\./, '');
        } catch {
            return '';
        }
    }

    /**
     * Turn `[2]` / `[2, 3]` / `[2][3]` citation markers into nothing, and
     * report which result numbers were actually cited (1-based).
     * WhatsApp readers get clean prose; the numbers decide the order of the
     * sources block.
     */
    static extractCitations(text, count) {
        const cited = [];
        const out = String(text ?? '')
            // "[2]", "[2, 3]", "[2-4]", "[Source 2]", "(source: 2)", "(result 3)", "[refs 1, 2]"
            .replace(/\s*[[(](?:(?:sources?|results?|refs?|references?)\s*:?\s*)?(\d{1,2}(?:\s*[,;–-]\s*\d{1,2})*)[\])]/gi, (m, list) => {
                // "(2024)" / "(12)" style numbers in prose are not citations: only
                // bare square brackets or an explicit "source/result" word count.
                if (m.trim().startsWith('(') && !/^\(\s*(?:sources?|results?|refs?|references?)/i.test(m.trim())) return m;
                for (const part of list.split(/\s*[,;]\s*/)) {
                    const range = part.match(/^(\d{1,2})\s*[–-]\s*(\d{1,2})$/);
                    const nums = range ? WebAnswer._range(Number(range[1]), Number(range[2])) : [Number(part)];
                    for (const n of nums) if (n >= 1 && n <= count && !cited.includes(n)) cited.push(n);
                }
                return '';
            })
            .replace(/[ \t]+([.,;:!?])/g, '$1')
            .replace(/[ \t]{2,}/g, ' ');
        return { text: out, cited };
    }

    /**
     * Grounded replies must not contain URLs the model typed itself. A URL
     * that matches one of the search results becomes a citation marker for
     * it; any other URL is removed (with its "(see …)" wrapper).
     */
    static stripUrls(text, results) {
        const keys = new Map();
        (Array.isArray(results) ? results : []).forEach((r, i) => {
            if (r && r.url) keys.set(WebAnswer.urlKey(WebAnswer.cleanUrl(r.url) || r.url), i + 1);
        });
        const swap = (url) => {
            const n = keys.get(WebAnswer.urlKey(WebAnswer.cleanUrl(url) || url));
            return n ? ` [${n}]` : '';
        };
        return String(text ?? '')
            // "(see https://…)", "(source: https://…, https://…)", "(https://…)"
            .replace(new RegExp(`\\s*\\((?:[^()\\n]{0,20}?:?\\s*)?(${URL}(?:\\s*[,;]\\s*${URL})*)\\s*\\)`, 'gi'), (_m, urls) =>
                String(urls)
                    .split(/\s*[,;]\s*/)
                    .map(swap)
                    .join('')
            )
            // "Title (https://…)" style leftovers and bare URLs; sentence punctuation after the URL survives
            .replace(new RegExp(`\\s*(?:\\b(?:at|see|via|from|source|link|read more(?: at)?):?\\s+)?(${URL})`, 'gi'), (_m, url) => {
                const trail = url.match(/[.,;:!?]+$/);
                return swap(trail ? url.slice(0, -trail[0].length) : url) + (trail ? trail[0] : '');
            })
            .replace(/[ \t]+([.,;:!?])/g, '$1')
            .replace(/[ \t]{2,}/g, ' ');
    }

    /** @private */
    static _range(a, b) {
        const out = [];
        if (b < a) [a, b] = [b, a];
        for (let n = a; n <= b && out.length < 30; n++) out.push(n);
        return out;
    }

    /**
     * Split a formatted reply into the prose answer and the sources it listed.
     *
     * @param {string} text  output of ResponseFormatter.format()
     * @returns {{ text: string, sources: Array<{title:string|null,url:string|null,description:string|null}> }}
     */
    static parse(text) {
        let body = WebAnswer.stripDisclaimers(WebAnswer.dropPlaceholders(text));
        const sources = [];

        // 1) Inline "(Source: url)" citations.
        body = body.replace(INLINE_CITATION, (_m, urls) => {
            for (const url of String(urls).split(/\s*[,;]\s*/)) {
                if (url) sources.push(WebAnswer._source(null, url));
            }
            return '';
        });

        // 2) A trailing sources block.
        const lines = body.split('\n');
        let cut = -1;
        let listed = null;

        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (HEADING.test(line)) {
                const block = WebAnswer._parseBlock(lines.slice(i + 1));
                if (block) {
                    cut = i;
                    listed = block;
                }
                break;
            }
            const inline = line.match(HEADING_INLINE);
            if (inline) {
                const items = WebAnswer._parseInline(inline[1]);
                if (!items.length) {
                    // "Sources: general knowledge" / "Sources: none" — a
                    // placeholder, not a list. Drop the line, keep the answer.
                    if (!/https?:\/\//i.test(inline[1]) && WebAnswer._cleanTitle(inline[1].replace(/[.,;]+$/, '')) == null) {
                        cut = i;
                        listed = [];
                    }
                    break;
                }
                const block = WebAnswer._parseBlock(lines.slice(i + 1));
                if (block) {
                    cut = i;
                    listed = [...items, ...block];
                }
                break;
            }
        }

        if (cut === -1) {
            // No heading: accept a run of unmistakable link lines at the very end.
            let i = lines.length - 1;
            const tail = [];
            for (; i >= 0; i--) {
                const line = lines[i].trim();
                if (!line) continue;
                const hit = WebAnswer._parseLine(line, { strict: true });
                if (!hit) break;
                tail.unshift(hit);
            }
            if (tail.length) {
                cut = i + 1;
                listed = tail;
            }
        }

        if (cut !== -1) {
            body = lines.slice(0, cut).join('\n');
            sources.push(...listed);
        }

        body = body
            .replace(/[ \t]+$/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        return { text: body, sources: WebAnswer.mergeSources(sources) };
    }

    /**
     * Remove `<placeholder>` tokens a model copied from the layout template,
     * and any list line that is left with nothing but its marker.
     */
    static dropPlaceholders(text) {
        const input = String(text ?? '');
        if (!input.includes('<')) return input;
        return input
            .split('\n')
            .map((line) => {
                PLACEHOLDER.lastIndex = 0;
                if (!PLACEHOLDER.test(line)) return line;
                const stripped = line.replace(PLACEHOLDER, '').replace(/[ \t]+$/, '');
                return SCAFFOLD_LINE.test(stripped) ? null : stripped;
            })
            .filter((line) => line !== null)
            .join('\n');
    }

    /** Words in a reply (markup and list markers excluded). */
    static wordCount(text) {
        const words = String(text ?? '')
            .replace(/https?:\/\/\S+/g, ' ')
            .replace(MARK_ONLY_LINE, '')
            .replace(/[*_~`]/g, ' ')
            .match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu);
        return words ? words.length : 0;
    }

    /**
     * Follow-up turn sent when the long-form answer came back too short.
     * @param {string} question
     * @param {number} words   how long the first attempt was
     */
    static expandPrompt(question, words, { grounded = false } = {}) {
        return (
            `Your reply was only ${words} words and did not follow the required layout. Rewrite it in full now for ` +
            `the topic "${String(question ?? '').trim()}": one or two intro sentences, then 3 to 5 sections — each a ` +
            'bold *Heading:* line followed by 3 to 4 numbered points written as *Headline*: two sentences of specific, ' +
            'current facts — at least 300 words in total' +
            (grounded
                ? ', built from the search results above with the result number in square brackets after each fact. Do not write URLs or a Sources list. '
                : ', then the "Sources:" list with one "title (url)" per line. Use your web search tool for current details. ') +
            'Output only the report: no apology, no preamble, no notes about your abilities or training data.'
        );
    }

    /** Remove "I'm a language model / I can't browse the web" sentences. */
    static stripDisclaimers(text) {
        const input = String(text ?? '');
        if (!input.trim()) return '';
        let out = input.replace(DISCLAIMER, '');
        if (out !== input) {
            // "…can't browse the web. However, here is…" -> "Here is…"
            out = out.replace(/^\s+/, '');
            const dangling = out.match(DANGLING_CONJUNCTION);
            if (dangling) {
                const rest = out.slice(dangling[0].length);
                out = rest.charAt(0).toUpperCase() + rest.slice(1);
            }
        }
        return out
            .replace(/[ \t]+$/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    /**
     * De-duplicate by URL (ignoring scheme, `www.`, trailing slash and hash),
     * keeping the first title/description seen for each. Title-only entries
     * merge into a linked entry with the same title.
     *
     * @param {...Array<{title?:string,url?:string,description?:string}>} lists
     */
    static mergeSources(...lists) {
        const byKey = new Map();
        const byTitle = new Map();
        const out = [];

        for (const list of lists) {
            for (const item of Array.isArray(list) ? list : []) {
                if (!item || typeof item !== 'object') continue;
                const url = item.url ? WebAnswer.cleanUrl(item.url) : null;
                const title = WebAnswer._cleanTitle(item.title);
                if (!url && !title) continue;

                const key = url ? WebAnswer.urlKey(url) : null;
                const titleKey = title ? title.toLowerCase() : null;
                const existing = (key && byKey.get(key)) || (titleKey && byTitle.get(titleKey)) || null;

                if (existing) {
                    if (!existing.title && title) existing.title = title;
                    if (!existing.url && url) {
                        existing.url = url;
                        byKey.set(key, existing);
                    }
                    if (!existing.description && item.description) existing.description = String(item.description);
                    if (titleKey && !byTitle.has(titleKey)) byTitle.set(titleKey, existing);
                    continue;
                }

                const entry = { title, url, description: item.description ? String(item.description) : null };
                if (key) byKey.set(key, entry);
                if (titleKey) byTitle.set(titleKey, entry);
                out.push(entry);
            }
        }
        return out;
    }

    /**
     * Final WhatsApp text: the answer plus one *Sources:* block.
     *
     * @param {string} body
     * @param {Array<{title?:string,url?:string}>} sources
     * @param {object} [opts]
     * @param {boolean} [opts.includeSources=true]
     * @param {number} [opts.maxSources=5]
     * @param {string} [opts.heading='Sources']
     */
    static render(body, sources, { includeSources = true, maxSources = 5, heading = 'Sources' } = {}) {
        const answer = String(body ?? '').trim();
        const limit = Number.isFinite(maxSources) ? Math.max(0, Math.floor(maxSources)) : 5;
        const lines = includeSources
            ? (Array.isArray(sources) ? sources : [])
                  .filter((s) => s && (s.url || s.title))
                  .slice(0, limit)
                  .map((s, i) => `${i + 1}. ${s.title && s.url ? `${s.title} — ${s.url}` : s.url || s.title}`)
            : [];
        if (!lines.length) return answer;
        const block = `*${heading}:*\n${lines.join('\n')}`;
        return answer ? `${answer}\n\n${block}` : block;
    }

    // ------------------------------------------------------------ helpers --

    /** Trim punctuation the model glues onto a URL. */
    static cleanUrl(url) {
        let out = String(url ?? '').trim();
        out = out.replace(/[.,;:!?'"“”]+$/g, '');
        // A trailing ")" with no matching "(" belongs to the sentence.
        while (out.endsWith(')') && (out.match(/\(/g) || []).length < (out.match(/\)/g) || []).length) {
            out = out.slice(0, -1);
        }
        return out;
    }

    /** Comparison key for a URL. */
    static urlKey(url) {
        return String(url ?? '')
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .replace(/#.*$/, '')
            .replace(/\/+$/, '');
    }

    /** @private */
    static _isoDate(now) {
        const d = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
        return d.toISOString().slice(0, 10);
    }

    /** @private */
    static _cleanTitle(value) {
        if (value == null) return null;
        let title = String(value)
            .replace(/^[\s*_~"'“”\[\]•\-–—:]+|[\s*_~"'“”\[\]:—–\-]+$/g, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
        title = title.replace(TITLE_TAIL, '').trim();
        if (!title || LABEL_TITLE.test(title) || PLACEHOLDER_TITLE.test(title) || /^https?:\/\//i.test(title)) return null;
        return title;
    }

    /** @private */
    static _source(title, url) {
        return { title: WebAnswer._cleanTitle(title), url: url ? WebAnswer.cleanUrl(url) : null, description: null };
    }

    /**
     * @private One list line → source, or null.
     * `strict` (no heading above) refuses "Title https://…" without a real
     * separator and prose-like titles, so a sentence that happens to end in a
     * link is left in the answer.
     */
    static _parseLine(line, { strict = false } = {}) {
        const text = String(line ?? '').trim();
        if (!text || !/https?:\/\//i.test(text)) return null;

        let title = null;
        let url = null;
        let m;
        if ((m = text.match(LINE.bareUrl))) {
            url = m[1];
        } else if ((m = text.match(LINE.titleParen))) {
            [, title, url] = m;
        } else if ((m = text.match(LINE.urlSep))) {
            [, url, title] = m;
        } else if ((m = text.match(LINE.titleSep))) {
            [, title, url] = m;
        } else if (!strict && (m = text.match(LINE.titleSpace))) {
            [, title, url] = m;
        } else {
            return null;
        }

        if (strict && title) {
            const plain = title.replace(/[*_~]/g, '').trim();
            const labelLike = MARK_ONLY.test(text) || /^[^.,;!?]{1,80}$/.test(plain);
            if (!labelLike) return null;
        }
        return WebAnswer._source(title, url);
    }

    /** @private "Title (url), Title (url)" or "url, url" after an inline heading. */
    static _parseInline(rest) {
        const items = [];
        const pairRe = new RegExp(`([^,;()]{1,160}?)\\s*\\(\\s*(${URL})\\s*\\)`, 'gi');
        let m;
        while ((m = pairRe.exec(rest))) items.push(WebAnswer._source(m[1], m[2]));
        if (items.length) return items;
        const urlRe = new RegExp(URL, 'gi');
        while ((m = urlRe.exec(rest))) items.push(WebAnswer._source(null, m[0]));
        return items;
    }

    /**
     * @private Lines under a "Sources:" heading. Returns null when a prose
     * line shows up (then it was not a sources block after all).
     */
    static _parseBlock(lines) {
        const sources = [];
        let pendingTitle = null;

        for (const raw of lines) {
            const line = String(raw).trim();
            if (!line) continue;

            const hit = WebAnswer._parseLine(line);
            if (hit) {
                if (pendingTitle && !hit.title) {
                    hit.title = pendingTitle;
                } else if (pendingTitle) {
                    sources.push(WebAnswer._source(pendingTitle, null));
                }
                pendingTitle = null;
                sources.push(hit);
                continue;
            }

            // A short, link-free line: the title for the URL on the next line,
            // or a source the model named without linking it.
            const bare = line.replace(MARK_ONLY, '');
            if (!/https?:\/\//i.test(bare) && bare.length <= 120 && !/[.!?]$/.test(bare.replace(/[*_~)]+$/, ''))) {
                if (pendingTitle) sources.push(WebAnswer._source(pendingTitle, null));
                pendingTitle = WebAnswer._cleanTitle(bare);
                continue;
            }
            return null;
        }
        if (pendingTitle) sources.push(WebAnswer._source(pendingTitle, null));
        return sources.filter((s) => s.url || s.title);
    }
}

module.exports = WebAnswer;
