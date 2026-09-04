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
    ResponseFormatter,
    TriggerDetector,
    MemoryRepository,
    PromptBuilder,
    Config,
} = require('../index');

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
    check('first turn is the persona (user role)', msgs[0].role, 'user');
    ok('persona text present', msgs[0].content.includes('You are Alexa'));
    ok('memories injected', msgs[0].content.includes('Nimal') && msgs[0].content.includes('cricket'));
    ok('group context injected', msgs[0].content.includes('GROUP'));
    check('second turn is assistant ack', msgs[1].role, 'assistant');
    ok('last turn contains the live message', msgs[msgs.length - 1].content.endsWith('hello'));
    ok('recall note precedes the live message', msgs[msgs.length - 1].content.includes('Remembered facts'));
    ok('recall note lists known facts', msgs[msgs.length - 1].content.includes('name=Nimal'));
    ok('no system role is used (DeepAI ignores it)', !msgs.some((m) => m.role === 'system'));
    check('history preserved in order', [msgs[2].content, msgs[3].content], ['earlier', 'reply']);
}
{
    const cfg = new Config({ key: 'k', postgresUrl: 'postgres://u:p@localhost/db' });
    const pb = new PromptBuilder(cfg);
    const msgs = pb.build({ message: 'hi', history: [{ role: 'assistant', content: 'orphan' }] });
    ok('drops leading assistant turn', !msgs.slice(2, -1).some((m) => m.content === 'orphan'));
    check('no recall note when there are no memories', msgs[msgs.length - 1].content, 'hi');
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

        await ai.memories.rememberMany(userA.id, { city: 'Galle', food: 'kottu' }, {});
        const map3 = await ai.memories.getMap(userA.id);
        check('rememberMany stores all', [map3.city, map3.food], ['Galle', 'kottu']);

        // --- conversations are per-thread -------------------------------------
        const dmKey = JidParser.contextKey(USER_A);
        const groupKey = JidParser.contextKey(USER_A, GROUP);

        const dmConvo = await ai.conversations.upsertConversation({ contextKey: dmKey, userId: userA.id });
        const grpConvo = await ai.conversations.upsertConversation({
            contextKey: groupKey,
            userId: userA.id,
            groupId: grp.id,
        });
        ok('DM and group threads are distinct', dmConvo.id !== grpConvo.id);
        check('DM thread kind', dmConvo.kind, 'dm');
        check('group thread kind', grpConvo.kind, 'group');

        await ai.conversations.addMessage({
            conversationId: dmConvo.id,
            userId: userA.id,
            role: 'user',
            content: 'dm message',
        });
        await ai.conversations.addMessage({
            conversationId: grpConvo.id,
            userId: userA.id,
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
            userId: userA.id,
            role: 'user',
            content: 'dupe',
            waMessageId: 'WAMSG1',
        });
        const dup = await ai.conversations.addMessage({
            conversationId: dmConvo.id,
            userId: userA.id,
            role: 'user',
            content: 'dupe',
            waMessageId: 'WAMSG1',
        });
        check('duplicate WhatsApp message id is ignored', dup, null);

        // --- history ordering + limit -------------------------------------------
        for (let i = 0; i < 10; i++) {
            await ai.conversations.addMessage({
                conversationId: dmConvo.id,
                userId: userA.id,
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

integration()
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
