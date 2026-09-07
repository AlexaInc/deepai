#!/usr/bin/env node
'use strict';
/**
 * diagnose.js — DeepAI text2img connectivity diagnostic.
 *
 * Run ON THE MACHINE where the browser playground works:
 *
 *   node examples/diagnose.js
 *   node examples/diagnose.js --device-id <your deepai_device_id cookie>
 *   node examples/diagnose.js --imp /path/to/curl-impersonate
 *
 * Each test sends the browser-shaped request with a FRESH single-use key
 * through a different transport and prints the raw server response, so one
 * run shows exactly which transport DeepAI accepts on your network:
 *
 *   1. Node fetch   (the library default)
 *   2. system curl
 *   3. curl-impersonate with a Chrome TLS profile (if the binary is found)
 *
 * Zero dependencies, Node 18+.
 */

const API = 'https://api.deepai.org/api/text2img';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const PROFILE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const SALT = 'hackers_become_a_little_stinkier_every_time_they_hack';

// ---- key hash (same algorithm as DeepAIClient._islandHash) ----------------
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
const freshKey = (ua) => {
    const digits = String(Math.round(Math.random() * 100000000000));
    return `tryit-${digits}-${islandHash(ua + islandHash(ua + islandHash(ua + digits + SALT)))}`;
};

// ---- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--device-id') opt.deviceId = args[++i];
    else if (args[i] === '--imp') opt.imp = args[++i];
}
const deviceId = opt.deviceId || Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const cookie = `deepai_device_id=${deviceId}`;

// ---- transports ---------------------------------------------------------------
async function viaFetch() {
    const form = new FormData();
    form.append('text', 'a small red boat on a calm lake');
    form.append('generation_source', 'img');
    const res = await fetch(API, {
        method: 'POST', body: form,
        headers: { 'api-key': freshKey(UA), 'User-Agent': UA, Origin: 'https://deepai.org', Referer: 'https://deepai.org/machine-learning-model/text2img', Accept: '*/*', Cookie: cookie },
    });
    return { status: res.status, body: await res.text() };
}

function runCurl(binary, impersonate) {
    const { execFileSync } = require('child_process');
    const ua = impersonate ? PROFILE_UA : UA;
    const a = impersonate ? ['--impersonate', 'chrome136'] : [];
    a.push(API, '-sS', '--compressed', '--max-time', '60', '-X', 'POST',
        '-H', `api-key: ${freshKey(ua)}`);
    if (!impersonate) a.push('-H', `User-Agent: ${ua}`);
    a.push('-H', 'Origin: https://deepai.org',
        '-H', 'Referer: https://deepai.org/machine-learning-model/text2img',
        '-H', 'Accept: */*',
        '-H', `Cookie: ${cookie}`,
        '-F', 'text=a small red boat on a calm lake',
        '-F', 'generation_source=img',
        '-w', '\n%{http_code}');
    const out = execFileSync(binary, a, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\r/g, '');
    const cut = out.lastIndexOf('\n');
    return { status: Number(out.slice(cut + 1).trim()), body: out.slice(0, cut) };
}

function label(t) {
    const b = String(t.body).slice(0, 140).replace(/\s+/g, ' ');
    if (t.status === 200 && /share_url|output_url/.test(t.body)) return `✅ SUCCESS — image generated (HTTP 200)`;
    if (/valid Api-Key/i.test(b)) return `❌ key rejected (unexpected — fresh key was used)`;
    if (/try this model/i.test(b)) return `❌ transport refused ("Please try this model on deepai.org")`;
    if (/Pro members/i.test(b)) return `❌ account-level refusal (needs a Pro key)`;
    if (/try it exceeded/i.test(b)) return `⚠️ free quota exhausted for this device/IP — retry later or change --device-id`;
    return `❌ HTTP ${t.status}: ${b}`;
}

(async () => {
    console.log(`DeepAI text2img diagnostic — device ${deviceId.slice(0, 8)}…\n`);
    const rows = [];
    try { rows.push(['1. Node fetch (library default)', label(await viaFetch())]); } catch (e) { rows.push(['1. Node fetch', `⚠️ ${e.message}`]); }
    try { rows.push(['2. system curl', label(runCurl('curl', false))]); } catch (e) { rows.push(['2. system curl', `⚠️ ${e.message.split('\n')[0]}`]); }

    let impBin = opt.imp;
    if (!impBin) {
        const { execFileSync } = require('child_process');
        for (const name of ['curl-impersonate', 'curl-impersonate.exe']) {
            try { execFileSync(name, ['--version'], { timeout: 5000, stdio: 'ignore' }); impBin = name; break; } catch { /* keep looking */ }
        }
    }
    if (impBin) {
        try { rows.push([`3. curl-impersonate (${impBin})`, label(runCurl(impBin, true))]); } catch (e) { rows.push(['3. curl-impersonate', `⚠️ ${e.message.split('\n')[0]}`]); }
    } else {
        rows.push(['3. curl-impersonate', '⏭ skipped — binary not found (see README for install)']);
    }

    for (const [name, v] of rows) console.log(`${name.padEnd(34)} ${v}`);
    console.log(`
Reading the results:
- A ✅ on ANY line    → that transport works; use it (library: transport option,
                        standalone: --transport).
- ❌ on line 1 only   → non-browser TLS stack refused; use 'curl' or
                        'impersonate'.
- ❌ on lines 1+2, ✅ on 3 → strict browser-TLS matching; use 'impersonate'.
- ❌ everywhere      → the IP is refused for anonymous generation, or the free
                        quota is exhausted. Compare with the browser: DevTools
                        → Network → generate → text2img request → Response.`);
})();
