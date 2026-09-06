'use strict';

/**
 * WebSearch
 * ---------
 * The engine's own web search, used by `AlexaAI.searchWeb()`.
 *
 * WHY THIS EXISTS
 * ---------------
 * DeepAI's chat endpoint accepts `web_access_enabled` / `search` flags, but on
 * the models available to free keys the search runs unreliably — often not at
 * all. Observed live with `gpt-4o-mini`: two consecutive requests about the
 * same topic produced two contradictory "reports", one without any sources
 * and one whose sources were invented URLs. A model cannot be asked to be its
 * own source of truth.
 *
 * So the engine searches first, using free public endpoints that need no API
 * key, and gives the results to the model as material to write from. The
 * URLs the bot shows come from these results, never from the model.
 *
 * Providers (all run in parallel, each with its own timeout):
 *
 *   bing         general web results   bing.com/search?format=rss
 *   bing-news    recent news           bing.com/news RSS
 *   wikipedia    background            en.wikipedia.org API
 *   google-news  recent news           news.google.com RSS
 *   duckduckgo   general web results   lite.duckduckgo.com, then html.duckduckgo.com
 *
 * Verified live on 2026-09-06: the four feeds above answered from a
 * data-centre IP; DuckDuckGo's html endpoint served a bot challenge while
 * the lite endpoint answered, hence the order.
 *
 * A host application with a proper search API (Brave, Serper, Tavily, …)
 * can replace the built-ins with `webSearchProvider: async (query) => results`
 * in the constructor options, or pass `results` straight into `searchWeb()`.
 *
 * Every provider is best-effort: a failure or an empty page yields no results
 * from that provider and never throws out of `search()`.
 */

const PROVIDERS = ['bing', 'bing-news', 'wikipedia', 'google-news', 'duckduckgo'];

/**
 * Hosts that are redirectors or ads, never a source. `news.google.com`
 * article links are kept: they are real (redirecting) links to the story.
 */
const JUNK_HOST = /(?:^|\.)(?:duckduckgo\.com|bing\.com|googleadservices\.com|doubleclick\.net)$|^(?:www\.)?google\.com$/i;

/** DuckDuckGo's "bots use DuckDuckGo too" interstitial. */
const DDG_CHALLENGE = /bots use duckduckgo|anomaly-modal|class="anomaly/i;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

class WebSearch {
    /**
     * @param {object} [config]
     * @param {boolean} [config.webSearch=true]
     * @param {string[]} [config.webSearchProviders]
     * @param {number} [config.webSearchTimeout=8000]     per provider, ms
     * @param {number} [config.webSearchResults=8]        results handed to the model
     * @param {Function} [config.webSearchProvider]       custom `(query, opts) => results`
     * @param {string} [config.userAgent]
     * @param {object} [config.logger]
     * @param {Function} [config.fetch]                   injectable for tests
     */
    constructor(config = {}) {
        this.enabled = config.webSearch !== false;
        this.providers = Array.isArray(config.webSearchProviders) && config.webSearchProviders.length ? config.webSearchProviders : PROVIDERS;
        this.timeout = Number.isFinite(config.webSearchTimeout) ? config.webSearchTimeout : 8000;
        this.maxResults = Number.isFinite(config.webSearchResults) ? config.webSearchResults : 8;
        this.custom = typeof config.webSearchProvider === 'function' ? config.webSearchProvider : null;
        this.userAgent =
            config.userAgent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
        this.log = config.logger || console;
        this.debug = Boolean(config.debug);
        this._fetch = config.fetch || ((...args) => fetch(...args));
    }

    static get PROVIDERS() {
        return [...PROVIDERS];
    }

    /**
     * @param {string} query
     * @param {object} [opts]
     * @param {string[]} [opts.providers]
     * @param {number} [opts.maxResults]
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<{results: Array<{title:string|null,url:string,description:string|null,date:string|null,provider:string}>, providers: string[], errors: Array<{provider:string,message:string}>}>}
     */
    async search(query, opts = {}) {
        const q = String(query ?? '').trim();
        const limit = Number.isFinite(opts.maxResults) ? Math.max(1, opts.maxResults) : this.maxResults;
        const empty = { results: [], providers: [], errors: [] };
        if (!q || !this.enabled) return empty;

        if (this.custom) {
            try {
                const list = await this.custom(q, { maxResults: limit, signal: opts.signal });
                const results = WebSearch.normalise(list, 'custom').slice(0, limit);
                return { results, providers: results.length ? ['custom'] : [], errors: [] };
            } catch (err) {
                return { ...empty, errors: [{ provider: 'custom', message: err.message }] };
            }
        }

        const names = (Array.isArray(opts.providers) && opts.providers.length ? opts.providers : this.providers).filter((n) =>
            PROVIDERS.includes(n)
        );
        const settled = await Promise.allSettled(names.map((name) => this._run(name, q, opts.signal)));

        const perProvider = [];
        const providers = [];
        const errors = [];
        settled.forEach((outcome, i) => {
            const name = names[i];
            if (outcome.status === 'fulfilled' && outcome.value.length) {
                perProvider.push(outcome.value);
                providers.push(name);
            } else if (outcome.status === 'rejected') {
                errors.push({ provider: name, message: outcome.reason?.message || String(outcome.reason) });
                if (this.debug) this.log.debug?.(`[AlexaAI] web search ${name} failed: ${errors[errors.length - 1].message}`);
            }
        });

        return { results: WebSearch.interleave(perProvider, limit), providers, errors };
    }

    /** @private */
    async _run(name, query, signal) {
        switch (name) {
            case 'bing':
                return WebSearch.parseRss(
                    await this._get(`https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&setlang=en`, signal),
                    'bing'
                );
            case 'duckduckgo':
                return this._duckduckgo(query, signal);
            case 'bing-news':
                return WebSearch.parseRss(
                    await this._get(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&setlang=en`, signal),
                    'bing-news'
                );
            case 'google-news':
                return WebSearch.parseRss(
                    await this._get(
                        `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
                        signal
                    ),
                    'google-news'
                );
            case 'wikipedia':
                return WebSearch.parseWikipedia(
                    await this._get(
                        'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=3' +
                            `&srprop=snippet%7Ctimestamp&srsearch=${encodeURIComponent(query)}`,
                        signal,
                        { 'user-agent': 'alexa-ai (https://github.com/AlexaInc/deepai)', accept: 'application/json' }
                    )
                );
            default:
                return [];
        }
    }

    /** @private lite endpoint first, html endpoint when it yields nothing. */
    async _duckduckgo(query, signal) {
        const q = encodeURIComponent(query);
        let results = [];
        try {
            results = WebSearch.parseDuckDuckGo(await this._get(`https://lite.duckduckgo.com/lite/?q=${q}&kl=wt-wt`, signal));
        } catch (err) {
            if (this.debug) this.log.debug?.(`[AlexaAI] duckduckgo lite failed: ${err.message}`);
        }
        if (!results.length) {
            results = WebSearch.parseDuckDuckGo(await this._get(`https://html.duckduckgo.com/html/?q=${q}&kl=wt-wt`, signal));
        }
        return results;
    }

    /** @private GET with a timeout; rejects on HTTP errors. */
    async _get(url, signal, headers = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);
        if (signal) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener?.('abort', () => controller.abort(), { once: true });
        }
        try {
            const response = await this._fetch(url, {
                method: 'GET',
                redirect: 'follow',
                signal: controller.signal,
                headers: {
                    'user-agent': this.userAgent,
                    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'accept-language': 'en-US,en;q=0.8',
                    ...headers,
                },
            });
            const body = await response.text();
            if (response.status > 299) throw new Error(`HTTP ${response.status}`);
            return body;
        } catch (err) {
            if (err.name === 'AbortError') throw new Error(`timed out after ${this.timeout}ms`);
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    // ------------------------------------------------------------ parsers --

    /** html.duckduckgo.com and lite.duckduckgo.com result pages. */
    static parseDuckDuckGo(html) {
        const page = String(html ?? '');
        const results = [];
        const seen = new Set();
        if (DDG_CHALLENGE.test(page)) return results;

        // html endpoint: <a class="result__a" href="…">Title</a> … <a class="result__snippet" …>snippet</a>
        // lite endpoint: <a rel="nofollow" href="…" class='result-link'>Title</a> … <td class='result-snippet'>snippet</td>
        const anchor = /<a\b[^>]*class=["'](?:result__a|result-link)["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>|<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'](?:result__a|result-link)["'][^>]*>([\s\S]*?)<\/a>/gi;
        const matches = [];
        let m;
        while ((m = anchor.exec(page))) {
            matches.push({ href: m[1] || m[3], title: m[2] || m[4], index: m.index, end: anchor.lastIndex });
        }

        matches.forEach((hit, i) => {
            const url = WebSearch.unwrapRedirect(hit.href);
            if (!url || WebSearch.isJunk(url)) return;
            const key = url.replace(/\/+$/, '').toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);

            // The snippet sits between this anchor and the next one.
            const segment = page.slice(hit.end, matches[i + 1] ? matches[i + 1].index : hit.end + 4000);
            const snippet =
                segment.match(/<a\b[^>]*class=["']result__snippet["'][^>]*>([\s\S]*?)<\/a>/i) ||
                segment.match(/<td\b[^>]*class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/i);

            results.push({
                title: WebSearch.text(hit.title) || null,
                url,
                description: snippet ? WebSearch.text(snippet[1]) || null : null,
                date: null,
                provider: 'duckduckgo',
            });
        });
        return results;
    }

    /** RSS 2.0 from Bing News / Google News. */
    static parseRss(xml, provider = 'rss') {
        const feed = String(xml ?? '');
        const results = [];
        const items = feed.match(/<item\b[\s\S]*?<\/item>/gi) || [];
        for (const item of items) {
            let url = WebSearch.tag(item, 'link') || (item.match(/<link\b[^>]*href=["']([^"']+)["']/i) || [])[1] || '';
            url = WebSearch.unwrapRedirect(WebSearch.decodeEntities(url).trim());
            if (!url || !/^https?:\/\//i.test(url) || WebSearch.isJunk(url)) continue;

            let title = WebSearch.text(WebSearch.tag(item, 'title'));
            const source = WebSearch.text(WebSearch.tag(item, 'source') || WebSearch.tag(item, 'News:Source'));
            // Google News: "Headline - Publisher"
            if (source && title && title.toLowerCase().endsWith(` - ${source.toLowerCase()}`)) {
                title = title.slice(0, -(source.length + 3)).trim();
            }
            let description = WebSearch.text(WebSearch.tag(item, 'description'));
            if (description && title && description.toLowerCase().startsWith(title.toLowerCase())) {
                // Google's description is the headline again plus the publisher.
                const rest = description.slice(title.length).replace(/^[\s\-–—|:]+/, '').trim();
                description = rest && rest.toLowerCase() !== (source || '').toLowerCase() ? rest : null;
            }
            if (source && !description) description = source;
            else if (source && description && !description.toLowerCase().includes(source.toLowerCase())) description = `${source}: ${description}`;

            results.push({
                title: title || null,
                url,
                description: description || null,
                date: WebSearch.isoDate(WebSearch.tag(item, 'pubDate')),
                provider,
            });
        }
        return results;
    }

    /** MediaWiki `list=search` JSON. */
    static parseWikipedia(json) {
        let data = json;
        if (typeof json === 'string') {
            try {
                data = JSON.parse(json);
            } catch {
                return [];
            }
        }
        const hits = data?.query?.search;
        if (!Array.isArray(hits)) return [];
        return hits
            .filter((h) => h && typeof h.title === 'string' && !/\(disambiguation\)$/i.test(h.title))
            .map((h) => ({
                title: `${h.title} - Wikipedia`,
                url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
                description: WebSearch.text(h.snippet) || null,
                date: WebSearch.isoDate(h.timestamp),
                provider: 'wikipedia',
            }));
    }

    // ------------------------------------------------------------ helpers --

    /** Round-robin across providers so news does not crowd out background, capped at `limit`. */
    static interleave(lists, limit) {
        const out = [];
        const seen = new Set();
        const queues = lists.map((l) => [...l]);
        while (out.length < limit && queues.some((q) => q.length)) {
            for (const q of queues) {
                while (q.length) {
                    const item = q.shift();
                    const key = WebSearch.urlKey(item.url);
                    const titleKey = item.title ? item.title.toLowerCase().replace(/\s+-\s+[^-]+$/, '').trim() : null;
                    if (seen.has(key) || (titleKey && seen.has(`t:${titleKey}`))) continue;
                    seen.add(key);
                    if (titleKey) seen.add(`t:${titleKey}`);
                    out.push(item);
                    break;
                }
                if (out.length >= limit) break;
            }
        }
        return out;
    }

    /** Accept caller-supplied results in loose shapes. */
    static normalise(list, provider = 'custom') {
        if (!Array.isArray(list)) return [];
        return list
            .map((r) => {
                if (typeof r === 'string') return { title: null, url: r, description: null, date: null, provider };
                if (!r || typeof r !== 'object') return null;
                const url = r.url || r.link || r.href;
                if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
                return {
                    title: r.title || r.name || null,
                    url,
                    description: r.description || r.snippet || r.content || r.summary || null,
                    date: WebSearch.isoDate(r.date || r.published || r.pubDate || r.publishedAt) || null,
                    provider: r.provider || provider,
                };
            })
            .filter(Boolean);
    }

    /** `//duckduckgo.com/l/?uddg=<url>` and `bing.com/news/apiclick.aspx?…&url=<url>` → the real URL. */
    static unwrapRedirect(href) {
        let url = String(href ?? '').trim();
        if (!url) return '';
        if (url.startsWith('//')) url = `https:${url}`;
        try {
            const u = new URL(url);
            if (/(?:^|\.)duckduckgo\.com$/i.test(u.hostname)) {
                const inner = u.searchParams.get('uddg') || u.searchParams.get('u3');
                if (inner) return WebSearch.unwrapRedirect(inner);
            }
            if (/(?:^|\.)bing\.com$/i.test(u.hostname)) {
                const inner = u.searchParams.get('url') || u.searchParams.get('r');
                if (inner) return WebSearch.unwrapRedirect(inner);
            }
            return u.href;
        } catch {
            return '';
        }
    }

    static isJunk(url) {
        try {
            return JUNK_HOST.test(new URL(url).hostname);
        } catch {
            return true;
        }
    }

    static urlKey(url) {
        return String(url ?? '')
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .replace(/[#?].*$/, '')
            .replace(/\/+$/, '');
    }

    /** First `<tag>…</tag>` in a block, CDATA unwrapped, raw. */
    static tag(block, name) {
        const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i');
        const m = String(block ?? '').match(re);
        if (!m) return '';
        return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
    }

    /** Entity-decode, strip tags, collapse whitespace. Handles double-encoded HTML in RSS descriptions. */
    static text(raw) {
        let s = WebSearch.decodeEntities(String(raw ?? ''));
        s = s.replace(/<[^>]+>/g, ' ');
        s = WebSearch.decodeEntities(s);
        return s.replace(/\s+/g, ' ').replace(/\s+([…,.;:!?])/g, '$1').trim();
    }

    static decodeEntities(s) {
        return String(s ?? '')
            .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
            .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
            .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
    }

    static isoDate(value) {
        if (!value) return null;
        const d = new Date(String(value).trim());
        return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }
}

module.exports = WebSearch;
