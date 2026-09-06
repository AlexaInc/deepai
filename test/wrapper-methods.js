'use strict';

/**
 * Every method the host bot's `src/modules/Aii.js` wrapper calls, exercised
 * against a MOCKED DeepAI transport (no network needed) — and against a real
 * PostgreSQL when POSTGRES_URL is set.
 *
 *   node test/wrapper-methods.js
 *   POSTGRES_URL=postgres://... node test/wrapper-methods.js
 *
 * The mock reproduces DeepAI's real behaviour on FREE keys:
 *   • /api/text2img answers {"status": "Out of API credits"} (HTTP 200)
 *   • the in-chat image tool answers a `generated_image` packet
 *   • /api/summarization is refused, so the chat fallback must kick in
 *   • the chat endpoint with search returns text + a trailing web-results packet
 */

const { AlexaAI, Media } = require('../index');
const { createFakeDb } = require('./fakes');

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, detail = '') {
    if (condition) {
        passed++;
        console.log(`  ✅ ${name}`);
    } else {
        failed++;
        failures.push(`${name} ${detail}`);
        console.log(`  ❌ ${name} ${detail}`);
    }
}
function check(name, actual, expected) {
    ok(name, JSON.stringify(actual) === JSON.stringify(expected), `\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
}
function section(title) {
    console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// 1x1 PNG so the mime sniffer has something real to look at.
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
);

/** DeepAI stand-in that behaves like the free tier. */
function installMockDeepAI(options = {}) {
    const calls = [];
    const realFetch = global.fetch;
    const FS = '\u001C';

    global.fetch = async (url, init = {}) => {
        const u = String(url);
        const fields = {};
        const files = {};
        if (init.body && typeof init.body.forEach === 'function') {
            init.body.forEach((value, key) => {
                if (typeof value === 'string') fields[key] = value;
                else files[key] = { type: value.type, size: value.size, name: value.name };
            });
        }
        calls.push({ url: u, method: init.method || 'GET', fields, files, headers: init.headers || {} });

        const respond = (body, status = 200, type = 'text/plain') => ({
            status,
            headers: { get: () => type },
            text: async () => body,
            body: null,
        });

        if (u.includes('/api/text2img')) {
            if (options.paidText2img) {
                return respond(JSON.stringify({ id: 'img-1', output_url: 'https://api.deepai.org/job-view-file/img-1/outputs/output.jpg' }), 200, 'application/json');
            }
            return respond(JSON.stringify({ status: 'Out of API credits - please top up your account' }), 200, 'application/json');
        }
        if (u.includes('/api/summarization')) {
            return respond(JSON.stringify({ status: 'Out of API credits' }), 200, 'application/json');
        }
        if (u.includes('/api/torch-srgan') || u.includes('/api/image-editor') || u.includes('/api/colorizer')) {
            return respond(JSON.stringify({ id: 'job-2', output_url: 'https://api.deepai.org/job-view-file/job-2/outputs/output.jpg' }), 200, 'application/json');
        }
        if (u.includes('/api/nsfw-detector')) {
            return respond(JSON.stringify({ id: 'job-3', output: { nsfw_score: 0.03 } }), 200, 'application/json');
        }
        if (u.includes('/chat_attachments/upload')) {
            return respond(JSON.stringify({ success: true, attachment: { uuid: 'att-1', extraction_status: 'skipped' } }), 200, 'application/json');
        }
        if (u.includes('/chat_attachments/get')) {
            return respond(JSON.stringify({ success: true, attachment: { uuid: 'att-1', extraction_status: 'skipped' } }), 200, 'application/json');
        }
        if (u.includes('ocr.space')) {
            return { status: 200, headers: { get: () => 'application/json' }, json: async () => ({ IsErroredOnProcessing: false, ParsedResults: [{ ParsedText: 'Invoice total: Rs 4,500' }] }), text: async () => '' };
        }
        // ---- engine web search providers ---------------------------------
        if (u.includes('duckduckgo.com') || u.includes('bing.com/') || u.includes('news.google.com') || u.includes('wikipedia.org')) {
            if (options.searchDown) return respond('', 503, 'text/html');
            if (options.searchEmpty) return respond('<html><body>No results.</body></html>', 200, 'text/html');
            if (u.includes('bing.com/search?')) {
                // live shape 2026-09-06: plain RSS, direct links, pubDate
                return respond(
                    '<rss><channel><title>Bing: coffee</title><item><title>Coffee | Origin, Types, Uses, History, &amp; Facts | Britannica</title><link>https://www.britannica.com/topic/coffee</link>' +
                        '<description>Coffee, beverage brewed from the roasted and ground seeds of the tropical evergreen coffee plant.</description><pubDate>Fri, 04 Sep 2026 06:02:00 GMT</pubDate></item>' +
                        '<item><title>Bing videos</title><link>https://www.bing.com/videos/search?q=coffee</link></item></channel></rss>',
                    200,
                    'application/xml'
                );
            }
            if (u.includes('html.duckduckgo.com')) {
                if (options.ddgHtmlChallenge) return respond('<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></body></html>', 200, 'text/html');
                return respond(
                    '<div class="result"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.reuters.com%2Fmarkets%2Fcommodities%2Fcoffee-2026&amp;rut=1">Coffee prices hit record &amp; keep <b>climbing</b></a></h2>' +
                        '<a class="result__snippet" href="#">Arabica futures rose <b>12%</b> in August after frost in Brazil&hellip;</a></div>' +
                        '<div class="result"><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_provider=bing&u3=https%3A%2F%2Fwww.bing.com%2Faclick">Ad: Buy coffee</a></h2></div>' +
                        '<div class="result"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.ncausa.org%2F">National Coffee Association</a></h2>' +
                        '<a class="result__snippet" href="#">The NCA is the leading trade group for the US coffee industry.</a></div>',
                    200,
                    'text/html'
                );
            }
            if (u.includes('lite.duckduckgo.com')) {
                if (options.ddgLiteResults) {
                    return respond(
                        "<tr><td valign=\"top\">1.&nbsp;</td><td><a rel=\"nofollow\" href=\"//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.ncausa.org%2F&amp;rut=x\" class='result-link'>National Coffee Association</a></td></tr>" +
                            "<tr><td>&nbsp;&nbsp;&nbsp;</td><td class='result-snippet'>The NCA is the leading trade group for the US coffee industry.</td></tr>",
                        200,
                        'text/html'
                    );
                }
                return respond('<html></html>', 200, 'text/html');
            }
            if (u.includes('bing.com/news')) {
                return respond(
                    '<?xml version="1.0"?><rss><channel><item><title>Starbucks trims menu &amp; adds cold brew</title>' +
                        '<link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fwww.cnbc.com%2f2026%2f08%2f20%2fstarbucks-menu.html&amp;c=1</link>' +
                        '<pubDate>Wed, 20 Aug 2026 14:02:00 GMT</pubDate><description>Starbucks removed 30% of its drinks to speed up service.</description>' +
                        '<News:Source xmlns:News="https://www.bing.com:443/news/search?q=coffee&amp;format=rss">CNBC</News:Source></item></channel></rss>',
                    200,
                    'application/xml'
                );
            }
            if (u.includes('news.google.com')) {
                return respond(
                    '<rss><channel><item><title><![CDATA[Sri Lanka coffee exports rise 18% - Daily Mirror]]></title>' +
                        '<link>https://news.google.com/rss/articles/CBMiXGh0dHBz?oc=5</link><pubDate>Thu, 04 Sep 2026 09:00:00 GMT</pubDate>' +
                        '<description><![CDATA[<a href="https://news.google.com/rss/articles/CBMi?oc=5">Sri Lanka coffee exports rise 18%</a>&nbsp;&nbsp;<font color="#6f6f6f">Daily Mirror</font>]]></description>' +
                        '<source url="https://www.dailymirror.lk">Daily Mirror</source></item></channel></rss>',
                    200,
                    'application/xml'
                );
            }
            if (u.includes('wikipedia.org')) {
                return respond(
                    JSON.stringify({ query: { search: [{ title: 'Coffee', snippet: '<span class="searchmatch">Coffee</span> is a beverage brewed from roasted coffee beans.', timestamp: '2026-08-30T10:00:00Z' }] } }),
                    200,
                    'application/json'
                );
            }
        }

        if (u.includes('/hacking_is_a_serious_crime')) {
            const history = JSON.parse(fields.chatHistory || '[]');
            const last = history[history.length - 1]?.content || '';

            // Grounded research: the prompt carries numbered search results.
            if (last.includes('Search results:\n[1]') || last.includes('built from the search results above')) {
                if (options.groundedReply) return respond(typeof options.groundedReply === 'function' ? options.groundedReply(last) : options.groundedReply);
                return respond(
                    'Coffee is having a turbulent 2026, with record prices and big menu changes at the largest chains [1][2].\n\n' +
                        '**Recent Coffee News:**\n' +
                        '1. **Prices at a record**: Arabica futures rose 12% in August after frost damaged crops in Brazil [5]. Traders expect the squeeze to last into 2027.\n' +
                        '2. **Starbucks trims its menu**: The chain removed 30% of its drinks to speed up service, keeping cold brew [2]. Analysts see it as a bet on fewer, faster orders.\n' +
                        '3. **Sri Lanka exports up**: Coffee exports rose 18% year on year, according to the Daily Mirror [4]. Kandy estates lead the growth.\n\n' +
                        '**Coffee Background:**\n' +
                        '1. **What it is**: Coffee is a beverage brewed from roasted coffee beans [3]. It is one of the most traded commodities in the world.\n' +
                        '2. **Industry body**: Britannica calls coffee one of the three most popular beverages in the world [1]. It publishes yearly consumption trends.\n\n' +
                        'Sources:\n- Made Up Times (https://www.made-up-times.example/coffee)\n'
                );
            }

            // In-chat image tool: the browser's generate_image function call.
            if (last.includes('"function_call"') && last.includes('generate_image')) {
                return respond(`Here is your image!${FS}${JSON.stringify({ type: 'generated_image', share_url: 'https://deepai.org/generated/abc123.png' })}`);
            }
            if (fields.search === 'search' || fields.web_access_enabled === 'true') {
                if (options.webReply) return respond(typeof options.webReply === 'function' ? options.webReply(last) : options.webReply);
                if (last.includes('Topic: coffee\n') || last.includes('topic "coffee":')) {
                    // gpt-4o-mini, first attempt — the exact live reply that
                    // prompted this fix: one sentence, links as prose, no packet.
                    if (last.includes('Topic: coffee\n')) {
                        return respond(
                            'Coffee is a popular beverage made from the roasted seeds of the coffee plant, providing a stimulating effect due to its caffeine content.\n\n' +
                            'Sources:\n\n' +
                            'Coffee Association (https://www.coffeeassociation.org/)\n' +
                            'National Coffee Association (https://www.ncausa.org/)\n' +
                            'Wikipedia - Coffee (https://en.wikipedia.org/wiki/Coffee)'
                        );
                    }
                    // …and the expansion turn, which follows the layout.
                    return respond(
                        "I'm a large language model, I don't have the ability to browse the web. However, here is an overview.\n\n" +
                        'Coffee remains one of the most traded commodities in the world, and 2026 has brought record prices.\n\n' +
                        '**Recent Coffee News:**\n' +
                        '1. **Arabica futures hit a high**: Prices rose 12% in August after frost damaged crops in Brazil. Traders expect the squeeze to last into 2027.\n' +
                        '2. **Starbucks menu shake-up**: The chain removed 30% of its drinks to speed up service. Cold brew and nitro cold brew stay on the menu.\n' +
                        '3. **Sri Lanka exports grow**: Specialty coffee exports rose 18% year on year. Kandy and Nuwara Eliya estates lead the growth.\n' +
                        '4. **Coffee machine market**: Home espresso machine sales grew 9%, driven by compact bean-to-cup models.\n\n' +
                        '**Coffee Trends:**\n' +
                        '1. **Cold brew keeps growing**: Ready-to-drink sales are up 20%. Supermarkets now stock more cold brew than iced coffee.\n' +
                        '2. **Home roasting**: Small roasters sold out of green beans twice this summer. Online courses on roasting doubled.\n' +
                        '3. **Sustainability labels**: Deforestation-free certification is now demanded by EU importers. Exporters must show farm-level traceability.\n' +
                        '4. **Coffee and health**: New studies link two to three cups a day with lower heart-disease risk. Researchers caution against added sugar.\n\n' +
                        '**Other Coffee News:**\n' +
                        '1. **Subscription services**: Bean subscriptions grew 15% as commuters returned to offices. Bundles with grinders are the fastest sellers.\n' +
                        '2. **New roasters open**: Colombo gained six specialty cafés this year. Most roast on site and publish origin details.\n' +
                        '3. **Coffee desserts**: Tiramisu and affogato lead café dessert menus. Chains are adding coffee-flavoured ice cream for the season.\n\n' +
                        '*<Section heading 4>:*\n1. *<Headline>*: <…>\n\n' +
                        'Please note that the information I provided is based on my training data and may not reflect the most up-to-date news and trends.\n\n' +
                        'Sources:\n\n' +
                        'Reuters – Coffee prices (https://www.reuters.com/markets/commodities/coffee-2026)\n' +
                        'National Coffee Association (https://www.ncausa.org/)\n' +
                        'Wikipedia - Coffee (https://en.wikipedia.org/wiki/Coffee)\n' +
                        '<Page title> (<url>)'
                    );
                }
                const results = [
                    { title: 'Central Bank of Sri Lanka', url: 'https://www.cbsl.gov.lk', description: 'Exchange rates' },
                    { title: 'XE', url: 'https://www.xe.com/currencyconverter/', description: 'LKR to USD' },
                ];
                return respond(
                    `${FS}{"tool_activity":"Searching the web…"}${FS}Today **1 USD ≈ 300 LKR** according to the Central Bank.\n\n` +
                    `**Key Facts:**\n1. **Official rate**: 300.10 LKR.\n2. **Trend**: the rupee gained 2% this month.\n\n` +
                    `Sources:\n- XE (https://www.xe.com/currencyconverter/)\n- Reuters (https://www.reuters.com/lkr)${FS}${JSON.stringify(results)}`
                );
            }
            if (last.includes('Summarise the following text')) {
                return respond('• Alexa is a WhatsApp assistant\n• She remembers people across chats');
            }
            if (fields.attachment_uuids) {
                return respond("I'm sorry, I can't see images.");
            }
            if (last.includes('Reply with the single word')) return respond('ok');
            return respond('Hello from Alexa!');
        }
        return respond(JSON.stringify({ success: true }), 200, 'application/json');
    };

    return { calls, restore: () => { global.fetch = realFetch; } };
}

async function mockedTests() {
    section('Media — every input shape becomes { buffer | url }');
    {
        const fromBuffer = Media.normalize(PNG);
        check('bare Buffer -> sniffed mimetype', fromBuffer.mimetype, 'image/png');
        check('bare Buffer -> default filename', fromBuffer.filename, 'image.png');
        check('Uint8Array is accepted', Media.normalize(new Uint8Array(PNG)).mimetype, 'image/png');
        check('ArrayBuffer is accepted', Boolean(Media.normalize(PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length))), true);
        const uri = Media.normalize(`data:image/png;base64,${PNG.toString('base64')}`);
        check('data URI -> bytes', uri.buffer.equals(PNG), true);
        check('data URI -> mimetype', uri.mimetype, 'image/png');
        check('raw base64 string -> bytes', Media.normalize(PNG.toString('base64')).buffer.equals(PNG), true);
        check('URL string -> { url }', Media.normalize('https://example.com/a.jpg'), { url: 'https://example.com/a.jpg' });
        check('{ url }', Media.normalize({ url: 'https://example.com/a.jpg' }).url, 'https://example.com/a.jpg');
        check('{ base64 } (whatsapp-web.js MessageMedia)', Media.normalize({ base64: PNG.toString('base64'), mimetype: 'image/png' }).buffer.equals(PNG), true);
        check('{ data } (whatsapp-web.js MessageMedia)', Media.normalize({ data: PNG.toString('base64'), mimetype: 'image/png' }).filename, 'image.png');
        check('{ buffer } keeps caller filename', Media.normalize({ buffer: PNG, filename: 'shot.png' }).filename, 'shot.png');
        check('wrong label is corrected from the bytes', Media.normalize({ buffer: PNG, mimetype: 'image/jpeg' }).mimetype, 'image/png');
        check('plain sentence is NOT an image', Media.normalize('hello there how are you doing today my friend'), null);
        check('empty input', Media.normalize(''), null);
        check('null input', Media.normalize(null), null);
        check('document detection by mimetype', Media.isDocument({ mimetype: 'application/pdf' }), true);
        check('document detection by name', Media.isDocument({ filename: 'notes.txt' }), true);
        check('image is not a document', Media.isDocument({ mimetype: 'image/png', filename: 'a.pdf' }), false);
        check('toApiField(url) is a string', Media.toApiField('https://x.y/z.png'), 'https://x.y/z.png');
        check('toApiField(buffer) keeps mimetype', Media.toApiField(PNG).mimetype, 'image/png');
    }

    section('Engine surface — the methods the bot wrapper calls exist');
    {
        const required = [
            'chat', 'ask', 'init', 'close', 'health', 'deepaiHealth', 'stats',
            'forgetAll', 'getMemories', 'remember', 'forget', 'clearHistory',
            'blockUser', 'unblockUser', 'isBlocked', 'setGroupEnabled', 'isGroupEnabled', 'getProfile',
            'linkIdentity', 'getAliases', 'whoIs', 'mergeUsers',
            'generateImage', 'editImage', 'upscaleImage', 'colorizeImage', 'detectNsfw',
            'describeImage', 'summarizeText', 'searchWeb',
        ];
        const ai = new AlexaAI({ key: 'tryit-1-x', postgresUrl: 'postgres://u:p@localhost/db', autoMigrate: false });
        const missing = required.filter((m) => typeof ai[m] !== 'function');
        check('no wrapper method is missing', missing, []);
        ok('AlexaAI.methods() lists them all', required.every((m) => AlexaAI.methods().includes(m)));
        ok('AlexaAI.version is exposed', /^\d+\.\d+\.\d+/.test(AlexaAI.version));
        check('instance.version matches', ai.version, AlexaAI.version);
    }

    section('generateImage() — free key: /api/text2img refused, chat tool succeeds');
    {
        const ai = new AlexaAI({ key: 'tryit-1-x', postgresUrl: 'postgres://u:p@localhost/db', autoMigrate: false, maxRetries: 0 });
        const mock = installMockDeepAI();
        try {
            const r = await ai.generateImage('a red tuk-tuk in Galle at sunset');
            check('ok', r.ok, true);
            check('url comes from the chat image tool', r.url, 'https://deepai.org/generated/abc123.png');
            check('route reported', r.via, 'chat');
            const api = mock.calls.find((c) => c.url.includes('/api/text2img'));
            ok('/api/text2img was tried first', Boolean(api));
            check('/api/text2img got the prompt', api.fields.text, 'a red tuk-tuk in Galle at sunset');
            const tool = mock.calls.find((c) => c.url.includes('hacking_is_a_serious_crime'));
            ok('chat tool was used as fallback', Boolean(tool));
            const payload = JSON.parse(JSON.parse(tool.fields.chatHistory)[0].content);
            check('function_call name', payload.function_call.name, 'generate_image');
            check('function_call prompt', JSON.parse(payload.function_call.arguments).prompt, 'a red tuk-tuk in Galle at sunset');
            check('image_generation flag sent', tool.fields.image_generation, 'true');

            const empty = await ai.generateImage('   ');
            check('empty prompt is rejected, not thrown', empty.error, 'VALIDATION_ERROR');

            const apiOnly = await ai.generateImage('x', { apiOnly: true });
            check('apiOnly on a free key reports quota', apiOnly.error, 'DEEPAI_QUOTA_EXCEEDED');
            ok('apiOnly failure carries a message', /credits/i.test(apiOnly.message));
        } finally {
            mock.restore();
        }
    }

    section('generateImage() — paid key: /api/text2img answers directly');
    {
        const ai = new AlexaAI({ key: 'paid-key', postgresUrl: 'postgres://u:p@localhost/db', autoMigrate: false, maxRetries: 0 });
        const mock = installMockDeepAI({ paidText2img: true });
        try {
            const r = await ai.generateImage('a cat', { width: 512, height: 512 });
            check('ok', r.ok, true);
            check('route', r.via, 'api');
            ok('url from /api/text2img', r.url.includes('job-view-file'));
            check('extra fields forwarded', mock.calls[0].fields.width, '512');
            check('no chat call was needed', mock.calls.filter((c) => c.url.includes('hacking')).length, 0);
        } finally {
            mock.restore();
        }
    }

    section('searchWeb() — web access flags, clean text, sources');
    {
        const ai = new AlexaAI({ key: 'tryit-1-x', postgresUrl: 'postgres://u:p@localhost/db', autoMigrate: false, maxRetries: 0 });
        const mock = installMockDeepAI();
        try {
            const r = await ai.searchWeb('LKR to USD today', { search: false });
            check('ok', r.ok, true);
            check('search:false -> DeepAI web access path', r.grounded, false);
            ok('answer text present', r.text.includes('1 USD'));
            ok('markdown ** converted to WhatsApp *', !r.text.includes('**') && r.text.includes('*1 USD ≈ 300 LKR*'));
            ok('no control characters leak', !/[\u001C\u001D\u001E]/.test(r.text));
            ok('tool activity packet stripped', !r.text.includes('Searching the web'));
            check(
                'packet sources first, then the ones the model listed, de-duplicated by URL',
                r.sources.map((s) => s.url),
                ['https://www.cbsl.gov.lk', 'https://www.xe.com/currencyconverter/', 'https://www.reuters.com/lkr']
            );
            check('packet description kept', r.sources[0].description, 'Exchange rates');
            check('one Sources block in the text', (r.text.match(/Sources:/g) || []).length, 1);
            ok('sources block is WhatsApp formatted', r.text.includes('*Sources:*\n1. Central Bank of Sri Lanka — https://www.cbsl.gov.lk'));
            ok('answer excludes the sources block', !r.answer.includes('Sources') && r.answer.includes('*Key Facts:*'));
            const call = mock.calls.find((c) => c.url.includes('hacking'));
            check('web_access_enabled sent', call.fields.web_access_enabled, 'true');
            check('search flag sent', call.fields.search, 'search');
            check('online flag sent', call.fields.online, 'online');
            const history = JSON.parse(call.fields.chatHistory);
            const prompt = history[history.length - 1].content;
            ok('query is in the prompt', prompt.includes('Topic: LKR to USD today'));
            ok('prompt asks for a long, sectioned answer', /3 to 5 sections/.test(prompt) && /300 to 450 words/.test(prompt));
            ok('prompt shows the layout template', prompt.includes('*<Section heading 1>:*') && prompt.includes('1. *<Headline>*:'));
            ok('prompt forbids the browse / training-data notes', /unable to browse the web/.test(prompt) && /training data/.test(prompt));
            check('short packet reply triggers one expansion attempt', r.attempts, 2);
            const lkrCalls = mock.calls.filter((c) => c.url.includes('hacking'));
            check('…so two chat requests were made', lkrCalls.length, 2);
            ok('persona still applied', history.some((m) => m.content.includes('Alexa')));

            const empty = await ai.searchWeb('');
            check('empty query rejected, not thrown', empty.error, 'VALIDATION_ERROR');
        } finally {
            mock.restore();
        }
    }

    section('searchWeb() — grounded: the engine searches, the model writes, sources come from the search');
    {
        const ai = new AlexaAI({ key: 'tryit-1-x', postgresUrl: 'postgres://u:p@localhost/db', autoMigrate: false, maxRetries: 0 });
        let mock = installMockDeepAI();
        try {
            const r = await ai.searchWeb('coffee', { minWords: 100 });
            check('ok', r.ok, true);
            check('grounded', r.grounded, true);
            check('via model', r.via, 'model');
            check('providers that answered', r.providers, ['bing', 'bing-news', 'wikipedia', 'google-news', 'duckduckgo']);
            const searchCalls = mock.calls.filter((c) => /duckduckgo|bing\.com|news\.google|wikipedia/.test(c.url));
            ok('all providers queried in parallel before the model', searchCalls.length >= 5);
            ok('ddg: lite first, html only as fallback', mock.calls.findIndex((c) => c.url.includes('lite.duckduckgo')) < mock.calls.findIndex((c) => c.url.includes('html.duckduckgo')));
            const chat = mock.calls.filter((c) => c.url.includes('hacking'));
            check('one model call (reply was long enough)', chat.length, 1);
            check('DeepAI web access NOT requested when grounded', chat[0].fields.web_access_enabled, 'false');
            ok('search flag not sent when grounded', !chat[0].fields.search);
            const prompt = JSON.parse(chat[0].fields.chatHistory).pop().content;
            ok('prompt carries numbered results', prompt.includes('[1] Coffee | Origin, Types, Uses, History, & Facts | Britannica') && prompt.includes('reuters.com'));
            ok('bing.com video/junk link filtered', !prompt.includes('bing.com/videos'));
            ok('prompt carries snippets', prompt.includes('Arabica futures rose 12% in August'));
            ok('prompt forbids URLs from the model', prompt.includes('Never write a URL'));
            ok('ad result filtered out', !prompt.includes('Buy coffee'));

            ok('citation markers removed from the text', !/\[\d\]/.test(r.text));
            ok('prose intact', r.text.includes('1. *Prices at a record*: Arabica futures rose 12% in August after frost damaged crops in Brazil. Traders expect'));
            ok("model's invented source discarded", !r.text.includes('made-up-times') && !r.sources.some((s) => /made-up/.test(s.url)));
            // interleaved order: [1] bing/britannica, [2] bing-news/cnbc, [3] wikipedia, [4] gnews, [5] ddg/reuters, [6] ddg/ncausa
            // the mock reply cites [1][2] in the intro, then [5], [2], [4], [3] -> order 1, 2, 5, 4, 3, uncited 6 last
            check(
                'sources = search results, cited first in citation order',
                r.sources.map((s) => s.url),
                [
                    'https://www.britannica.com/topic/coffee',
                    'https://www.cnbc.com/2026/08/20/starbucks-menu.html',
                    'https://www.reuters.com/markets/commodities/coffee-2026',
                    'https://news.google.com/rss/articles/CBMiXGh0dHBz?oc=5',
                    'https://en.wikipedia.org/wiki/Coffee',
                    'https://www.ncausa.org/',
                ]
            );
            check('cited flags', r.sources.map((s) => s.cited), [true, true, true, true, true, false]);
            check('dates carried', r.sources[1].date, '2026-08-20');
            ok('sources block rendered once', (r.text.match(/\*Sources:\*/g) || []).length === 1);
            ok('sources block lists real titles', r.text.includes('1. Coffee | Origin, Types, Uses, History, & Facts | Britannica — https://www.britannica.com/topic/coffee'));
            ok('maxSources default 5 caps the block, array keeps all 6', !r.text.includes('ncausa.org') && r.sources.length === 6);
            ok('no ** markdown', !r.text.includes('**'));

            // caller-supplied results skip the built-in search
            mock.calls.length = 0;
            const own = await ai.searchWeb('coffee', { results: [{ title: 'My API result', url: 'https://api.example/1', snippet: 'from my search api', publishedAt: '2026-09-05' }] });
            check('caller results -> grounded', own.grounded, true);
            check('caller results -> provider tag', own.providers, ['caller']);
            check('built-in search skipped', mock.calls.filter((c) => /duckduckgo|bing\.com|news\.google|wikipedia/.test(c.url)).length, 0);
            check('caller result is the source', own.sources.map((s) => s.url), ['https://api.example/1']);

            // provider subset
            mock.calls.length = 0;
            await ai.searchWeb('coffee', { providers: ['wikipedia'] });
            check('providers option limits the search', mock.calls.filter((c) => /duckduckgo|bing\.com|news\.google/.test(c.url)).length, 0);
        } finally {
            mock.restore();
        }

        // DuckDuckGo bot challenge on html, results on lite
        mock = installMockDeepAI({ ddgHtmlChallenge: true, ddgLiteResults: true });
        try {
            const r = await ai.searchWeb('coffee', { providers: ['duckduckgo'], minWords: 0 });
            check('ddg lite results used', r.providers, ['duckduckgo']);
            ok('lite result is a source', r.sources.some((s) => s.url === 'https://www.ncausa.org/'));
            check('html endpoint not needed when lite answered', mock.calls.filter((c) => c.url.includes('html.duckduckgo')).length, 0);
        } finally {
            mock.restore();
        }
        mock = installMockDeepAI({ ddgHtmlChallenge: true });
        try {
            const r = await ai.searchWeb('coffee', { providers: ['duckduckgo'] });
            check('ddg challenge page -> no results, not grounded', r.grounded, false);
        } finally {
            mock.restore();
        }
    }

    section('searchWeb() — grounded fallbacks');
    {
        const ai = new AlexaAI({ key: 'tryit-1-x', postgresUrl: 'postgres://u:p@localhost/db', autoMigrate: false, maxRetries: 0 });

        let mock = installMockDeepAI({ searchDown: true });
        try {
            const r = await ai.searchWeb('coffee');
            check('all providers down -> DeepAI web access fallback', r.grounded, false);
            const chat = mock.calls.filter((c) => c.url.includes('hacking'));
            check('fallback requests DeepAI web access', chat[0].fields.web_access_enabled, 'true');
            check('fallback still answers', r.ok, true);
        } finally {
            mock.restore();
        }

        mock = installMockDeepAI({ searchEmpty: true });
        try {
            const r = await ai.searchWeb('coffee');
            check('empty pages -> not grounded', r.grounded, false);
            check('no providers reported', r.providers, []);
        } finally {
            mock.restore();
        }

        const FS = '\u001C';
        mock = installMockDeepAI({ groundedReply: `${FS}{"status":"Out of API credits"}${FS}` });
        try {
            const r = await ai.searchWeb('coffee');
            check('model down but search worked -> digest of the results', r.via, 'digest');
            check('still ok', r.ok, true);
            ok('digest lists the results', r.text.startsWith('Here is what I found:') && r.text.includes('*Coffee prices hit record & keep climbing*') && r.text.includes('*Coffee | Origin, Types'));
            ok('sources attached', r.sources.length === 6 && r.text.includes('*Sources:*'));
            ok('error carried for logging', typeof r.error === 'string');
        } finally {
            mock.restore();
        }

        let calls = 0;
        mock = installMockDeepAI({
            groundedReply: () => (++calls === 1 ? 'Coffee is a popular drink [5].' : 'Coffee is having a big year [1].\n\n*Recent News:*\n1. *Prices*: Arabica rose 12% after frost in Brazil [1]. Traders expect more.\n2. *Menu*: Starbucks cut 30% of drinks [2]. Cold brew stays.\n3. *Exports*: Sri Lanka up 18% [4]. Kandy leads.\n\n*Background:*\n1. *Definition*: Brewed from roasted beans [5]. Traded worldwide.\n2. *Trade body*: The NCA leads the US industry [3]. Publishes trends.'),
        });
        try {
            const r = await ai.searchWeb('coffee', { minWords: 40 });
            check('short grounded reply is retried', r.attempts, 2);
            const retry = JSON.parse(mock.calls.filter((c) => c.url.includes('hacking'))[1].fields.chatHistory).pop().content;
            ok('grounded retry prompt forbids URLs', retry.includes('Do not write URLs or a Sources list'));
            ok('longer reply won', r.words > 40);
            check('cited order follows the winning reply', r.sources.slice(0, 2).map((s) => s.cited), [true, true]);
        } finally {
            mock.restore();
        }
    }

    section('WebSearch — parsers for the free endpoints');
    {
        const { WebSearch } = require('../index');
        const ddg = WebSearch.parseDuckDuckGo(
            '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa&amp;rut=1">Title &amp; more</a><a class="result__snippet" href="#">Snip <b>bold</b>&hellip;</a>' +
                '<a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?u3=https%3A%2F%2Fwww.bing.com%2Faclick">Ad</a>' +
                '<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa%2F" class=\'result-link\'>dup</a>'
        );
        check('ddg: redirect unwrapped, entities decoded, ads and duplicates dropped', ddg, [
            { title: 'Title & more', url: 'https://example.org/a', description: 'Snip bold…', date: null, provider: 'duckduckgo' },
        ]);
        const rss = WebSearch.parseRss('<rss><item><title><![CDATA[Headline - Pub]]></title><link>https://x.y/z</link><pubDate>Thu, 04 Sep 2026 09:00:00 GMT</pubDate><source url="https://pub">Pub</source></item><item><title>no link</title></item></rss>', 'google-news');
        check('rss: publisher suffix stripped, date normalised, linkless item skipped', rss, [
            { title: 'Headline', url: 'https://x.y/z', description: 'Pub', date: '2026-09-04', provider: 'google-news' },
        ]);
        check('wikipedia: bad json -> []', WebSearch.parseWikipedia('nope'), []);
        check('unwrapRedirect: bing apiclick', WebSearch.unwrapRedirect('http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fcnbc.com%2fa&c=1'), 'https://cnbc.com/a');
        check('unwrapRedirect: plain url untouched', WebSearch.unwrapRedirect('https://a.b/c?d=1'), 'https://a.b/c?d=1');
        check('interleave: round robin + de-dup', WebSearch.interleave([[{ url: 'https://a/1', title: 'A1' }, { url: 'https://a/2', title: 'A2' }], [{ url: 'https://A/1/', title: 'dup' }, { url: 'https://b/1', title: 'B1' }]], 3).map((r) => r.title), ['A1', 'B1', 'A2']);
        check('normalise: strings and loose objects', WebSearch.normalise(['https://x.y', { link: 'https://p.q', name: 'P' }, { title: 'no url' }]).map((r) => r.url), ['https://x.y', 'https://p.q']);

        const custom = new WebSearch({ webSearchProvider: async (q) => [{ title: `Result for ${q}`, url: 'https://custom.example/r' }] });
        const viaCustom = await custom.search('coffee');
        check('custom provider replaces the built-ins', viaCustom.providers, ['custom']);
        check('custom provider results normalised', viaCustom.results[0].title, 'Result for coffee');
        const disabled = new WebSearch({ webSearch: false });
        check('webSearch:false -> no results, no requests', await disabled.search('coffee'), { results: [], providers: [], errors: [] });
        const failing = new WebSearch({ webSearchProvider: async () => { throw new Error('boom'); } });
        check('custom provider failure is reported, not thrown', (await failing.search('x')).errors, [{ provider: 'custom', message: 'boom' }]);
    }

    section('searchWeb() — gpt-4o-mini answers in one sentence: retried, sources lifted out of prose');
    {
        const ai = new AlexaAI({ key: 'tryit-1-x', postgresUrl: 'postgres://u:p@localhost/db', autoMigrate: false, maxRetries: 0 });
        const mock = installMockDeepAI();
        try {
            const r = await ai.searchWeb('coffee', { search: false });
            check('ok', r.ok, true);
            check('two attempts were made', r.attempts, 2);
            const chatCalls = mock.calls.filter((c) => c.url.includes('hacking'));
            check('exactly two chat requests', chatCalls.length, 2);
            const retry = JSON.parse(chatCalls[1].fields.chatHistory);
            ok('retry keeps the first reply in the transcript', retry.some((m) => m.role === 'assistant' && m.content.startsWith('Coffee is a popular beverage')));
            ok('retry asks for the full layout', /Your reply was only \d+ words/.test(retry[retry.length - 1].content));
            ok('retry still has web access on', chatCalls[1].fields.web_access_enabled === 'true' && chatCalls[1].fields.search === 'search');

            ok('long-form answer won', r.words > 200, `words=${r.words}`);
            ok('word count excludes markers, markup and urls', r.words < 300, `words=${r.words}`);
            ok('section headings preserved as WhatsApp bold', r.text.includes('*Recent Coffee News:*') && r.text.includes('*Coffee Trends:*') && r.text.includes('*Other Coffee News:*'));
            ok('numbered points preserved', r.text.includes('1. *Arabica futures hit a high*:') && r.text.includes('3. *Coffee desserts*:'));
            ok('no ** markdown', !r.text.includes('**'));
            ok('"large language model" disclaimer removed', !/language model|browse the web/i.test(r.text));
            ok('"based on my training data" note removed', !/training data/i.test(r.text));
            ok('unused template placeholders removed', !r.text.includes('<') && !/Section heading 4/.test(r.text));
            ok('reply starts with the real intro', r.text.startsWith('Here is an overview.\n\nCoffee remains'));
            check(
                'sources: first attempt + retry, de-duplicated by URL',
                r.sources.map((s) => s.title),
                ['Reuters – Coffee prices', 'National Coffee Association', 'Wikipedia - Coffee', 'Coffee Association']
            );
            check('urls parsed', r.sources[2].url, 'https://en.wikipedia.org/wiki/Coffee');
            check('sources rendered once', (r.text.match(/Sources:/g) || []).length, 1);
            ok('sources block at the end', r.text.endsWith('4. Coffee Association — https://www.coffeeassociation.org/'));
            ok('no "title (url)" list left in the answer', !r.answer.includes('(https://'));

            const bare = await ai.searchWeb('coffee', { includeSources: false, search: false });
            ok('includeSources:false drops the block from text', !bare.text.includes('Sources') && bare.sources.length === 4);
            const capped = await ai.searchWeb('coffee', { maxSources: 1, search: false });
            ok('maxSources caps the rendered list only', capped.text.includes('1. Reuters') && !capped.text.includes('2. National') && capped.sources.length === 4);

            const noRetry = await ai.searchWeb('coffee', { minWords: 0, search: false });
            check('minWords: 0 disables the retry', noRetry.attempts, 1);
            ok('…and the short reply is returned as-is, sources still lifted', noRetry.text.startsWith('Coffee is a popular beverage') && noRetry.sources.length === 3);

            const short = await ai.searchWeb('coffee', { detail: 'short', language: 'Sinhala', instructions: 'focus on Sri Lanka', search: false });
            const prompt = JSON.parse(mock.calls.filter((c) => c.url.includes('hacking')).pop().fields.chatHistory).pop().content;
            ok('short mode asks for 2–4 sentences', /2 to 4 sentences/.test(prompt) && !/3 to 5 sections/.test(prompt));
            ok('language forwarded', prompt.includes('Write the entire answer in Sinhala.'));
            ok('instructions forwarded', prompt.includes('focus on Sri Lanka'));
            check('short mode never retries', short.attempts, 1);
            check('short mode still ok', short.ok, true);
        } finally {
            mock.restore();
        }
    }

    section('searchWeb() — edge replies');
    {
        const ai = new AlexaAI({ key: 'tryit-1-x', postgresUrl: 'postgres://u:p@localhost/db', autoMigrate: false, maxRetries: 0 });
        const FS = '\u001C';

        let mock = installMockDeepAI({ webReply: `Nothing to say.${FS}[{"title":"Only","url":"https://only.example"}]` });
        try {
            const r = await ai.searchWeb('anything', { search: false });
            check('packet-only sources still populate', r.sources.map((s) => s.url), ['https://only.example']);
            ok('text carries answer + block', r.text.startsWith('Nothing to say.') && r.text.includes('*Sources:*'));
        } finally {
            mock.restore();
        }

        mock = installMockDeepAI({ webReply: `Sources:\nA (https://a.example)\nB (https://b.example)` });
        try {
            const r = await ai.searchWeb('anything', { search: false });
            check('sources-only reply is still ok', r.ok, true);
            check('answer empty, sources kept', r.answer, '');
            ok('text is the sources block', r.text.startsWith('*Sources:*') && r.text.includes('A — https://a.example'));
        } finally {
            mock.restore();
        }

        mock = installMockDeepAI({ webReply: `Sri Lanka's coffee exports grew 18% (Source: https://www.edb.gov.lk/coffee). Bloomberg is a trusted source for ChatGPT and Gemini market news.` });
        try {
            const r = await ai.searchWeb('sri lanka coffee', { minWords: 0, search: false });
            check('inline citation lifted', r.sources.map((s) => s.url), ['https://www.edb.gov.lk/coffee']);
            ok('citation removed from the sentence', r.answer.startsWith("Sri Lanka's coffee exports grew 18%."));
            ok('third-party vendor names survive in research output', /for ChatGPT and Gemini market news/.test(r.answer));
        } finally {
            mock.restore();
        }

        mock = installMockDeepAI({ webReply: `OpenAI released a new model today and Google answered with Gemini. I am Alexa Mini, not Alexa.` });
        try {
            const r = await ai.searchWeb('ai news', { minWords: 0, search: false });
            ok('news about AI vendors is not rewritten', r.answer.startsWith('OpenAI released a new model today and Google answered with Gemini.'));
            ok('but the assistant renaming itself is still repaired', r.answer.endsWith('I am Alexa.'));
        } finally {
            mock.restore();
        }

        let calls = 0;
        mock = installMockDeepAI({
            webReply: () => {
                calls++;
                if (calls === 1) return 'Coffee is a drink.';
                return `${FS}{"status":"Out of API credits"}${FS}`;
            },
        });
        try {
            const r = await ai.searchWeb('coffee prices', { search: false });
            check('retry failure falls back to the first reply', r.ok, true);
            check('two attempts recorded', r.attempts, 2);
            check('first reply kept', r.answer, 'Coffee is a drink.');
        } finally {
            mock.restore();
        }

        calls = 0;
        mock = installMockDeepAI({ webReply: () => (++calls === 1 ? 'Coffee is a drink.' : 'Coffee.') });
        try {
            const r = await ai.searchWeb('coffee prices', { search: false });
            check('shorter retry never replaces the first reply', r.answer, 'Coffee is a drink.');
        } finally {
            mock.restore();
        }

        mock = installMockDeepAI({ webReply: `${FS}{"status":"Out of API credits"}${FS}` });
        try {
            const r = await ai.searchWeb('anything', { search: false });
            check('empty reply -> ok:false with error', r.ok, false);
            ok('error code set', typeof r.error === 'string' && r.error.length > 0);
        } finally {
            mock.restore();
        }
    }

    section('WebAnswer — parsing the source formats models actually write');
    {
        const { WebAnswer, ResponseFormatter } = require('../index');
        const parse = (s) => WebAnswer.parse(ResponseFormatter.format(s));

        let r = parse('Answer.\n\n*Sources*\n1. Reuters — https://www.reuters.com/a\n2. BBC News: https://www.bbc.com/b\n3. The Guardian\nhttps://www.theguardian.com/c');
        check('dash / colon / two-line entries', r.sources.map((s) => [s.title, s.url]), [
            ['Reuters', 'https://www.reuters.com/a'],
            ['BBC News', 'https://www.bbc.com/b'],
            ['The Guardian', 'https://www.theguardian.com/c'],
        ]);
        check('answer trimmed', r.text, 'Answer.');

        r = parse('Answer.\n\nSources:\n- [Reuters](https://www.reuters.com/a)\n- [NCA](https://www.ncausa.org/trends)');
        check('markdown links under a heading', r.sources.map((s) => s.title), ['Reuters', 'NCA']);

        r = parse('Answer.\n\nSources: https://a.example/x, https://b.example/y');
        check('inline heading with urls', r.sources.map((s) => s.url), ['https://a.example/x', 'https://b.example/y']);

        r = parse('Answer.\n\nSources:\n- Coffee (https://en.wikipedia.org/wiki/Coffee_(beverage))');
        check('url with balanced parentheses', r.sources[0].url, 'https://en.wikipedia.org/wiki/Coffee_(beverage)');

        r = parse('Answer.\n\nhttps://www.ico.org/\nhttps://www.ncausa.org/');
        check('bare trailing urls without a heading', r.sources.map((s) => s.url), ['https://www.ico.org/', 'https://www.ncausa.org/']);

        r = parse('Coffee prices are rising. Read the report at https://www.ico.org/report which explains why.');
        check('a sentence containing a url is not a source list', r.sources, []);
        ok('sentence untouched', r.text.endsWith('which explains why.'));

        r = parse('Answer.\n\nReferences:\nI used general knowledge for this answer, no specific pages.');
        check('prose under a heading is not a list', r.sources, []);
        ok('prose kept', r.text.includes('general knowledge'));

        r = parse('Answer.\n\nSources: General knowledge, no specific pages.');
        check('placeholder sources line dropped', r.text, 'Answer.');

        r = parse('Answer.\n\nSources:\n1. National Coffee Association\n2. Reuters');
        check('named but unlinked sources', r.sources.map((s) => [s.title, s.url]), [['National Coffee Association', null], ['Reuters', null]]);

        check(
            'stripDisclaimers: first-person only',
            WebAnswer.stripDisclaimers("I'm a large language model, I don't have the ability to browse the web. However, coffee is popular. Google says its AI can browse the web."),
            'Coffee is popular. Google says its AI can browse the web.'
        );
        check(
            'stripDisclaimers: knowledge cut-off sentence',
            WebAnswer.stripDisclaimers('As of my last update in 2023, prices were high. Prices rose 10% in August.'),
            'Prices rose 10% in August.'
        );
        check('stripDisclaimers: clean text untouched', WebAnswer.stripDisclaimers('Retailers say they cannot access real-time data.'), 'Retailers say they cannot access real-time data.');

        const merged = WebAnswer.mergeSources(
            [{ title: 'XE', url: 'https://www.xe.com/currencyconverter/', description: 'rates' }],
            [{ title: null, url: 'http://xe.com/currencyconverter' }, { title: 'Reuters', url: null }, { title: 'Reuters', url: 'https://reuters.com/x' }]
        );
        check('mergeSources de-duplicates by normalised url and title', merged.map((s) => [s.title, s.url]), [
            ['XE', 'https://www.xe.com/currencyconverter/'],
            ['Reuters', 'https://reuters.com/x'],
        ]);
        check('mergeSources keeps the description', merged[0].description, 'rates');

        check('render: block appended once', WebAnswer.render('Body', [{ title: 'A', url: 'https://a' }, { title: null, url: 'https://b' }]), 'Body\n\n*Sources:*\n1. A — https://a\n2. https://b');
        check('render: no sources -> body only', WebAnswer.render('Body', []), 'Body');
        check('render: includeSources false', WebAnswer.render('Body', [{ url: 'https://a' }], { includeSources: false }), 'Body');
        check('render: maxSources', WebAnswer.render('Body', [{ url: 'https://a' }, { url: 'https://b' }], { maxSources: 1 }), 'Body\n\n*Sources:*\n1. https://a');

        check(
            'dropPlaceholders removes template tokens and empty scaffolding',
            WebAnswer.dropPlaceholders('*<Section heading 1>:*\n1. *<Headline>*: <…>\n2. *Real*: real text <…>\n\nSources:\n<Page title> (<url>)\nReal (https://r.example)'),
            '2. *Real*: real text\n\nSources:\nReal (https://r.example)'
        );
        check('dropPlaceholders leaves html-free text alone', WebAnswer.dropPlaceholders('a < b and b > c'), 'a < b and b > c');
        check('wordCount ignores markup, markers and urls', WebAnswer.wordCount("*Recent Coffee News:*\n1. *Starbucks' New Menu*: new drinks. https://x.y/z"), 8);
        check('wordCount of empty', WebAnswer.wordCount(''), 0);
        check(
            'stripDisclaimers: "based on my training data" note',
            WebAnswer.stripDisclaimers('3. *Subscriptions*: growing.\n\nPlease note that the information I provided is based on my training data and may not reflect the most up-to-date news.'),
            '3. *Subscriptions*: growing.'
        );
        check('stripDisclaimers: "generated by ChatGPT"', WebAnswer.stripDisclaimers('This response was generated by ChatGPT. Coffee is nice.'), 'Coffee is nice.');
        ok('expandPrompt mentions the topic and the word count', /"coffee"/.test(WebAnswer.expandPrompt('coffee', 23)) && /only 23 words/.test(WebAnswer.expandPrompt('coffee', 23)));
        const grounded = WebAnswer.prompt('coffee', { results: [{ title: 'T1', url: 'https://a.example/x', description: 'D1', date: '2026-09-01' }, { url: 'https://b.example/y' }] });
        ok('prompt(grounded): numbered material', grounded.includes('[1] T1 (2026-09-01) — a.example\n   D1') && grounded.includes('[2] b.example'));
        ok('prompt(grounded): no Sources list requested', grounded.includes('Do NOT write a "Sources" list') && !grounded.includes('<Page title> (<url>)'));
        ok('prompt(grounded): asks for citations', grounded.includes('[<result number>]'));
        ok('prompt(ungrounded): asks for the Sources list', WebAnswer.prompt('x').includes('<Page title> (<url>)'));
        check('extractCitations', WebAnswer.extractCitations('A [1]. B [2][1]. C [1, 3]. D [2-3]. Year [2026]. Out [9].', 3), { text: 'A. B. C. D. Year [2026]. Out.', cited: [1, 2, 3] });
        check('extractCitations: worded markers, prose numbers kept', WebAnswer.extractCitations('Up 12% (2025) [Source 2]. Then (source: 1) and (result 3), but (4) stays.', 3), { text: 'Up 12% (2025). Then and, but (4) stays.', cited: [2, 1, 3] });
        check(
            'stripUrls: matching URL -> citation, unknown URL removed',
            WebAnswer.stripUrls('Prices rose (see https://a.example/x). More at https://fake.example/b. Also (Source: https://fake.example/c, https://www.a.example/x/) here.', [{ url: 'https://a.example/x' }]),
            'Prices rose [1]. More. Also [1] here.'
        );
        ok('digest lists results', WebAnswer.digest([{ title: 'T', url: 'https://a/b', description: 'D', date: '2026-01-01' }]).includes('1. *T* _(2026-01-01)_: D'));
        ok('prompt: long by default', /3 to 5 sections/.test(WebAnswer.prompt('x')));
        ok('prompt: short', /2 to 4 sentences/.test(WebAnswer.prompt('x', { detail: 'brief' })));
        ok("prompt: today's date included", WebAnswer.prompt('x', { now: new Date('2026-09-06T00:00:00Z') }).includes('2026-09-06'));
        check('detailOf', ['short', 'brief', 'long', undefined, 'anything'].map(WebAnswer.detailOf), ['short', 'short', 'long', 'long', 'long']);
    }

    section('summarizeText() — /api refused on free key, chat fallback answers');
    {
        const ai = new AlexaAI({ key: 'tryit-1-x', postgresUrl: 'postgres://u:p@localhost/db', autoMigrate: false, maxRetries: 0 });
        const mock = installMockDeepAI();
        try {
            const r = await ai.summarizeText('Alexa is a WhatsApp assistant created by Hansaka. She remembers people across chats.');
            check('ok', r.ok, true);
            check('route', r.via, 'chat');
            ok('summary text', r.text.includes('WhatsApp assistant'));
            const empty = await ai.summarizeText('');
            check('empty text rejected', empty.error, 'VALIDATION_ERROR');
        } finally {
            mock.restore();
        }
    }

    section('upscaleImage / editImage / colorizeImage / detectNsfw — media shapes');
    {
        const ai = new AlexaAI({ key: 'tryit-1-x', postgresUrl: 'postgres://u:p@localhost/db', autoMigrate: false, maxRetries: 0 });
        const mock = installMockDeepAI();
        try {
            const up = await ai.upscaleImage(PNG);
            check('upscale(Buffer) ok', up.ok, true);
            ok('upscale url', up.url.includes('job-view-file'));
            const upCall = mock.calls.find((c) => c.url.includes('torch-srgan'));
            check('upload carries the sniffed content type', upCall.files.image.type, 'image/png');
            check('upload carries a filename', upCall.files.image.name, 'image.png');

            const upB64 = await ai.upscaleImage(PNG.toString('base64'));
            check('upscale(raw base64) ok', upB64.ok, true);
            const upObj = await ai.upscaleImage({ base64: PNG.toString('base64'), mimetype: 'image/png' });
            check('upscale({ base64 }) ok', upObj.ok, true);
            const upUrl = await ai.upscaleImage('https://example.com/a.jpg');
            check('upscale(url) ok', upUrl.ok, true);
            const urlCall = mock.calls.filter((c) => c.url.includes('torch-srgan')).pop();
            check('url is sent as a plain field', urlCall.fields.image, 'https://example.com/a.jpg');

            const bad = await ai.upscaleImage('not an image at all');
            check('unusable input returns an error, not a throw', bad.ok, false);
            ok('…with a helpful message', /Buffer, base64/.test(bad.message));

            const edit = await ai.editImage({ buffer: PNG }, 'make the sky purple');
            check('editImage ok', edit.ok, true);
            const editCall = mock.calls.find((c) => c.url.includes('image-editor'));
            check('editImage sends the prompt', editCall.fields.text, 'make the sky purple');

            const col = await ai.colorizeImage(PNG);
            check('colorizeImage ok', col.ok, true);

            const nsfw = await ai.detectNsfw(PNG);
            check('detectNsfw score', nsfw.score, 0.03);
            check('detectNsfw verdict', nsfw.nsfw, false);
        } finally {
            mock.restore();
        }
    }

    section('describeImage() — bare Buffer, OCR fallback, WhatsApp-ready text');
    {
        const ai = new AlexaAI({ key: 'tryit-1-x', postgresUrl: 'postgres://u:p@localhost/db', autoMigrate: false, maxRetries: 0 });
        const mock = installMockDeepAI();
        try {
            const r = await ai.describeImage(PNG, 'what is the total?');
            check('bare Buffer is readable now', r.reason, null);
            check('ok', r.ok, true);
            check('came from OCR (free key has no vision)', r.source, 'ocr');
            ok('description carries the OCR text', r.description.includes('Rs 4,500'));
            ok('text field is ready to send', r.text.includes('Rs 4,500'));
            ok('attachment uuid returned', r.attachmentUuids.includes('att-1'));

            const none = await ai.describeImage(null);
            check('no image -> no_image', none.reason, 'no_image');
            check('no image -> empty text', none.text, '');
        } finally {
            mock.restore();
        }
    }

    section('chat() — image param accepts every shape');
    {
        const ai = new AlexaAI({ key: 'tryit-1-x', postgresUrl: 'postgres://u:p@localhost/db', autoMigrate: false, maxRetries: 0 });
        const db = createFakeDb();
        ai.db = db; ai.users.db = db; ai.memories.db = db; ai.conversations.db = db; ai.identities.db = db;
        const mock = installMockDeepAI();
        try {
            const r = await ai.chat({ message: 'what is this?', userId: '94771234567@s.whatsapp.net', image: PNG });
            ok('bare Buffer image reaches the vision chain', mock.calls.some((c) => c.url.includes('chat_attachments/upload')));
            ok('reply produced', r.text.length > 0);
            const r2 = await ai.chat({ message: 'and this?', userId: '94771234567@s.whatsapp.net', image: `data:image/png;base64,${PNG.toString('base64')}` });
            ok('data URI image accepted', r2.text.length > 0 && r2.error !== 'vision_unavailable');
            const r3 = await ai.chat({ message: 'file alias', userId: '94771234567@s.whatsapp.net', file: { buffer: PNG } });
            ok('`file` alias accepted', r3.text.length > 0);

            const viaAsk = await ai.ask({ text: 'ask shape', files: [PNG.toString('base64')] }, '94771234567@s.whatsapp.net');
            ok('ask() accepts a raw base64 file', typeof viaAsk === 'string' && viaAsk.length > 0);
        } finally {
            mock.restore();
        }
    }

    section('deepaiHealth()');
    {
        const ai = new AlexaAI({ key: 'tryit-1-x', postgresUrl: 'postgres://u:p@localhost/db', autoMigrate: false, maxRetries: 0 });
        const mock = installMockDeepAI();
        try {
            const h = await ai.deepaiHealth();
            check('ok', h.ok, true);
            check('reply', h.reply, 'ok');
            check('model reported', h.model, 'standard');
        } finally {
            mock.restore();
        }
    }
}

async function databaseTests() {
    const pgUrl = process.env.POSTGRES_URL;
    if (!pgUrl) {
        console.log('\n\x1b[33m⏭  Skipping PostgreSQL wrapper tests (set POSTGRES_URL)\x1b[0m');
        return;
    }
    section('Admin methods on a real PostgreSQL — aliases and unseen rows');
    const ai = new AlexaAI({ key: 'tryit-1-x', postgresUrl: pgUrl, autoMigrate: true });
    const LID = '78151912841263@lid';
    const PHONE = '94771234567@s.whatsapp.net';
    const GROUP = '120363413125431525@g.us';
    const NEW_GROUP = '120363000000000001@g.us';
    try {
        await ai.init();
        await ai.db.query('TRUNCATE wa_users, wa_groups RESTART IDENTITY CASCADE');

        // Person first seen via DM (phone), later linked to their group @lid.
        await ai.users.upsertUser(PHONE, { pushName: 'Nimal' });
        await ai.linkIdentity(PHONE, LID);

        const blocked = await ai.blockUser(LID);
        ok('blockUser() through an ALIAS returns the row', Boolean(blocked && blocked.is_blocked));
        check('…and the person really is blocked', await ai.isBlocked(PHONE), true);
        const silent = await ai.chat({ message: 'hello?', userId: LID, groupId: GROUP });
        check('blocked person gets an empty reply', [silent.text, silent.error], ['', 'user_blocked']);

        const unblocked = await ai.unblockUser(PHONE);
        check('unblockUser() through the other alias', unblocked.is_blocked, false);
        check('isBlocked() false again', await ai.isBlocked(LID), false);

        const pre = await ai.blockUser('94770000009@s.whatsapp.net');
        ok('blocking an unseen user creates the row', Boolean(pre && pre.is_blocked));
        check('unblocking an unseen user is a no-op (null)', await ai.unblockUser('94770000010@s.whatsapp.net'), null);

        const off = await ai.setGroupEnabled(NEW_GROUP, false);
        ok('setGroupEnabled() on an UNSEEN group creates it', Boolean(off) && off.is_enabled === false);
        check('isGroupEnabled() false', await ai.isGroupEnabled(NEW_GROUP), false);
        check('unknown groups default to enabled', await ai.isGroupEnabled('120363999999999999@g.us'), true);
        const muted = await ai.chat({ message: 'hi', userId: PHONE, groupId: NEW_GROUP });
        check('disabled group gets an empty reply', [muted.text, muted.error], ['', 'group_disabled']);
        const on = await ai.setGroupEnabled(NEW_GROUP, true);
        check('re-enabled', on.is_enabled, true);

        let threw = null;
        try { await ai.blockUser(GROUP); } catch (e) { threw = e.code; }
        check('blockUser(groupJid) is a validation error', threw, 'VALIDATION_ERROR');
        threw = null;
        try { await ai.setGroupEnabled(PHONE, false); } catch (e) { threw = e.code; }
        check('setGroupEnabled(userJid) is a validation error', threw, 'VALIDATION_ERROR');

        // Memory helpers through either alias.
        await ai.remember(LID, 'city', 'Galle');
        check('remember() via @lid is visible via phone', (await ai.getMemories(PHONE)).city, 'Galle');
        check('forget() via phone', await ai.forget(PHONE, 'city'), true);
        check('forgetAll() count', await ai.forgetAll(LID), 0);
        const profile = await ai.getProfile(LID);
        ok('getProfile() via alias', profile && profile.user.jid === PHONE);
        const who = await ai.whoIs(PHONE);
        check('whoIs() lists both addresses', who.aliases.sort(), [LID, PHONE].sort());
        ok('health()', (await ai.health()).ok);
        ok('stats()', Number((await ai.stats()).users) >= 1);
    } finally {
        await ai.close();
    }
}

mockedTests()
    .then(databaseTests)
    .catch((err) => {
        failed++;
        failures.push(`Crashed: ${err.stack || err.message}`);
        console.log(`\n\x1b[31m❌ Crashed: ${err.message}\x1b[0m`);
    })
    .finally(() => {
        console.log(`\n${'═'.repeat(62)}`);
        console.log(`\x1b[1mRESULT\x1b[0m  ✅ ${passed} passed   ❌ ${failed} failed`);
        console.log('═'.repeat(62));
        if (failures.length) {
            console.log('\nFailures:');
            failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
        }
        process.exit(failed ? 1 : 0);
    });
