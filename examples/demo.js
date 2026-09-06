'use strict';

/**
 * Live demo of the AI engine.
 *
 *   POSTGRES_URL=postgres://user:pass@host:5432/db \
 *   DEEPAI_KEY=tryit-xxxxx \
 *   node examples/demo.js
 *
 * Walks through the core scenario the engine is built for:
 *   1. user introduces themselves in a DM
 *   2. the same user is recognised in group A
 *   3. and in group B
 *   4. a different user in the same group stays isolated
 *   5. the four strict trigger commands return byte-exact output
 */

const AlexaAI = require('../index');

const KEY = process.env.DEEPAI_KEY || 'tryit-6809613270-caa24a28a55047b221b1123dd19c696a';
const PG = process.env.POSTGRES_URL;

if (!PG) {
    console.error('Set POSTGRES_URL first, e.g.\n  POSTGRES_URL=postgres://postgres:pass@localhost:5432/alexa node examples/demo.js');
    process.exit(1);
}

const NIMAL = '78151912841263@lid';
const KASUN = '94770000000@s.whatsapp.net';
const GROUP_A = '120363413125431525@g.us';
const GROUP_B = '120363999888777666@g.us';

const line = (c = '─') => console.log(c.repeat(70));

async function main() {
    const ai = new AlexaAI({ key: KEY, postgresUrl: PG });
    await ai.init();

    console.log('\n🤖  Alexa AI — live demo');
    line('═');
    console.log('config:', ai.config.toJSON());

    // Fresh start for a repeatable demo.
    if (process.env.RESET !== 'false') {
        await ai.db.query('TRUNCATE wa_users, wa_groups RESTART IDENTITY CASCADE');
    }

    const say = async (label, params) => {
        const where = params.groupId ? `GROUP ${params.groupName}` : 'DM';
        const result = await ai.chat(params);
        line();
        console.log(`${label}  [${where}]`);
        console.log(`  👤 ${params.userName}: ${params.message}`);
        console.log(`  🤖 Alexa: ${result.text}`);
        if (result.trigger) console.log(`  ⚡ trigger: ${result.trigger} (exact output)`);
        if (Object.keys(result.memories).length) {
            console.log(`  🧠 learned: ${JSON.stringify(result.memories)}`);
        }
        console.log(`  ⏱  ${result.latencyMs}ms   thread: ${result.contextKey}`);
        return result;
    };

    // 1 — introduction in a DM
    await say('1️⃣  Introduction', {
        message: "Hi! I'm Nimal and I love playing cricket. I live in Galle.",
        userId: NIMAL,
        userName: 'Nimal',
    });
    console.log(`\n  📇 stored memories: ${JSON.stringify(await ai.getMemories(NIMAL))}`);

    // 2 — recognised in group A
    await say('2️⃣  Same person, group A', {
        message: 'Do you remember my name and where I live?',
        userId: NIMAL,
        groupId: GROUP_A,
        groupName: 'Cricket Fans',
        userName: 'Nimal',
    });

    // 3 — recognised in a different group
    await say('3️⃣  Same person, group B', {
        message: 'What is my hobby?',
        userId: NIMAL,
        groupId: GROUP_B,
        groupName: 'Office Chat',
        userName: 'Nimal',
    });

    // 4 — a different user is isolated
    await say('4️⃣  Different user, same group', {
        message: 'Do you know my name?',
        userId: KASUN,
        groupId: GROUP_A,
        groupName: 'Cricket Fans',
        userName: 'Kasun',
    });
    console.log(`\n  📇 Kasun memories: ${JSON.stringify(await ai.getMemories(KASUN))}  ← correctly empty`);

    // 5 — strict trigger commands
    line('═');
    console.log('5️⃣  Strict trigger commands (must be byte-exact)\n');
    for (const msg of [
        'What is the weather in Colombo today?',
        'Is it raining in Kandy right now?',
        'show menu',
        'ping',
        'send me the docs',
    ]) {
        const r = await ai.chat({ message: msg, userId: NIMAL, userName: 'Nimal' });
        console.log(`  "${msg}"\n     -> ${JSON.stringify(r.text)}  ${r.trigger ? '✅' : '❌ (went to AI)'}`);
    }

    // 6 — formatting + math
    line('═');
    console.log('6️⃣  Math + WhatsApp formatting\n');
    const math = await ai.chat({
        message: 'Calculate the area of a circle with radius 7',
        userId: NIMAL,
        userName: 'Nimal',
    });
    console.log(`  🤖 ${math.text}`);
    console.log(`  contains forbidden "**": ${math.text.includes('**') ? '❌ yes' : '✅ no'}`);

    // 7 — stats
    line('═');
    console.log('7️⃣  Engine stats\n');
    console.log(' ', await ai.stats());

    const profile = await ai.getProfile(NIMAL);
    console.log('\n  Nimal threads:');
    profile.conversations.forEach((c) => console.log(`    • ${c.context_key} (${c.message_count} msgs)`));
    console.log('\n  Nimal memories:');
    profile.memories.forEach((m) => console.log(`    • ${m.key} = ${m.value}   [learned in ${m.learned_in}]`));

    line('═');
    console.log('✅ demo complete\n');
    await ai.close();
}

main().catch((err) => {
    console.error('\n❌ demo failed:', err.message);
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
});
