#!/usr/bin/env node
'use strict';
/**
 * deepai-text2img.js — standalone, zero-dependency DeepAI text-to-image.
 * ============================================================================
 * WHY YOUR POSTMAN / NODE REQUEST FAILS BUT THE BROWSER PLAYGROUND WORKS:
 *
 *  1. The playground does NOT use your account key. Every click mints a fresh
 *     anonymous key:  tryit-<random digits>-<32 hex>
 *     where the hex is NOT random — it is a hash the server recomputes from
 *     your User-Agent header:
 *         H(UA + H(UA + H(UA + digits + "hackers_become_a_little_stinkier_every_time_they_hack")))
 *     A key with random hex, or a key copied from DevTools, gets:
 *         401 {"status":"Please pass a valid Api-Key in a HTTP header called \"Api-Key\""}
 *
 *  2. Anonymous keys are SINGLE-USE: one key == one request. Replaying the
 *     same key (Postman "Send" twice) fails with the same 401.
 *
 *  3. The request must be multipart/form-data (NOT JSON) and must carry an
 *     Origin header, or you get:
 *         401 {"status":"Please try this model on deepai.org"}
 *
 *  4. Registered free (non-Pro) account keys are refused for /api/*:
 *         402 {"status":"APIs are only available for Pro members in good standing..."}
 *     That one is an account limit — only a Pro key (or the anonymous route
 *     this script uses) can generate images.
 *
 * This script reproduces the browser request byte-for-byte: fresh valid key
 * per run, browser headers, form-data body, device cookie.
 *
 * USAGE
 *   node deepai-text2img.js "a cute orange cat"             # anonymous (free)
 *   node deepai-text2img.js "a cat" --out cat.jpg           # save to file
 *   node deepai-text2img.js "a cat" --device-id <cookieVal> # reuse browser device
 *   node deepai-text2img.js "a cat" --key <proKey>          # Pro account key
 *   node deepai-text2img.js "a cat" --aspect 16:9           # playground size
 *
 * Requires Node.js 18+ (global fetch). Run from a residential IP — DeepAI
 * soft-blocks free image generation from datacenter/VPN IPs with
 * "Please try this model on deepai.org".
 * ============================================================================
 */

const API_URL = 'https://api.deepai.org/api/text2img';
const SALT = 'hackers_become_a_little_stinkier_every_time_they_hack';
// Keep this EXACT string in sync with the User-Agent header below — the key
// hash is computed over it and the server recomputes it from the request.
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// deepai.org's key hash — ported verbatim from the site's generateIslandKey()
// (verified bit-identical against the live minified source). Do not "simplify"
// the bit twiddling; every |0, ~k and postfix decrement matters.
// ---------------------------------------------------------------------------
function islandHash(input) {
    const a = [];
    for (let b = 0; 64 > b; ) a[b] = 0 | (4294967296 * Math.sin(++b % Math.PI));
    let d, e, f, g = [(d = 1732584193), (e = 4023233417), ~d, ~e], h = [];
    const l = unescape(encodeURI(input)) + '';
    let k = l.length;
    let c = (--k / 4 + 2) | 15;
    for (h[--c] = 8 * k; ~k; ) h[k >> 2] |= l.charCodeAt(k) << (8 * k--);
    for (let b = 0, m = 0; b < c; b += 16) {
        for (k = g; 64 > m; k = [ (f = k[3]), d + (((f = k[0] + [d & e | ~d & f, f & d | ~f & e, d ^ e ^ f, e ^ (d | ~f)][(k = m >> 4)] + a[m] + ~~h[b | [m, 5 * m + 1, 3 * m + 5, 7 * m][k] & 15]) << (k = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21][4 * k + (m++ % 4)])) | (f >>> -k)), d, e ]) {
            d = k[1] | 0;
            e = k[2];
        }
        for (m = 4; m; ) g[--m] += k[m];
    }
    let result = '';
    for (let i = 0; 32 > i; ) result += ((g[i >> 3] >> 4 * (1 ^ i++)) & 15).toString(16);
    return result.split('').reverse().join('');
}

/** Mint a fresh anonymous key, valid for exactly ONE request with USER_AGENT. */
function freshTryItKey(userAgent = USER_AGENT) {
    const digits = String(Math.round(Math.random() * 100000000000));
    const H = islandHash;
    return `tryit-${digits}-${H(userAgent + H(userAgent + H(userAgent + digits + SALT)))}`;
}

/** Random device id, same shape the site sets as the deepai_device_id cookie. */
function randomDeviceId() {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
    const opts = { prompt: '', out: null, key: null, deviceId: randomDeviceId(), aspect: null, genSource: 'img' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--out') opts.out = argv[++i];
        else if (a === '--key') opts.key = argv[++i];
        else if (a === '--device-id') opts.deviceId = argv[++i];
        else if (a === '--aspect') opts.aspect = argv[++i];
        else if (a === '--chat-source') opts.genSource = 'chat';
        else if (a === '--help' || a === '-h') opts.help = true;
        else if (!opts.prompt) opts.prompt = a;
    }
    return opts;
}

const ASPECTS = { '16:9': [832, 448], '4:3': [768, 576], '1:1': [640, 640], '3:4': [576, 768], '9:16': [448, 832] };

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help || !opts.prompt) {
        console.log('Usage: node deepai-text2img.js "your prompt" [--out file.jpg] [--key PRO_KEY] [--device-id VALUE] [--aspect 16:9|1:1|9:16|4:3|3:4] [--chat-source]');
        process.exit(opts.help ? 0 : 1);
    }

    // ---- body: multipart/form-data, NEVER JSON -----------------------------
    const form = new FormData();
    form.append('text', opts.prompt);
    form.append('generation_source', opts.genSource); // 'img' = model page, 'chat' = chat page
    if (opts.aspect && ASPECTS[opts.aspect]) {
        // the chat-page dialect maps aspect ratios to pixel sizes
        const [w, h] = ASPECTS[opts.aspect];
        form.append('width', String(w));
        form.append('height', String(h));
        form.append('image_generator_version', 'hd');
        form.append('quality', 'true');
    }

    // ---- headers: fresh single-use anonymous key (or your Pro key) ---------
    const apiKey = opts.key || freshTryItKey();
    const headers = {
        'api-key': apiKey,
        'User-Agent': USER_AGENT, // MUST match the UA the key was hashed with
        Origin: 'https://deepai.org',
        Referer: 'https://deepai.org/machine-learning-model/text2img',
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: `deepai_device_id=${opts.deviceId}`,
        // NOTE: do NOT set Content-Type yourself — undici adds the multipart
        // boundary. A manual Content-Type without the boundary is rejected.
    };

    console.log(`Prompt : ${opts.prompt}`);
    console.log(`Key    : ${opts.key ? '(registered key — needs Pro)' : apiKey + '  (fresh, single-use)'}`);
    console.log('POST   : ' + API_URL);

    const res = await fetch(API_URL, { method: 'POST', headers, body: form });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* non-JSON */ }

    if (!res.ok || data?.err || (data?.status && !data.share_url && !data.output_url)) {
        console.error(`\nFAILED  HTTP ${res.status}`);
        console.error(raw.slice(0, 500));
        const s = String(data?.status || data?.err || '');
        if (/valid Api-Key/i.test(s)) console.error('\n→ The key is invalid or was already used. Keys are SINGLE-USE and must be hashed for the exact User-Agent you send. This script already mints a fresh one each run — if you copied a key from DevTools/Postman history, that is the problem.');
        else if (/try this model on deepai\.org/i.test(s)) console.error('\n→ DeepAI is refusing anonymous generation from your IP (datacenter/VPN) or the Origin header is missing. Run from a residential IP and keep the Origin/Referer headers.');
        else if (/Pro members/i.test(s)) console.error('\n→ Your registered key is on the free plan; /api/* needs Pro. Use the anonymous mode (omit --key) or upgrade.');
        else if (/try it exceeded/i.test(s)) console.error('\n→ Free quota for this device/IP is exhausted. Try a different --device-id or wait for the reset.');
        process.exit(1);
    }

    const url = data.share_url || data.output_url;
    console.log(`\nOK     HTTP ${res.status}`);
    console.log(`Image  : ${url}`);
    if (data.id) console.log(`ID     : ${data.id}`);

    // ---- optional: download the image --------------------------------------
    const out = opts.out || `deepai-${Date.now()}.jpg`;
    try {
        const img = await fetch(url);
        if (img.ok) {
            const buf = Buffer.from(await img.arrayBuffer());
            require('fs').writeFileSync(out, buf);
            console.log(`Saved  : ${out} (${(buf.length / 1024).toFixed(1)} KB)`);
        } else {
            console.log(`(download skipped: HTTP ${img.status} — open the URL above in a browser)`);
        }
    } catch (e) {
        console.log(`(download failed: ${e.message} — open the URL above in a browser)`);
    }
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
