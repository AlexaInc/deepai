#!/usr/bin/env node
'use strict';
/**
 * text2img-standalone.js - zero-dependency DeepAI text-to-image CLI.
 *
 * Speaks the anonymous browser dialect: a fresh single-use `tryit-...` key
 * (hashed over the User-Agent) per run, browser-identical headers and a
 * multipart/form-data body, plus a stable `deepai_device_id` cookie.
 *
 * Usage:
 *   node examples/text2img-standalone.js "a cute orange cat"
 *   node examples/text2img-standalone.js "a cat" --out cat.jpg
 *   node examples/text2img-standalone.js "a cat" --aspect 16:9
 *   node examples/text2img-standalone.js "a cat" --device-id <cookieValue>
 *   node examples/text2img-standalone.js "a cat" --key <proKey>
 *   node examples/text2img-standalone.js "a cat" --transport curl
 *   node examples/text2img-standalone.js "a cat" --transport impersonate --imp /path/to/curl-impersonate
 *
 * Transports: 'fetch' (default, Node fetch) | 'curl' (system curl) |
 * 'impersonate' (curl-impersonate binary, Chrome TLS profile). Some
 * networks serve non-browser TLS stacks a refusal - if 'fetch' fails with
 * "Please try this model on deepai.org", try 'curl', then 'impersonate'.
 *
 * Requires Node.js 18+. Anonymous generation is refused from
 * datacenter/VPN IPs; run from a residential network.
 */

const API_URL = 'https://api.deepai.org/api/text2img';
const SALT = 'hackers_become_a_little_stinkier_every_time_they_hack';
// Keep this EXACT string in sync with the User-Agent header below - the key
// hash is computed over it and the server recomputes it from the request.
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Deterministic key hash (see DeepAIClient._islandHash in the engine).
// The integer/bit-level behaviour is intentional - do not simplify it.
// ---------------------------------------------------------------------------
function islandHash(input) {
    const a = [];
    for (let b = 0; 64 > b; ) a[b] = 0 | (4294967296 * Math.sin(++b % Math.PI));
    let d, e, f, g = [(d = 1732584193), (e = 4023233417), ~d, ~e], h = [];
    const l = unescape(encodeURI(input)) + '\u0080';
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
    const opts = { prompt: '', out: null, key: null, deviceId: randomDeviceId(), aspect: null, genSource: 'img', transport: 'fetch', imp: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--out') opts.out = argv[++i];
        else if (a === '--key') opts.key = argv[++i];
        else if (a === '--device-id') opts.deviceId = argv[++i];
        else if (a === '--aspect') opts.aspect = argv[++i];
        else if (a === '--chat-source') opts.genSource = 'chat';
        else if (a === '--transport') opts.transport = argv[++i];
        else if (a === '--imp') opts.imp = argv[++i];
        else if (a === '--help' || a === '-h') opts.help = true;
        else if (!opts.prompt) opts.prompt = a;
    }
    return opts;
}

const ASPECTS = { '16:9': [832, 448], '4:3': [768, 576], '1:1': [640, 640], '3:4': [576, 768], '9:16': [448, 832] };

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help || !opts.prompt) {
        console.log('Usage: node examples/text2img-standalone.js "your prompt" [--out file.jpg] [--key PRO_KEY] [--device-id VALUE] [--aspect 16:9|1:1|9:16|4:3|3:4] [--chat-source] [--transport fetch|curl|impersonate] [--imp PATH]');
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
        // NOTE: do NOT set Content-Type yourself - undici adds the multipart
        // boundary. A manual Content-Type without the boundary is rejected.
    };

    console.log(`Prompt : ${opts.prompt}`);
    console.log(`Key    : ${opts.key ? '(registered key - needs Pro)' : apiKey + '  (fresh, single-use)'}`);
    console.log('POST   : ' + API_URL);

    let res;
    if (opts.transport === 'curl' || opts.transport === 'impersonate') {
        const { execFile } = require('child_process');
        const binary = opts.transport === 'impersonate' ? (opts.imp || 'curl-impersonate') : 'curl';
        // the chrome136 profile sends its own Mac Chrome UA - the anonymous
        // key hash must be derived from exactly that UA
        const profileUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
        const apiKey = opts.key || freshTryItKey(opts.transport === 'impersonate' ? profileUa : USER_AGENT);
        const curlArgs = [];
        if (opts.transport === 'impersonate') curlArgs.push('--impersonate', 'chrome136');
        curlArgs.push(API_URL, '-sS', '--compressed', '--max-time', '120', '-X', 'POST',
            '-H', `api-key: ${apiKey}`);
        if (opts.transport !== 'impersonate') curlArgs.push('-H', `User-Agent: ${USER_AGENT}`);
        curlArgs.push(
            '-H', `Origin: ${headers.Origin}`,
            '-H', `Referer: ${headers.Referer}`,
            '-H', 'Accept: */*',
            '-H', `Cookie: deepai_device_id=${opts.deviceId}`,
            '-w', '\n%{http_code}'
        );
        for (const [k, v] of form.entries()) curlArgs.push('-F', `${k}=${v}`);
        res = await new Promise((resolve, reject) => {
            execFile(binary, curlArgs, { timeout: 120000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
                if (err && stdout == null) return reject(err);
                const body = String(stdout).replace(/\r/g, '');
                const cut = body.lastIndexOf('\n');
                const status = Number(body.slice(cut + 1).trim());
                resolve({ status, ok: status < 300, text: async () => body.slice(0, cut) });
            });
        });
    } else {
        res = await fetch(API_URL, { method: 'POST', headers, body: form });
    }
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* non-JSON */ }

    if (!res.ok || data?.err || (data?.status && !data.share_url && !data.output_url)) {
        console.error(`\nFAILED  HTTP ${res.status}`);
        console.error(raw.slice(0, 500));
        const s = String(data?.status || data?.err || '');
        if (/valid Api-Key/i.test(s)) console.error('\n-> The key is invalid or already used. Keys are single-use and must be hashed for the exact User-Agent sent; this script mints a fresh one each run.');
        else if (/try this model on deepai\.org/i.test(s)) console.error('\n-> DeepAI is refusing anonymous generation from your IP (datacenter/VPN) or the Origin header is missing. Run from a residential IP and keep the Origin/Referer headers.');
        else if (/Pro members/i.test(s)) console.error('\n-> Your registered key is on the free plan; /api/* needs Pro. Use the anonymous mode (omit --key) or upgrade.');
        else if (/try it exceeded/i.test(s)) console.error('\n-> Free quota for this device/IP is exhausted. Try a different --device-id or wait for the reset.');
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
            console.log(`(download skipped: HTTP ${img.status} - open the URL above in a browser)`);
        }
    } catch (e) {
        console.log(`(download failed: ${e.message} - open the URL above in a browser)`);
    }
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
