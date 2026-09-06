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
        if (u.includes('/hacking_is_a_serious_crime')) {
            const history = JSON.parse(fields.chatHistory || '[]');
            const last = history[history.length - 1]?.content || '';

            // In-chat image tool: the browser's generate_image function call.
            if (last.includes('"function_call"') && last.includes('generate_image')) {
                return respond(`Here is your image!${FS}${JSON.stringify({ type: 'generated_image', share_url: 'https://deepai.org/generated/abc123.png' })}`);
            }
            if (fields.search === 'search' || fields.web_access_enabled === 'true') {
                const results = [
                    { title: 'Central Bank of Sri Lanka', url: 'https://www.cbsl.gov.lk', description: 'Exchange rates' },
                    { title: 'XE', url: 'https://www.xe.com/currencyconverter/', description: 'LKR to USD' },
                ];
                return respond(`${FS}{"tool_activity":"Searching the web…"}${FS}Today **1 USD ≈ 300 LKR** according to the Central Bank.${FS}${JSON.stringify(results)}`);
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
            const r = await ai.searchWeb('LKR to USD today');
            check('ok', r.ok, true);
            ok('answer text present', r.text.includes('1 USD'));
            ok('markdown ** converted to WhatsApp *', !r.text.includes('**') && r.text.includes('*1 USD ≈ 300 LKR*'));
            ok('no control characters leak', !/[\u001C\u001D\u001E]/.test(r.text));
            ok('tool activity packet stripped', !r.text.includes('Searching the web'));
            check('sources parsed', r.sources.map((s) => s.url), ['https://www.cbsl.gov.lk', 'https://www.xe.com/currencyconverter/']);
            const call = mock.calls.find((c) => c.url.includes('hacking'));
            check('web_access_enabled sent', call.fields.web_access_enabled, 'true');
            check('search flag sent', call.fields.search, 'search');
            check('online flag sent', call.fields.online, 'online');
            const history = JSON.parse(call.fields.chatHistory);
            ok('query is in the prompt', history[history.length - 1].content.includes('LKR to USD today'));
            ok('persona still applied', history.some((m) => m.content.includes('Alexa')));

            const empty = await ai.searchWeb('');
            check('empty query rejected, not thrown', empty.error, 'VALIDATION_ERROR');
        } finally {
            mock.restore();
        }
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
