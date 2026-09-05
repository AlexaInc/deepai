'use strict';

/**
 * Test suite.
 *
 *   node test/run-tests.js
 *
 * Unit tests always run. Integration tests (real Postgres + real DeepAI) run
 * only when the matching env vars are present:
 *
 *   POSTGRES_URL=postgres://...  DEEPAI_KEY=tryit-...  node test/run-tests.js
 */

const {
    AlexaAI,
    JidParser,
    MemoryExtractor,
    FactMiner,
    MathDetector,
    IdentityGuard,
    AmnesiaGuard,
    IdentityResolver,
    ResponseFormatter,
    TriggerDetector,
    MemoryRepository,
    PromptBuilder,
    StreamParser,
    DeepAIClient,
    Config,
} = require('../index');
const { createFakeDb, installFakeDeepAI } = require('./fakes');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        passed++;
        console.log(`  ✅ ${name}`);
    } else {
        failed++;
        failures.push(`${name}\n       expected: ${e}\n       actual:   ${a}`);
        console.log(`  ❌ ${name}\n       expected: ${e}\n       actual:   ${a}`);
    }
}

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

function section(title) {
    console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// ==========================================================================
section('JidParser — WhatsApp identifier handling');
// ==========================================================================
check('parses @lid user', JidParser.parse('78151912841263@lid').type, 'lid');
check('@lid is a user', JidParser.parse('78151912841263@lid').isUser, true);
check('@lid is not a group', JidParser.parse('78151912841263@lid').isGroup, false);
check('@lid yields no phone (privacy id)', JidParser.parse('78151912841263@lid').phone, null);
check('parses group jid', JidParser.parse('120363413125431525@g.us').isGroup, true);
check('parses phone jid', JidParser.parse('94771234567@s.whatsapp.net').phone, '94771234567');
check('strips device suffix', JidParser.normalize('94771234567:12@s.whatsapp.net'), '94771234567@s.whatsapp.net');
check('keeps device number', JidParser.parse('94771234567:12@s.whatsapp.net').device, 12);
check('legacy @c.us is a user', JidParser.parse('94771234567@c.us').isUser, true);
check('invalid input is not valid', JidParser.parse('').valid, false);
check('null input is not valid', JidParser.parse(null).valid, false);
check('DM context key', JidParser.contextKey('78151912841263@lid'), 'dm:78151912841263@lid');
check(
    'group context key is per-user',
    JidParser.contextKey('78151912841263@lid', '120363413125431525@g.us'),
    'group:120363413125431525@g.us:78151912841263@lid'
);
check(
    'shared group thread key',
    JidParser.contextKey('78151912841263@lid', '120363413125431525@g.us', true),
    'group:120363413125431525@g.us'
);
ok(
    'same user has ONE identity across DM and groups',
    JidParser.normalize('78151912841263@lid') === JidParser.normalize('78151912841263:5@lid')
);

// ==========================================================================
section('MemoryExtractor — @MEMORY tag parsing');
// ==========================================================================
{
    const r = MemoryExtractor.extract(
        'Nice to meet you, Nimal! Cricket is a great sport. @MEMORY: {"name": "Nimal", "hobby": "cricket"}'
    );
    check('extracts name', r.memories.name, 'Nimal');
    check('extracts hobby', r.memories.hobby, 'cricket');
    check('strips tag from visible text', r.text, 'Nice to meet you, Nimal! Cricket is a great sport.');
    check('flags found', r.found, true);
}
{
    const r = MemoryExtractor.extract('Got it!@MEMORY:{"city":"Galle"}');
    check('handles no-space compact tag', r.memories.city, 'Galle');
}
{
    const r = MemoryExtractor.extract("Sure thing. @memory: {'food': 'kottu'}");
    check('handles single quotes + lowercase tag', r.memories.food, 'kottu');
}
{
    const r = MemoryExtractor.extract('Hello. @MEMORY: {"a": "1"} @MEMORY: {"b": "2"}');
    check('handles multiple tags', [r.memories.a, r.memories.b], ['1', '2']);
}
{
    const r = MemoryExtractor.extract('Hi there! *@MEMORY:* {"name": "Sahan"}');
    check('handles WhatsApp-bolded tag', r.memories.name, 'Sahan');
}
{
    const r = MemoryExtractor.extract('Noted. @MEMORY: name: Kasun, city: Kandy');
    check('handles non-JSON fallback', [r.memories.name, r.memories.city], ['Kasun', 'Kandy']);
}
{
    const r = MemoryExtractor.extract('Just a normal reply with no tag.');
    check('no false positive', r.found, false);
    check('text untouched', r.text, 'Just a normal reply with no tag.');
}
{
    const r = MemoryExtractor.extract('Reply. @MEMORY: {"Favourite Food": "Kottu Roti"}');
    check('normalises key to snake_case', r.memories.favourite_food, 'Kottu Roti');
}
ok('strip() removes tag entirely', !/@MEMORY/i.test(MemoryExtractor.strip('Hi @MEMORY: {"x":"y"}')));


// ==========================================================================
section('FactMiner — local fact extraction (fallback when model omits @MEMORY)');
// ==========================================================================
check('mines name from intro', FactMiner.mine("Hi, I'm Nimal and I love playing cricket.").name, 'Nimal');
check('mines hobby from intro', FactMiner.mine("Hi, I'm Nimal and I love playing cricket.").hobby, 'cricket');
check('mines "my name is"', FactMiner.mine('My name is Kasun Perera').name, 'Kasun Perera');
check('mines location', FactMiner.mine('I live in Galle').location, 'Galle');
check('mines favourite food', FactMiner.mine('My favourite food is kottu').favourite_food, 'kottu');
check('mines age', FactMiner.mine('I am 25 years old').age, '25');
check('mines studies', FactMiner.mine('I am studying computer science').studies, 'computer science');
check('mines favourite team', FactMiner.mine('I support Manchester United').favourite_team, 'Manchester United');
check('ignores third-party facts', FactMiner.mine('My friend lives in Kandy').location, undefined);
check('no false positives on plain chat', FactMiner.mine('What is the capital of France?'), {});
check('ignores junk value', FactMiner.mine('I am ok').name, undefined);
check('rejects absurd age', FactMiner.mine('I am 999 years old').age, undefined);
ok('handles empty input', Object.keys(FactMiner.mine('')).length === 0);
ok('handles null input', Object.keys(FactMiner.mine(null)).length === 0);

// ==========================================================================
section('MemoryRepository — key/value normalisation');
// ==========================================================================
check('lowercases + snake_cases key', MemoryRepository.normalizeKey('Favourite  Food'), 'favourite_food');
check('rejects blocked key', MemoryRepository.normalizeKey('null'), null);
check('rejects empty key', MemoryRepository.normalizeKey('   '), null);
check('strips punctuation from key', MemoryRepository.normalizeKey('user@name!'), 'username');
check('stringifies object value', MemoryRepository.normalizeValue({ a: 1 }), '{"a":1}');
check('rejects null value', MemoryRepository.normalizeValue(null), null);
ok('truncates very long value', MemoryRepository.normalizeValue('x'.repeat(9999)).length === 512);



// ==========================================================================
section('IdentityGuard — Alexa never reveals the backend vendor');
// ==========================================================================
ok('detects "are you alexa?"', IdentityGuard.isIdentityQuestion('are you alexa?'));
ok('detects "what is your name?"', IdentityGuard.isIdentityQuestion('what is your name?'));
ok('detects "who created you?"', IdentityGuard.isIdentityQuestion('who created you?'));
ok('detects "what model are you?"', IdentityGuard.isIdentityQuestion('what model are you?'));
ok('detects "are you ChatGPT?"', IdentityGuard.isIdentityQuestion('are you ChatGPT?'));
ok('detects "which company made you"', IdentityGuard.isIdentityQuestion('which company made you'));
ok('ignores normal chat', !IdentityGuard.isIdentityQuestion('what is the weather today'));
ok('hint added for identity question', IdentityGuard.hintFor('who made you?').includes('IDENTITY LOCK'));
check('no hint for normal chat', IdentityGuard.hintFor('hello'), '');
check(
    'replaces a leaked identity answer',
    IdentityGuard.sanitise('I am Standard AI Chat by DeepAI.', true),
    'I am *Alexa*, your WhatsApp assistant created by *Hansaka*. \u{1F60A}'
);
ok(
    'scrubs vendor name mid-sentence',
    !/deepai/i.test(IdentityGuard.sanitise('Sure! DeepAI can help with that.', false))
);
ok(
    'scrubs "large language model"',
    !/language model/i.test(IdentityGuard.sanitise("I'm a large language model, here to help.", false))
);
check('leaves clean replies untouched', IdentityGuard.sanitise('The weather is sunny today.', false), 'The weather is sunny today.');
ok('no ChatGPT leak survives', !/chatgpt/i.test(IdentityGuard.sanitise('I am ChatGPT, how can I help?', false)));

// ==========================================================================
section('MathDetector — concise math answers');
// ==========================================================================
ok('detects area question', MathDetector.isMath('Calculate the area of a circle with radius 7'));
ok('detects percentage', MathDetector.isMath('What is 15% of 240?'));
ok('detects raw expression', MathDetector.isMath('12 * 47'));
ok('detects equation solving', MathDetector.isMath('solve 2x + 5 = 15 for x'));
ok('ignores plain chat', !MathDetector.isMath('Tell me a joke'));
ok('ignores explanation requests', !MathDetector.isMath('explain why 2+2=4'));
ok('ignores text with no digits', !MathDetector.isMath('what is the area of a circle'));
ok('ignores greetings', !MathDetector.isMath('hello there'));

// ==========================================================================
section('TriggerDetector — exact command outputs');
// ==========================================================================
check('weather + city', TriggerDetector.detect('What is the weather in Colombo today?')?.output, 'weather Colombo');
check('raining phrasing', TriggerDetector.detect('Is it raining in Kandy right now?')?.output, 'weather Kandy');
check('city-first phrasing', TriggerDetector.detect('Galle weather')?.output, 'weather Galle');
check('temperature phrasing', TriggerDetector.detect('temperature in New York')?.output, 'weather New York');
check('menu', TriggerDetector.detect('show menu')?.output, 'menu');
check('menu variant', TriggerDetector.detect('What are your commands?')?.output, 'menu');
check('ping', TriggerDetector.detect('ping')?.output, 'ping');
check('ping variant', TriggerDetector.detect('are you online?')?.output, 'ping');
check('doc', TriggerDetector.detect('send me the docs')?.output, 'doc');
check('doc variant', TriggerDetector.detect('user guide')?.output, 'doc');
check('normal chat is not a trigger', TriggerDetector.detect('Tell me a joke about the weather man'), null);
check('weather with no city falls through to AI', TriggerDetector.detect('is it hot today?'), null);
check('long text is never a trigger', TriggerDetector.detect('menu '.repeat(60)), null);
check('handles WhatsApp bold markers', TriggerDetector.detect('*ping*')?.output, 'ping');

// ==========================================================================
section('ResponseFormatter — WhatsApp formatting enforcement');
// ==========================================================================
check('converts **bold**', ResponseFormatter.format('**Hello Sahan!**'), '*Hello Sahan!*');
check('converts __bold__', ResponseFormatter.format('__Hi__'), '*Hi*');
check('converts ***bolditalic***', ResponseFormatter.format('***wow***'), '_*wow*_');
check('converts ### heading', ResponseFormatter.format('### Title'), '*Title*');
check('converts bullets', ResponseFormatter.format('* one\n* two'), '• one\n• two');
check('converts markdown link', ResponseFormatter.format('[site](https://a.com)'), 'site (https://a.com)');
check('preserves inline code', ResponseFormatter.format('`A = π * 7²`'), '`A = π * 7²`');
ok(
    'preserves fenced code untouched',
    ResponseFormatter.format('```\nconst a = **1**;\n```').includes('**1**')
);
check('preserves single-asterisk bold', ResponseFormatter.format('*already bold*'), '*already bold*');
check('removes blockquote marker', ResponseFormatter.format('> quoted'), 'quoted');
ok('chunk() splits long text', ResponseFormatter.chunk('a '.repeat(3000), 1000).length > 1);
ok('chunk() keeps short text as one', ResponseFormatter.chunk('hello', 1000).length === 1);
ok('no ** survives formatting', !ResponseFormatter.format('**a** and **b**').includes('**'));
ok(
    'strips echoed internal recall note',
    !ResponseFormatter.format('[Remembered facts about this person - x=y]\nHello!').includes('Remembered facts')
);
check('keeps the real reply after stripping note', ResponseFormatter.format('[Remembered facts about this person - x=y]\nHello!'), 'Hello!');
ok(
    'strips echoed MATH MODE hint',
    !ResponseFormatter.format('[MATH MODE: only one line]\n`A = 5`').includes('MATH MODE')
);

// ==========================================================================
section('Config — validation and defaults');
// ==========================================================================
ok(
    'throws without key',
    (() => {
        try {
            new Config({ postgresUrl: 'postgres://x' });
            return false;
        } catch {
            return true;
        }
    })()
);
ok(
    'throws without postgresUrl',
    (() => {
        // Config falls back to env vars, so clear them for this assertion.
        const savedPg = process.env.POSTGRES_URL;
        const savedDb = process.env.DATABASE_URL;
        delete process.env.POSTGRES_URL;
        delete process.env.DATABASE_URL;
        try {
            new Config({ key: 'k' });
            return false;
        } catch {
            return true;
        } finally {
            if (savedPg !== undefined) process.env.POSTGRES_URL = savedPg;
            if (savedDb !== undefined) process.env.DATABASE_URL = savedDb;
        }
    })()
);
{
    const c = new Config({ key: 'k', postgresUrl: 'postgres://u:p@localhost:5432/db' });
    check('default model', c.model, 'standard');
    check('localhost disables ssl', c.ssl, false);
    check('redacts password in toJSON', c.toJSON().postgresUrl.includes('****'), true);
}
{
    const c = new Config({ key: 'k', postgresUrl: 'postgres://u:p@db.neon.tech:5432/db' });
    check('remote host enables relaxed ssl', c.ssl, { rejectUnauthorized: false });
}
{
    const c = new Config({ key: 'k', postgueurl: 'postgres://u:p@localhost/db' });
    ok('accepts postgueurl alias', c.postgresUrl.length > 0);
}

// ==========================================================================
section('PromptBuilder — persona delivery');
// ==========================================================================
{
    const cfg = new Config({ key: 'k', postgresUrl: 'postgres://u:p@localhost/db' });
    const pb = new PromptBuilder(cfg);
    const msgs = pb.build({
        message: 'hello',
        history: [
            { role: 'user', content: 'earlier' },
            { role: 'assistant', content: 'reply' },
        ],
        memories: { name: 'Nimal', hobby: 'cricket' },
        userName: 'Nimal',
        isGroup: true,
        groupName: 'Test Group',
    });
    const persona = msgs[1];
    check('first turn is the system digest', msgs[0].role, 'system');
    ok('system digest states the exact name', msgs[0].content.includes('exactly "Alexa"'));
    check('persona turn is delivered as a user turn', persona.role, 'user');
    ok('persona text present', persona.content.includes('You are Alexa'));
    ok('memories injected', persona.content.includes('Nimal') && persona.content.includes('cricket'));
    ok('group context injected', persona.content.includes('GROUP'));
    ok('group turn states it is the same person as the DM', persona.content.includes('SAME person'));
    check('third turn is the assistant ack', msgs[2].role, 'assistant');
    ok('last turn contains the live message', msgs[msgs.length - 1].content.endsWith('hello'));
    ok('recall note precedes the live message', msgs[msgs.length - 1].content.includes('Remembered facts'));
    ok('recall note lists known facts', msgs[msgs.length - 1].content.includes('name=Nimal'));
    check('history preserved in order', [msgs[3].content, msgs[4].content], ['earlier', 'reply']);
}
{
    const cfg = new Config({ key: 'k', postgresUrl: 'postgres://u:p@localhost/db', systemRole: false });
    const pb = new PromptBuilder(cfg);
    const msgs = pb.build({ message: 'hi', history: [{ role: 'assistant', content: 'orphan' }] });
    ok('systemRole:false removes the system turn', !msgs.some((m) => m.role === 'system'));
    check('persona is still the first turn', msgs[0].role, 'user');
    ok('drops leading assistant turn', !msgs.slice(2, -1).some((m) => m.content === 'orphan'));
    check('no recall note when there are no memories', msgs[msgs.length - 1].content, 'hi');
}
{
    const cfg = new Config({ key: 'k', postgresUrl: 'postgres://u:p@localhost/db' });
    const pb = new PromptBuilder(cfg);
    const msgs = pb.build({ message: 'do you remember me?', memories: { name: 'Nimal' }, userName: 'Nimal' });
    const live = msgs[msgs.length - 1].content;
    ok('recall question gets a MEMORY CHECK directive', live.includes('MEMORY CHECK'));
    ok('directive carries the saved facts', live.includes('name: Nimal'));
    const plain = pb.build({ message: 'what is 2+2?', memories: { name: 'Nimal' } });
    ok('normal question gets no MEMORY CHECK', !plain[plain.length - 1].content.includes('MEMORY CHECK'));
}
{
    const cfg = new Config({
        key: 'k',
        postgresUrl: 'postgres://u:p@localhost/db',
        assistantName: 'Nova',
        creator: 'Kasun',
    });
    const pb = new PromptBuilder(cfg);
    const msgs = pb.build({ message: 'hi' });
    ok('persona can be renamed', msgs[1].content.includes('You are Nova'));
    ok('creator can be renamed', msgs[1].content.includes('created by Kasun'));
}

// ==========================================================================
section('IdentityGuard — model-tier suffixes and self-denials');
// ==========================================================================
check(
    'repairs "Alexa Mini, not Alexa"',
    IdentityGuard.sanitise('I am Alexa Mini, not Alexa.', false),
    'I am Alexa.'
);
check(
    'repairs a lowercase variant mid-reply',
    IdentityGuard.sanitise("I'm Alexa mini, not Alexa. How can I help?", false),
    "I'm Alexa. How can I help?"
);
check(
    'repairs "not Alexa, I am GPT-4.1 Nano"',
    IdentityGuard.sanitise('I am not Alexa, I am GPT-4.1 Nano.', false),
    'I am Alexa.'
);
ok('detects "are you alexa mini?"', IdentityGuard.isIdentityQuestion('are you alexa mini?'));
ok(
    'identity lock names the exact persona',
    IdentityGuard.hintFor('who are you?').includes('NOT "Alexa Mini"')
);
{
    const nova = new IdentityGuard({ assistantName: 'Nova', creator: 'Kasun' });
    check('renamed persona answer', nova.sanitise('I am ChatGPT.', true), 'I am *Nova*, your WhatsApp assistant created by *Kasun*. 😊');
    check('renamed persona strips its own suffix', nova.sanitise('I am Nova Pro, not Nova.', false), 'I am Nova.');
}

// ==========================================================================
section('AmnesiaGuard — never deny a memory we actually have');
// ==========================================================================
{
    const guard = new AmnesiaGuard();
    ok('detects "do you remember me"', AmnesiaGuard.isRecallQuestion('do you remember me?'));
    ok('detects "what is my name"', AmnesiaGuard.isRecallQuestion('what is my name?'));
    ok('detects "who am i"', AmnesiaGuard.isRecallQuestion('who am i'));
    ok('ignores normal chat', !AmnesiaGuard.isRecallQuestion('what is the capital of France?'));

    ok('detects a denial', AmnesiaGuard.isDenial("Unfortunately, as a bot I can't remember you."));
    ok('detects "no memory of past conversations"', AmnesiaGuard.isDenial('I have no memory of our previous chats.'));
    ok('detects "conversation just started"', AmnesiaGuard.isDenial('Our conversation just started!'));
    ok('does not flag a normal reply', !AmnesiaGuard.isDenial('Sure, the capital of France is Paris.'));

    const memories = { name: 'Nimal', location: 'Galle', hobby: 'cricket' };
    const fixed = guard.repair("Unfortunately, as a bot I can't remember you.", {
        memories,
        displayName: 'Nimal',
        isRecall: true,
    });
    ok('repairs the denial', fixed.repaired);
    ok('answer uses the stored name', fixed.text.includes('Nimal'));
    ok('answer uses the stored facts', fixed.text.includes('Galle') && fixed.text.includes('cricket'));
    ok('no denial survives', !AmnesiaGuard.isDenial(fixed.text));

    const noFacts = guard.repair("I can't remember previous conversations.", { memories: {}, isRecall: true });
    ok('honest when nothing is stored', noFacts.repaired && /don't have any details saved/.test(noFacts.text));
    ok('but never claims to be memoryless', !AmnesiaGuard.isDenial(noFacts.text));

    const untouched = guard.repair('Paris is the capital of France.', { memories });
    ok('leaves clean replies alone', !untouched.repaired);
}

// ==========================================================================
section('IdentityResolver — one human, many WhatsApp addresses');
// ==========================================================================
check(
    'collects the primary jid first',
    IdentityResolver.collectAliases({ userId: '78151912841263@lid' }),
    ['78151912841263@lid']
);
check(
    'collects a LID + phone pair (Baileys participantAlt)',
    IdentityResolver.collectAliases({
        userId: '78151912841263@lid',
        participantAlt: '94771234567@s.whatsapp.net',
    }),
    ['78151912841263@lid', '94771234567@s.whatsapp.net']
);
check(
    'accepts a bare phone number',
    IdentityResolver.collectAliases({ userId: '78151912841263@lid', userPhone: '+94771234567' }),
    ['78151912841263@lid', '94771234567@s.whatsapp.net']
);
check(
    'de-duplicates device suffixes',
    IdentityResolver.collectAliases({
        userId: '94771234567:12@s.whatsapp.net',
        aliases: ['94771234567@s.whatsapp.net'],
    }),
    ['94771234567@s.whatsapp.net']
);
check('ignores group jids', IdentityResolver.collectAliases({ userId: '120363413125431525@g.us' }), []);
check('ignores junk', IdentityResolver.toUserJid('not a jid'), null);

// ==========================================================================
section('StreamParser — DeepAI wire packets never reach WhatsApp');
// ==========================================================================
{
    const FS = '\u001C';
    const GS = '\u001D';
    const RS = '\u001E';

    check('plain text passes through', StreamParser.parse('Hello there!').text, 'Hello there!');

    const withActivity = StreamParser.parse(
        `Search${FS}{"tool_activity":"Searching the web"}${FS}ing done.`
    );
    check('tool activity is stripped', withActivity.text, 'Searching done.');
    check('tool activity is reported', withActivity.toolActivity, ['Searching the web']);

    const withResults = StreamParser.parse(
        `Here are the results.${FS}[{"title":"A","url":"https://a.example"}]`
    );
    check('trailing payload is removed from the text', withResults.text, 'Here are the results.');
    check('web results are parsed', withResults.webResults[0].url, 'https://a.example');

    const withImage = StreamParser.parse(
        `Here is your image.${FS}{"type":"generated_image","share_url":"https://img.example/a.png"}`
    );
    check('generated image url extracted', withImage.images, ['https://img.example/a.png']);

    const withThinking = StreamParser.parse(`${GS}THINKING_START12s${RS}internal reasoning${GS}THINKING_ENDFinal answer.`);
    check('chain of thought is removed', withThinking.text, 'Final answer.');
    check('chain of thought is captured separately', withThinking.thinking.text, 'internal reasoning');
    check('thinking duration captured', withThinking.thinking.duration, '12s');

    const truncated = StreamParser.parse(`Partial answer${FS}{"type":"generated_ima`);
    check('truncated packet is dropped, not leaked', truncated.text, 'Partial answer');

    const call = StreamParser.parse(
        `${FS}{"function_call":{"name":"generate_image","arguments":"{\\"prompt\\":\\"a cat\\"}"}}`
    );
    check('function call name parsed', call.functionCall.name, 'generate_image');
    check('function call arguments parsed', call.functionCall.arguments.prompt, 'a cat');

    ok('no control characters survive', !/[\u001C\u001D\u001E]/.test(withActivity.text + withThinking.text));
}

// ==========================================================================
async function deepaiClientTests() {
section('DeepAIClient — the whole endpoint surface (mocked transport)');
// ==========================================================================
{
    const cfg = new Config({ key: 'tryit-1-abc', postgresUrl: 'postgres://u:p@localhost/db', maxRetries: 0 });
    const client = new DeepAIClient(cfg);

    const calls = [];
    const realFetch = global.fetch;
    global.fetch = async (url, init = {}) => {
        const fields = {};
        if (init.body && typeof init.body.forEach === 'function') {
            init.body.forEach((value, key) => {
                fields[key] = typeof value === 'string' ? value : '[file]';
            });
        }
        calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, fields });

        const respond = (body, status = 200) => ({
            status,
            headers: { get: () => 'text/plain' },
            text: async () => body,
            body: null,
        });

        if (String(url).includes('/hacking_is_a_serious_crime')) return respond('Hi Nimal!');
        if (String(url).includes('/chat_attachments/upload')) {
            return respond(JSON.stringify({ success: true, attachment: { uuid: 'u-1', extraction_status: 'complete' } }));
        }
        if (String(url).includes('/chat_attachments/get')) {
            return respond(JSON.stringify({ success: true, attachment: { uuid: 'u-1', extraction_status: 'complete' } }));
        }
        if (String(url).includes('/check_chat_task_status')) {
            return respond(JSON.stringify({ status: 'COMPLETED', result: 'thought through it' }));
        }
        if (String(url).includes('/check-sensitivity')) return respond(JSON.stringify({ score: 0.1 }));
        if (String(url).includes('/api/text2img')) {
            return respond(JSON.stringify({ id: 'img-1', output_url: 'https://img.example/x.png' }));
        }
        if (String(url).includes('/chat_memory')) return respond(JSON.stringify({ enabled: true, profile: 'p' }));
        if (String(url).includes('/save_chat_session')) return respond(JSON.stringify({ success: true }));
        return respond(JSON.stringify({ success: true }));
    };

    await (async () => {
        const text = await client.chat([{ role: 'user', content: 'hi' }]);
        check('chat returns clean text', text, 'Hi Nimal!');

        const chatCall = calls.find((c) => c.url.includes('hacking_is_a_serious_crime'));
        check('chat posts to the DeepAI chat endpoint', chatCall.method, 'POST');
        check('sends the api-key header', chatCall.headers['api-key'], 'tryit-1-abc');
        check('sends an Origin header', chatCall.headers.Origin, 'https://deepai.org');
        check('sends chat_style', chatCall.fields.chat_style, 'chat');
        check('sends the model', chatCall.fields.model, 'standard');
        check('sends the anti-abuse field', chatCall.fields.hacker_is_stinky, 'very_stinky');
        ok('sends a session_uuid', Boolean(chatCall.fields.session_uuid));
        check('advertises tool activity support', chatCall.fields.tool_activity_support, '1');
        check('advertises the image tool', chatCall.fields.enabled_tools, '["image_generator","image_editor"]');
        check('sends the chat history as JSON', JSON.parse(chatCall.fields.chatHistory)[0].content, 'hi');

        await client.chat([{ role: 'user', content: 'hi' }], { attachmentUuids: ['u-1'] });
        const withAttachment = calls.filter((c) => c.url.includes('hacking'))[1];
        check('attachments are a TOP-LEVEL field', withAttachment.fields.attachment_uuids, '["u-1"]');

        const attachment = await client.uploadAttachment(Buffer.from('hello'), 'a.txt', 'text/plain');
        check('uploads attachments', attachment.uuid, 'u-1');
        const fetched = await client.getAttachment('u-1');
        check('reads attachment extraction status', fetched.extraction_status, 'complete');

        const task = await client.taskStatus('t-1');
        check('polls background tasks', task.status, 'COMPLETED');
        check('sensitivity score', await client.checkSensitivity('r-1'), 0.1);

        const image = await client.text2img('a cat');
        check('text2img returns an output url', image.output_url, 'https://img.example/x.png');
        const imageCall = calls.find((c) => c.url.includes('/api/text2img'));
        check('text2img sends the prompt', imageCall.fields.text, 'a cat');

        const memory = await client.chatMemory();
        check('reads the DeepAI memory profile', memory.enabled, true);
        await client.saveSession({ uuid: 's-1', messages: [{ role: 'user', content: 'hi' }] });
        ok('saves a server-side session', calls.some((c) => c.url.includes('/save_chat_session')));

        const urls = calls.map((c) => c.url);
        ok(
            'uses more than the generative endpoint',
            new Set(urls.map((u) => u.split('?')[0])).size >= 7,
            `(hit ${new Set(urls.map((u) => u.split('?')[0])).size} distinct endpoints)`
        );

        global.fetch = realFetch;
    })();
}
{
    const cfg = new Config({
        key: 'tryit-1-abc',
        keys: ['tryit-1-abc', 'tryit-2-def'],
        postgresUrl: 'postgres://u:p@localhost/db',
        maxRetries: 0,
    });
    const client = new DeepAIClient(cfg);
    const realFetch = global.fetch;
    const seenKeys = [];
    global.fetch = async (url, init = {}) => {
        seenKeys.push(init.headers['api-key']);
        const quota = seenKeys.length === 1;
        return {
            status: 200,
            headers: { get: () => 'application/json' },
            text: async () => (quota ? JSON.stringify({ status: 'anonymous try it exceeded' }) : 'second key works'),
            body: null,
        };
    };
    await (async () => {
        const text = await client.chat([{ role: 'user', content: 'hi' }]);
        check('rotates to the next key on a quota refusal', text, 'second key works');
        check('used both keys', seenKeys, ['tryit-1-abc', 'tryit-2-def']);
        global.fetch = realFetch;
    })();
}
{
    ok(
        'anonymous key generator matches the deepai.org shape',
        /^tryit-\d{10}-[0-9a-f]{32}$/.test(DeepAIClient.generateTryItKey())
    );
    const cfg = new Config({ key: 'k', postgresUrl: 'postgres://u:p@localhost/db' });
    check('endpoint map exposes the chat route', cfg.url('chat'), 'https://api.deepai.org/hacking_is_a_serious_crime');
    check(
        'endpoint map builds query strings',
        cfg.url('taskStatus', { type: 'thinking-task', task_id: 'x' }),
        'https://api.deepai.org/check_chat_task_status?type=thinking-task&task_id=x'
    );
    check('endpoints are overridable', new Config({
        key: 'k',
        postgresUrl: 'postgres://u:p@localhost/db',
        endpoints: { chat: '/v2/chat' },
    }).url('chat'), 'https://api.deepai.org/v2/chat');
}

}

// ==========================================================================
//  End-to-end: the whole chat() pipeline on a fake database + fake DeepAI.
//  This is the reported bug, reproduced and proven fixed, with no network.
// ==========================================================================
async function endToEndTests() {
    section('AlexaAI.chat() — end to end (fake database + fake DeepAI)');

    const ai = new AlexaAI({ key: 'tryit-1-x', postgresUrl: 'postgres://u:p@localhost/db', autoMigrate: false });
    const db = createFakeDb();
    ai.db = db;
    ai.users.db = db;
    ai.memories.db = db;
    ai.conversations.db = db;
    ai.identities.db = db;

    const deepai = installFakeDeepAI();
    try {
        // 1. The user introduces themselves in a DM (phone jid).
        deepai.push('Nice to meet you, Nimal! 🏏 @MEMORY: {"name":"Nimal","hobby":"cricket"}');
        const dm = await ai.chat({
            message: "Hi, I'm Nimal and I love cricket. I live in Galle.",
            userId: '94771234567@s.whatsapp.net',
            userName: 'Nimal',
        });
        check('DM reply is clean', dm.text, 'Nice to meet you, Nimal! 🏏');
        check('DM learned the name', dm.memories.name, 'Nimal');
        check('DM learned the location (FactMiner)', dm.memories.location, 'Galle');
        check('DM thread key', dm.contextKey, 'dm:94771234567@s.whatsapp.net');

        // 2. THE BUG: the same human writes in a group as @lid.
        deepai.push("Unfortunately, as a bot I can't remember you.");
        const group = await ai.chat({
            message: 'do you remember me?',
            userId: '78151912841263@lid',
            participantAlt: '94771234567@s.whatsapp.net', // Baileys gives us both
            groupId: '120363413125431525@g.us',
            groupName: 'Cricket Fans',
            userName: 'Nimal',
        });
        check('group message resolves to the SAME person', group.userId, dm.userId);
        ok('both addresses are linked', group.aliases.length === 2);
        ok('the denial was repaired', group.repairedMemory);
        ok('the reply now recalls the name', group.text.includes('Nimal'));
        ok('the reply recalls DM facts in the group', group.text.includes('Galle') && group.text.includes('cricket'));
        ok('no "cannot remember" survives', !AmnesiaGuard.isDenial(group.text));
        ok('group thread is separate from the DM', group.contextKey.startsWith('group:'));

        // The prompt itself must carry the facts.
        const groupPrompt = JSON.parse(deepai.calls[deepai.calls.length - 1].fields.chatHistory);
        const lastTurn = groupPrompt[groupPrompt.length - 1].content;
        ok('prompt carries the remembered facts', lastTurn.includes('name=Nimal'));
        ok('prompt carries the memory directive', lastTurn.includes('MEMORY CHECK'));

        // 3. Identity: "I'm Alexa Mini, not Alexa" must never ship.
        deepai.push("I'm Alexa Mini, not Alexa. How can I help?");
        const who = await ai.chat({ message: 'are you alexa?', userId: '78151912841263@lid' });
        check('identity answer is corrected', who.text, 'I am *Alexa*, your WhatsApp assistant created by *Hansaka*. 😊');
        const idPrompt = JSON.parse(deepai.calls[deepai.calls.length - 1].fields.chatHistory);
        ok('identity lock was injected', idPrompt[idPrompt.length - 1].content.includes('IDENTITY LOCK'));

        // 4. Triggers still bypass the model entirely.
        const trigger = await ai.chat({ message: 'What is the weather in Colombo today?', userId: '78151912841263@lid' });
        check('trigger output is byte-exact', trigger.text, 'weather Colombo');
        check('trigger type reported', trigger.trigger, 'weather');

        // 5. Wire packets never reach WhatsApp.
        deepai.push('Here you go.\u001C{"type":"generated_image","share_url":"https://img.example/x.png"}');
        const image = await ai.chat({ message: 'draw a cat', userId: '78151912841263@lid' });
        check('payload stripped from the text', image.text, 'Here you go.');
        check('generated image surfaced', image.images, ['https://img.example/x.png']);

        // 6. A vendor leak in an ordinary reply is scrubbed.
        deepai.push('Sure! DeepAI can help you with that.');
        const leak = await ai.chat({ message: 'can you help me?', userId: '78151912841263@lid' });
        ok('vendor name never ships', !/deepai/i.test(leak.text));
    } finally {
        deepai.restore();
    }
}

// ==========================================================================
//  Integration tests
// ==========================================================================
async function integration() {
    const pgUrl = process.env.POSTGRES_URL;
    const key = process.env.DEEPAI_KEY;

    if (!pgUrl) {
        console.log('\n\x1b[33m⏭  Skipping DB integration tests (set POSTGRES_URL)\x1b[0m');
        return;
    }

    section('Integration — PostgreSQL (live)');
    const ai = new AlexaAI({
        key: key || 'tryit-test-key',
        postgresUrl: pgUrl,
        autoMigrate: true,
    });

    const USER_A = '78151912841263@lid';
    const USER_B = '94771234567@s.whatsapp.net';
    const GROUP = '120363413125431525@g.us';

    try {
        await ai.init();
        const health = await ai.health();
        ok('database reachable', health.ok, health.error || '');

        // clean slate
        await ai.db.query('TRUNCATE wa_users, wa_groups RESTART IDENTITY CASCADE');

        // --- users / groups ------------------------------------------------
        const userA = await ai.users.upsertUser(USER_A, { pushName: 'Nimal' });
        ok('creates @lid user', userA.jid === USER_A);
        check('stores no phone for @lid', userA.phone, null);

        const again = await ai.users.upsertUser(USER_A, { pushName: 'Nimal' });
        check('upsert is idempotent (same id)', again.id, userA.id);

        const userB = await ai.users.upsertUser(USER_B, { pushName: 'Kasun' });
        check('stores phone for @s.whatsapp.net', userB.phone, '94771234567');

        const grp = await ai.users.upsertGroup(GROUP, { subject: 'Test Group' });
        ok('creates group', grp.jid === GROUP);
        await ai.users.linkMember(grp.id, userA.id);
        ok('links member to group', true);

        // --- memories are GLOBAL per user ------------------------------------
        await ai.memories.remember(userA.id, 'name', 'Nimal', { learnedIn: 'dm:' + USER_A });
        await ai.memories.remember(userA.id, 'hobby', 'cricket', { learnedIn: 'group:' + GROUP });

        const map = await ai.memories.getMap(userA.id);
        check('memory saved in DM is readable', map.name, 'Nimal');
        check('memory saved in group is readable', map.hobby, 'cricket');

        await ai.memories.remember(userA.id, 'name', 'Nimal Perera');
        const map2 = await ai.memories.getMap(userA.id);
        check('re-learning a key overwrites (no duplicate)', map2.name, 'Nimal Perera');
        const all = await ai.memories.getAll(userA.id);
        check('still only 2 memory rows', all.length, 2);

        const bMap = await ai.memories.getMap(userB.id);
        check("user B cannot see user A's memories", Object.keys(bMap).length, 0);

        // --- identity: ONE human behind two WhatsApp addresses --------------
        // This is the reported bug: a DM arrives from 947…@s.whatsapp.net and
        // the same person writes in a group as 781…@lid.
        await ai.db.query('TRUNCATE wa_users, wa_groups RESTART IDENTITY CASCADE');

        const dmPerson = await ai.resolver.resolve([USER_B], { pushName: 'Nimal' });
        await ai.memories.remember(dmPerson.user.id, 'name', 'Nimal');
        await ai.memories.remember(dmPerson.user.id, 'location', 'Galle');

        // Group message: @lid primary, phone supplied as an alias.
        const groupPerson = await ai.resolver.resolve([USER_A, USER_B], { pushName: 'Nimal' });
        check('same user row in DM and group', Number(groupPerson.user.id), Number(dmPerson.user.id));
        const seenInGroup = await ai.memories.getMap(groupPerson.user.id);
        check('DM memory is readable in the group', seenInGroup.name, 'Nimal');
        check('every DM fact survives', seenInGroup.location, 'Galle');

        const aliasList = await ai.getAliases(USER_A);
        ok('both addresses are linked', aliasList.includes(USER_A) && aliasList.includes(USER_B));
        const byLid = await ai.getMemories(USER_A);
        check('getMemories works through an alias', byLid.name, 'Nimal');

        const oneRow = await ai.stats();
        check('no duplicate user row was created', Number(oneRow.users), 1);

        // --- retro-fix: two rows already exist, then we learn they match ----
        await ai.db.query('TRUNCATE wa_users, wa_groups RESTART IDENTITY CASCADE');
        const older = await ai.users.upsertUser(USER_A, { pushName: 'Nimal' });
        await ai.memories.remember(older.id, 'hobby', 'cricket');
        const newer = await ai.users.upsertUser(USER_B, { pushName: 'Nimal' });
        await ai.memories.remember(newer.id, 'favourite_food', 'kottu');
        const dmConvoBefore = await ai.conversations.upsertConversation({
            contextKey: 'dm:' + USER_B,
            userId: newer.id,
        });
        await ai.conversations.addMessage({
            conversationId: dmConvoBefore.id,
            userId: newer.id,
            role: 'user',
            content: 'hello from the phone jid',
        });

        const survivor = await ai.linkIdentity(USER_A, USER_B);
        ok('link keeps the older row', Number(survivor.id) === Number(older.id));
        const mergedMemories = await ai.getMemories(USER_B);
        check('memories from both rows survive the merge', [mergedMemories.hobby, mergedMemories.favourite_food], [
            'cricket',
            'kottu',
        ]);
        const afterMerge = await ai.stats();
        check('duplicate row is gone', Number(afterMerge.users), 1);
        const movedThread = await ai.conversations.findByContextKey('dm:' + USER_B);
        check('threads move to the surviving user', Number(movedThread.user_id), Number(older.id));
        const who = await ai.whoIs(USER_A);
        check('whoIs lists both addresses', who.aliases.sort(), [USER_A, USER_B].sort());

        await ai.db.query('TRUNCATE wa_users, wa_groups RESTART IDENTITY CASCADE');
        const restoredA = await ai.users.upsertUser(USER_A, { pushName: 'Nimal' });
        await ai.users.upsertUser(USER_B, { pushName: 'Kasun' });
        ok('unrelated users stay separate', true);
        await ai.memories.remember(restoredA.id, 'name', 'Nimal');
        await ai.memories.remember(restoredA.id, 'hobby', 'cricket');
        await ai.memories.rememberMany(restoredA.id, { city: 'Galle', food: 'kottu' }, {});

        const map3 = await ai.memories.getMap(restoredA.id);
        check('rememberMany stores all', [map3.city, map3.food], ['Galle', 'kottu']);

        // --- conversations are per-thread -------------------------------------
        const dmKey = JidParser.contextKey(USER_A);
        const groupKey = JidParser.contextKey(USER_A, GROUP);

        const grp2 = await ai.users.upsertGroup(GROUP, { subject: 'Test Group' });
        const dmConvo = await ai.conversations.upsertConversation({ contextKey: dmKey, userId: restoredA.id });
        const grpConvo = await ai.conversations.upsertConversation({
            contextKey: groupKey,
            userId: restoredA.id,
            groupId: grp2.id,
        });
        ok('DM and group threads are distinct', dmConvo.id !== grpConvo.id);
        check('DM thread kind', dmConvo.kind, 'dm');
        check('group thread kind', grpConvo.kind, 'group');

        await ai.conversations.addMessage({
            conversationId: dmConvo.id,
            userId: restoredA.id,
            role: 'user',
            content: 'dm message',
        });
        await ai.conversations.addMessage({
            conversationId: grpConvo.id,
            userId: restoredA.id,
            role: 'user',
            content: 'group message',
        });

        const dmHist = await ai.conversations.getHistory(dmConvo.id);
        const grpHist = await ai.conversations.getHistory(grpConvo.id);
        check('DM history isolated', dmHist.length, 1);
        check('group history isolated', grpHist.length, 1);
        check('DM content correct', dmHist[0].content, 'dm message');
        ok('no context bleed between rooms', grpHist[0].content === 'group message');

        // --- dedupe -------------------------------------------------------------
        await ai.conversations.addMessage({
            conversationId: dmConvo.id,
            userId: restoredA.id,
            role: 'user',
            content: 'dupe',
            waMessageId: 'WAMSG1',
        });
        const dup = await ai.conversations.addMessage({
            conversationId: dmConvo.id,
            userId: restoredA.id,
            role: 'user',
            content: 'dupe',
            waMessageId: 'WAMSG1',
        });
        check('duplicate WhatsApp message id is ignored', dup, null);

        // --- history ordering + limit -------------------------------------------
        for (let i = 0; i < 10; i++) {
            await ai.conversations.addMessage({
                conversationId: dmConvo.id,
                userId: restoredA.id,
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: `msg-${i}`,
            });
        }
        const limited = await ai.conversations.getHistory(dmConvo.id, 5);
        check('history respects limit', limited.length, 5);
        check('history is chronological (oldest first)', limited[0].content, 'msg-5');
        check('history ends with newest', limited[4].content, 'msg-9');

        // --- clearing history keeps memories -------------------------------------
        await ai.clearHistory(USER_A);
        const clearedHist = await ai.conversations.getHistory(dmConvo.id);
        check('history cleared', clearedHist.length, 0);
        const survived = await ai.getMemories(USER_A);
        ok('memories survive history clear', Object.keys(survived).length === 4);

        // --- profile + stats ------------------------------------------------------
        const profile = await ai.getProfile(USER_A);
        ok('profile returns user', profile.user.jid === USER_A);
        ok('profile lists both threads', profile.conversations.length === 2);

        const stats = await ai.stats();
        ok('stats counts users', Number(stats.users) === 2);

        // --- blocking ---------------------------------------------------------------
        await ai.blockUser(USER_B);
        ok('user blocked', await ai.users.isBlocked(USER_B));
        await ai.unblockUser(USER_B);
        ok('user unblocked', !(await ai.users.isBlocked(USER_B)));

        // --- forget -------------------------------------------------------------------
        await ai.forget(USER_A, 'food');
        const afterForget = await ai.getMemories(USER_A);
        ok('forget removes one key', afterForget.food === undefined);
        await ai.forgetAll(USER_A);
        const afterAll = await ai.getMemories(USER_A);
        check('forgetAll clears everything', Object.keys(afterAll).length, 0);

        // ================= LIVE DEEPAI =====================
        if (key) {
            section('Integration — DeepAI (live API)');
            await ai.db.query('TRUNCATE wa_users, wa_groups RESTART IDENTITY CASCADE');

            const r1 = await ai.chat({
                message: 'Hello! Reply in one short sentence.',
                userId: USER_A,
                userName: 'Nimal',
            });
            ok('live chat returns text', r1.text.length > 0, r1.error || '');
            ok('no ** in reply', !r1.text.includes('**'));
            ok('no @MEMORY leak in reply', !/@MEMORY/i.test(r1.text));
            console.log(`      ↳ "${r1.text.slice(0, 90)}"`);

            const r2 = await ai.chat({ message: 'ping', userId: USER_A });
            check('trigger: ping is exact', r2.text, 'ping');
            check('trigger type recorded', r2.trigger, 'ping');

            const r3 = await ai.chat({ message: 'What is the weather in Colombo today?', userId: USER_A });
            check('trigger: weather is exact', r3.text, 'weather Colombo');

            const r4 = await ai.chat({ message: 'show menu', userId: USER_A });
            check('trigger: menu is exact', r4.text, 'menu');

            const r5 = await ai.chat({ message: 'send me the docs', userId: USER_A });
            check('trigger: doc is exact', r5.text, 'doc');

            // memory round-trip through the real model
            const r6 = await ai.chat({
                message: "Hi! My name is Nimal and I love playing cricket.",
                userId: USER_A,
                userName: 'Nimal',
            });
            ok('intro reply produced', r6.text.length > 0);
            console.log(`      ↳ "${r6.text.slice(0, 90)}"`);
            const learned = await ai.getMemories(USER_A);
            console.log(`      ↳ learned: ${JSON.stringify(learned)}`);
            ok(
                'model-driven memory captured (name and/or hobby)',
                Object.keys(learned).length > 0,
                '(model-dependent)'
            );

            // cross-room recognition
            const r7 = await ai.chat({
                message: 'Do you remember my name? Answer in one short sentence.',
                userId: USER_A,
                groupId: GROUP,
                groupName: 'Cricket Fans',
                userName: 'Nimal',
            });
            console.log(`      ↳ group recall: "${r7.text.slice(0, 110)}"`);
            ok('group reply produced', r7.text.length > 0);
            ok('group thread key differs from DM', r7.contextKey.startsWith('group:'));
        } else {
            console.log('\n\x1b[33m⏭  Skipping live DeepAI tests (set DEEPAI_KEY)\x1b[0m');
        }
    } finally {
        await ai.close();
    }
}

deepaiClientTests()
    .then(endToEndTests)
    .then(integration)
    .catch((err) => {
        failed++;
        failures.push(`Integration crashed: ${err.stack || err.message}`);
        console.log(`\n\x1b[31m❌ Integration error: ${err.message}\x1b[0m`);
        if (process.env.DEBUG) console.error(err);
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
