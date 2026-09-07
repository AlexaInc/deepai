#!/usr/bin/env node
'use strict';

/**
 * LIVE DeepAI verification — the real network counterpart of the offline
 * suite. Run it from any host that can reach api.deepai.org (the Arena
 * sandbox blocks that domain, so use your own machine or the bot server):
 *
 *   DEEPAI_KEY=your-account-key node test/live-api.js   # account key
 *   npm run test:live -- --key=your-account-key         # same thing
 *   node test/live-api.js --tryit                        # minted free keys only
 *   node test/live-api.js --key=… --tryit                # both
 *
 * What it proves, in order:
 *   1. the /chat page is reachable and the anonymous-key salt can be read
 *   2. a MINTED tryit key (hash protocol, not random hex) can chat
 *   3. a bare { text } /api/text2img post is refused on free keys (expected)
 *   4. the same key + the browser fields (generation_source=chat …) draws
 *   5. the account key: chat, text2img, generateImage() end-to-end,
 *      sentiment + summarization, anonymous attachment upload
 *
 * Exit code 0 = every applicable check passed.
 */

const AlexaAI = require('../index');
const DeepAIClient = require('../src/core/DeepAIClient');

// 1x1 PNG used for the attachment-upload check.
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
);

const args = process.argv.slice(2);
const argOf = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
};
const accountKey = argOf('key') || process.env.DEEPAI_KEY || process.env.DEEPAI_API_KEY || null;
const alsoTryit = args.includes('--tryit') || !accountKey;

const results = [];
function record(name, status, detail = '') {
    results.push({ name, status, detail });
    const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⏭ ';
    console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ''}`);
}
function summary() {
    const passed = results.filter((r) => r.status === 'PASS').length;
    const failed = results.filter((r) => r.status === 'FAIL').length;
    const skipped = results.filter((r) => r.status === 'SKIP').length;
    const unreachable = failed > 0 && results.filter((r) => r.status === 'FAIL').every((r) => /network|fetch failed|timed out/i.test(r.detail));
    console.log('\n──────────────────────────────────────────────');
    console.log(`  ${passed} passed   ${failed} failed   ${skipped} skipped`);
    if (unreachable) {
        console.log('  ⚠  every request failed at the NETWORK level — this host cannot');
        console.log('     reach api.deepai.org (firewall / sandbox egress filter).');
        console.log('     The results are inconclusive: re-run from an open network.');
    } else if (failed) {
        console.log('  ❌ FAILURES ABOVE — the API answered, so these are real.');
    } else {
        console.log('  ✅ All reachable features work.');
    }
    process.exitCode = failed ? 1 : 0;
}
const ms = (t0) => `${Date.now() - t0}ms`;

function makeEngine(key) {
    // deepai.* methods never touch PostgreSQL; the constructor only needs a
    // syntactically valid URL.
    return new AlexaAI({ key, postgresUrl: 'postgres://live:test@localhost/live', autoMigrate: false, debug: false });
}
const shortKey = (k) => (k ? `${String(k).slice(0, 12)}…` : '(none)');

(async () => {
    console.log('\x1b[1mDeepAI live verification\x1b[0m');
    console.log(`account key: ${shortKey(accountKey)}   minted tryit key: ${alsoTryit ? 'yes' : 'no'}\n`);

    // ---- 0. the anonymous-key salt --------------------------------------
    console.log('\x1b[1manonymous-key protocol\x1b[0m');
    {
        const saltProbe = makeEngine(accountKey || 'probe');
        const t0 = Date.now();
        try {
            const salt = await saltProbe.deepai.discoverTryItSalt();
            record(
                'tryit salt readable from the /chat page',
                salt ? 'PASS' : 'FAIL',
                salt ? `"${salt}" (${ms(t0)})` : 'page unreadable or minting script not found — known salts remain in use'
            );
        } catch (err) {
            record('tryit salt readable from the /chat page', 'FAIL', `network: ${err.message}`);
        }
        record(
            'minted key follows the hash protocol',
            /^tryit-\d{1,11}-[0-9a-f]{32}$/.test(saltProbe.deepai.mintTryItKey()) ? 'PASS' : 'FAIL',
            shortKey(saltProbe.deepai.mintTryItKey())
        );
    }

    const tryitEngine = alsoTryit ? makeEngine(DeepAIClient.generateTryItKey()) : null;
    if (alsoTryit) console.log(`\nminted tryit key: ${shortKey(tryitEngine.deepai.apiKey)}\n`);

    // ---- 1. free (minted) key -------------------------------------------
    if (alsoTryit) {
        console.log('\x1b[1mfree tier — minted tryit key\x1b[0m');
        {
            const t0 = Date.now();
            const health = await tryitEngine.deepaiHealth();
            record('chat works on a minted key', health.ok ? 'PASS' : 'FAIL', health.ok ? `"${health.reply}" (${ms(t0)})` : `${health.error}: ${health.message}`);
        }
        {
            const t0 = Date.now();
            try {
                await tryitEngine.deepai.text2img('a small red car, cartoon', {});
                record('bare { text } post is refused on free keys', 'FAIL', 'unexpectedly worked (fine — the free gate may be gone)');
            } catch (err) {
                const expected = /credits|exceeded|paid/i.test(err.message);
                record('bare { text } post is refused on free keys', expected ? 'PASS' : 'FAIL', `${err.code || err.message}: ${String(err.message).slice(0, 90)} (${ms(t0)})`);
            }
        }
        {
            const t0 = Date.now();
            try {
                const data = await tryitEngine.deepai.text2img('a small red car, cartoon', { generation_source: 'chat', width: '640', height: '640', image_generator_version: 'hd', quality: 'true' });
                record('browser-field post draws on a free key', data.output_url ? 'PASS' : 'FAIL', data.output_url ? `${data.output_url} (${ms(t0)})` : JSON.stringify(data).slice(0, 120));
            } catch (err) {
                record('browser-field post draws on a free key', 'FAIL', `${err.code || ''}: ${String(err.message).slice(0, 120)} (${ms(t0)})`);
            }
        }
        {
            const t0 = Date.now();
            const r = await tryitEngine.generateImage('a colourful three-wheeler in Galle at sunset');
            record('generateImage() end-to-end on a free key', r.ok ? 'PASS' : 'FAIL', r.ok ? `via ${r.via} → ${r.url} (${ms(t0)})` : `${r.error}: ${String(r.message).slice(0, 140)}`);
        }
    }

    // ---- 2. the account key ----------------------------------------------
    if (!accountKey) {
        record('account-key checks', 'SKIP', 'set DEEPAI_KEY (or --key=…) to run them');
    } else {
        console.log('\n\x1b[1maccount key\x1b[0m');
        const engine = makeEngine(accountKey);
        {
            const t0 = Date.now();
            const health = await engine.deepaiHealth();
            record('chat works', health.ok ? 'PASS' : 'FAIL', health.ok ? `"${health.reply}" (${ms(t0)})` : `${health.error}: ${health.message}`);
        }
        {
            const t0 = Date.now();
            try {
                const data = await engine.deepai.text2img('a small red car, cartoon', { width: '640', height: '640' });
                record('/api/text2img draws', data.output_url ? 'PASS' : 'FAIL', data.output_url ? `${data.output_url} (${ms(t0)})` : JSON.stringify(data).slice(0, 120));
            } catch (err) {
                record('/api/text2img draws', 'FAIL', `${err.code || ''}: ${String(err.message).slice(0, 120)} (${ms(t0)}) — no credits, or the key is invalid`);
            }
        }
        {
            const t0 = Date.now();
            const r = await engine.generateImage('a colourful three-wheeler in Galle at sunset');
            record('generateImage() end-to-end', r.ok ? 'PASS' : 'FAIL', r.ok ? `via ${r.via} → ${r.url} (${ms(t0)})` : `${r.error}: ${String(r.message).slice(0, 140)}`);
        }
        {
            const t0 = Date.now();
            try {
                const data = await engine.deepai.sentiment('I love this bot, it is wonderful!');
                record('/api/sentiment-analysis', data.output ? 'PASS' : 'FAIL', data.output ? `${JSON.stringify(data.output).slice(0, 90)} (${ms(t0)})` : JSON.stringify(data).slice(0, 120));
            } catch (err) {
                record('/api/sentiment-analysis', 'FAIL', `${err.code || ''}: ${String(err.message).slice(0, 120)} (${ms(t0)})`);
            }
        }
        {
            const t0 = Date.now();
            const r = await engine.summarizeText('Alexa is a WhatsApp assistant. She remembers people across chats. She lives in Colombo and speaks Sinhala and English.');
            record('summarizeText() (api or chat fallback)', r.ok ? 'PASS' : 'FAIL', r.ok ? `via ${r.via}: ${r.text.slice(0, 80).replace(/\n/g, ' ')} (${ms(t0)})` : `${r.error}: ${String(r.message).slice(0, 120)}`);
        }
        {
            const t0 = Date.now();
            try {
                const attachment = await engine.deepai.uploadAttachment(PNG, 'probe.png', 'image/png');
                const settled = await engine.deepai.getAttachment(attachment.uuid);
                record('anonymous attachment upload', attachment.uuid ? 'PASS' : 'FAIL', attachment.uuid ? `uuid ${attachment.uuid}, extraction ${settled?.extraction_status || attachment.extraction_status || '?'} (${ms(t0)})` : JSON.stringify(attachment).slice(0, 120));
            } catch (err) {
                record('anonymous attachment upload', 'FAIL', `${err.code || ''}: ${String(err.message).slice(0, 120)} (${ms(t0)})`);
            }
        }
    }

    summary();
})().catch((err) => {
    console.error('\nUnhandled failure:', err);
    process.exitCode = 1;
});
