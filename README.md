# alexa-ai

> The AI engine behind the Alexa WhatsApp bot — DeepAI-powered conversation with
> PostgreSQL-backed long-term memory and cross-chat identity.

[![Node.js ≥ 18](https://img.shields.io/badge/node-%E2%89%A5%2018-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-12%2B-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Tests](https://img.shields.io/badge/tests-392%20passing-brightgreen)](#testing)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.1.0-informational)](CHANGELOG.md)

`alexa-ai` is a standalone Node.js library with **no WhatsApp code in it**. Your
bot — Baileys, whatsapp-web.js or anything else — hands it a message and a
sender, and receives a WhatsApp-ready reply. Everything in between — persona,
memory, identity resolution, media understanding, output formatting and the
DeepAI transport — is handled by the engine.

```js
const AlexaAI = require('alexa-ai');

const ai = new AlexaAI({
    key: process.env.DEEPAI_API_KEY,
    postgresUrl: process.env.POSTGRES_URL,
});

const { text } = await ai.chat({
    message:  "Hi, I'm Nimal and I love cricket",
    userId:   '78151912841263@lid',            // sender (DM or group)
    groupId:  '120363413125431525@g.us',       // omit for a DM
    userName: 'Nimal',
});

await sock.sendMessage(jid, { text });          // your WhatsApp layer
```

---

## Highlights

- **Long-term memory in PostgreSQL.** Facts learned about a person survive
  restarts and are available in their private chat *and* in every group.
- **One person, many addresses.** WhatsApp uses `…@lid` in groups and
  `…@s.whatsapp.net` in DMs. The engine links every address to a single
  identity and merges duplicate rows automatically.
- **The whole DeepAI surface.** Chat, attachments, reasoning tasks, sessions,
  account settings and the classic `/api/*` family — text-to-image, upscaling,
  editing, colourising, NSFW detection, summarisation — from one client.
- **Works on free keys — and can mint its own.** Image generation,
  summarisation and image reading run on anonymous `tryit-…` keys, and the
  engine mints protocol-valid anonymous keys itself (the site's hash chain,
  salt auto-discovered from `/chat`).
- **WhatsApp-native output.** Markdown is converted to WhatsApp formatting,
  long replies are chunked, and DeepAI's wire packets never reach the user.
- **A persona you can rely on.** Deterministic command triggers, an identity
  lock and a memory guard keep Alexa in character whatever the backend returns.
- **Object-oriented and testable.** Every responsibility is its own class, and
  300+ assertions run with no network and no database.

---

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Usage](#usage)
  - [`ai.chat(params)`](#aichatparams)
  - [Integrating with an existing bot](#integrating-with-an-existing-bot)
  - [Identity: one person, many addresses](#identity-one-person-many-addresses)
  - [Memory](#memory)
  - [Images and documents](#images-and-documents)
  - [Image generation, web search and other tools](#image-generation-web-search-and-other-tools)
  - [Moderation and administration](#moderation-and-administration)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Database schema](#database-schema)
- [DeepAI API reference](#deepai-api-reference)
- [Troubleshooting](#troubleshooting)
- [Testing](#testing)
- [Examples](#examples)
- [Changelog](#changelog)
- [License](#license)

---

## Requirements

| | |
| --- | --- |
| **Node.js** | 18 or newer — the engine uses the built-in `fetch`, `FormData` and `Blob` |
| **PostgreSQL** | 12 or newer, local or managed (Supabase, Neon, Railway, Heroku…) |
| **DeepAI key** | any key works: an anonymous `tryit-…` key covers chat, memory, OCR and image generation (the engine can even mint fresh ones — `autoKeyRotation`); a paid account key additionally unlocks native vision and straightforward `/api/*` credit billing |

---

## Installation

The package is distributed from this repository rather than the npm registry:

```bash
npm install github:AlexaInc/deepai
# or, from a local checkout
npm install /path/to/deepai
```

`pg` is the only runtime dependency and is installed automatically.

Provide the two required settings through the environment (or pass them to the
constructor — see [Configuration](#configuration)):

```bash
DEEPAI_API_KEY=tryit-xxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
POSTGRES_URL=postgres://user:password@host:5432/alexa
```

Tables are created automatically on first connect. To run the migration
explicitly (for example in a deploy step):

```bash
POSTGRES_URL=... npm run migrate
```

To confirm the installed build:

```bash
node -e "console.log(require('alexa-ai').version)"   # 2.1.0
```

---

## Quick start

```js
const AlexaAI = require('alexa-ai');

const ai = new AlexaAI({
    key: process.env.DEEPAI_API_KEY,
    postgresUrl: process.env.POSTGRES_URL,
});

// A Baileys message from a group. Baileys exposes both addresses of the sender:
// the privacy jid used in the group and the phone jid used in DMs.
const { text } = await ai.chat({
    message:  text,
    userId:   msg.key.participant,           // 78151912841263@lid
    aliases:  [msg.key.participantAlt],      // 94771234567@s.whatsapp.net
    groupId:  msg.key.remoteJid,             // 120363413125431525@g.us
    userName: msg.pushName,
});

await sock.sendMessage(msg.key.remoteJid, { text });
```

That is the whole integration. The engine opens its connection pool lazily on
the first call; call `await ai.close()` on shutdown.

---

## Usage

### `ai.chat(params)`

Handles one incoming message: resolves the sender to a person, loads their
memory and the thread history, builds the prompt, calls DeepAI, post-processes
the reply and persists everything.

| param       | type              | required | notes                                              |
| ----------- | ----------------- | -------- | -------------------------------------------------- |
| `message`   | `string`          | ✔\*      | the user's text                                     |
| `userId`    | `string`          | ✔        | `78151912841263@lid` or `947…@s.whatsapp.net`       |
| `userLid`   | `string`          | –        | the sender's `@lid` address, if known              |
| `userPhone` | `string`          | –        | phone jid **or** bare number behind the `@lid`     |
| `aliases`   | `string[]`        | –        | any other address for the same person              |
| `groupId`   | `string`          | –        | `120363413125431525@g.us`; omit or `''` for a DM    |
| `userName`  | `string`          | –        | WhatsApp push name                                  |
| `groupName` | `string`          | –        | group subject                                       |
| `image`     | see below         | –        | an attached image or document                       |
| `messageId` | `string`          | –        | WhatsApp message id, used to de-duplicate redeliveries |
| `isAdmin`   | `boolean`         | –        | sender is a group admin                             |
| `model`     | `string`          | –        | override the DeepAI model for this turn            |
| `webAccess` | `boolean`         | –        | let DeepAI search the web for this turn            |
| `thinking`  | `boolean`         | –        | use the asynchronous reasoning path                |
| `onToken`   | `function`        | –        | `(delta, full)` streaming callback                 |
| `signal`    | `AbortSignal`     | –        | cancel an in-flight request                         |

\* required unless an `image` is supplied.

`image` accepts a `Buffer`, `Uint8Array`, data URI, raw base64 string, `http(s)`
URL, or a `{ buffer | base64 | data | url, mimetype?, filename? }` object —
Baileys and whatsapp-web.js media objects work as-is. The content type is
detected from the bytes when it is missing or wrong.

> **Pass every address you have.** Supplying both the `@lid` and the phone jid
> (Baileys: `key.participant` and `key.participantAlt`) is what lets Alexa
> recognise a DM user inside a group. See [Identity](#identity-one-person-many-addresses).

Returns:

```js
{
  text      : 'Nice to meet you, Nimal! 🏏',  // clean, WhatsApp-ready
  raw       : '...@MEMORY: {"name":"Nimal"}', // unmodified model output
  memories  : { name: 'Nimal', hobby: 'cricket' }, // facts learned this turn
  trigger   : null,          // 'weather' | 'menu' | 'ping' | 'doc' when matched
  isGroup   : false,
  contextKey: 'dm:78151912841263@lid',
  userName  : 'Nimal',
  userId    : 42,            // the canonical person behind every alias
  aliases   : ['78151912841263@lid', '94771234567@s.whatsapp.net'],
  mergedIdentities: false,   // true when two rows were folded into one
  repairedMemory  : false,   // true when an "I can't remember" denial was corrected
  images    : [],            // urls when the model used its image tool
  model     : 'standard',    // the model that actually answered
  latencyMs : 1420,
  chunks    : ['...'],       // pre-split for WhatsApp's length cap
  error     : null           // 'user_blocked' | 'group_disabled' | 'DEEPAI_QUOTA_EXCEEDED' | ...
}
```

`chat()` never throws on a network or model failure — it returns a friendly
`text` and sets `error`, so the bot always has something to send. It *does*
throw `ValidationError` for a malformed `userId`.

### Integrating with an existing bot

[`examples/bot-ai.js`](examples/bot-ai.js) is a complete drop-in module for a
bot whose AI layer has the classic callback signature. Copy it to
`src/modules/Aii.js` (or wherever your bot requires it) and nothing else
changes:

```js
const ai = require('./modules/Aii');

// string message
const reply = await ai(text, senderJid, groupJid, pushName);

// message with an attachment, plus both sender addresses
const reply = await ai({ text, files: [buffer] }, { id: lid, phone: phoneJid }, groupJid, pushName);

// straight from a Baileys message object
const reply = await ai.fromMessage(msg, sock);
```

The module also exposes the administration and media helpers described below
(`ai.generateImage`, `ai.searchWeb`, `ai.blockUser`, …) and checks the
installed engine version at startup.

If you prefer to keep your own module, `engine.ask()` has the same
`(message, userId, groupId, userName, callback)` signature, including the
`{ text, files: [] }` message shape.

### Identity: one person, many addresses

WhatsApp addresses the same human differently depending on where they write:

```
DM      ->  key.remoteJid    = 94771234567@s.whatsapp.net     (phone jid)
GROUP   ->  key.participant  = 78151912841263@lid             (privacy / LID jid)
```

A naive implementation keys users on the jid and ends up with two rows — one
that knows everything about the person and one that knows nothing. Since LID
addressing is now the default in groups, this affects every user.

`alexa-ai` models identity as an **alias graph**:

```
   94771234567@s.whatsapp.net ─┐
   78151912841263@lid ─────────┤   wa_user_identities        ┌────────────────────┐
   94771234567:12@s.whatsapp.net┤   (jid -> user_id)   ─────►│ wa_users  id = 42  │
   …any future address ────────┘                             └─────────┬──────────┘
                                                                       │ user_id
                                                          ┌────────────▼─────────────┐
                                                          │  wa_memories             │
                                                          │  (user_id, key) UNIQUE   │
                                                          └──────────────────────────┘

  conversations stay separate so chat context never bleeds between rooms
  (keyed on the person's canonical address, so they survive an address change):
     dm:94771234567@s.whatsapp.net
     group:120363413125431525@g.us:94771234567@s.whatsapp.net
     group:120363999888777666@g.us:94771234567@s.whatsapp.net
```

Pass every address you have and the engine links them. If two addresses turn
out to belong to rows that already exist, the rows are **merged** inside a
transaction — memories, transcripts, group membership and counters move to the
surviving row.

```js
// Baileys provides both addresses on a group message
const sender    = msg.key.participant || msg.key.remoteJid;        // 781…@lid
const senderAlt = msg.key.participantAlt || msg.key.participantPn; // 947…@s.whatsapp.net

await ai.chat({ message, userId: sender, aliases: [senderAlt], groupId, userName });

// or record a mapping whenever you learn one
await ai.linkIdentity('78151912841263@lid', '94771234567@s.whatsapp.net');

await ai.getAliases('78151912841263@lid');     // every address for this person
await ai.whoIs('94771234567@s.whatsapp.net');  // { user, aliases, memories }
```

Rules the engine follows:

- **Memories are global per person.** A fact learned in a DM is available in
  every group, and vice versa.
- **Transcripts are per thread.** A DM and each group keep independent history,
  so group chatter never contaminates a private conversation.
- **A jid belongs to exactly one person.** When an address appears under a
  second user, the rows are merged: the older row survives, and the newest
  value wins per memory key.
- **`@lid` is a privacy id, never a phone number.** `phone` stays `NULL` for
  those identities until a phone jid is linked.
- **Device suffixes are ignored.** `94771234567:12@s.whatsapp.net` and
  `94771234567@s.whatsapp.net` are the same person.
- **Nothing breaks without aliases.** If you only ever pass one address, the
  engine behaves as a plain one-row-per-jid system.

Example session against a live database and the live API:

```
[DM]      "Hi, I'm Nimal and I love cricket. I live in Galle."
          -> learned {name: Nimal, location: Galle, hobby: cricket}
[GROUP A] "Do you remember my name and where I live?"
          -> "I do! Your name is Nimal, and I believe you're from Galle."
[GROUP B] "What is my hobby?"
          -> "Your hobby is cricket."
[GROUP A] a different user asks "Do you know my name?"
          -> "I don't have that information yet."   ← correctly isolated
```

### Memory

Facts are learned in two ways and stored under `UNIQUE (user_id, key)`, so
re-learning `name` overwrites it instead of creating duplicates:

1. **From the model.** The persona asks the model to append
   `@MEMORY: {"key": "value"}` to a reply whenever the user reveals something
   personal. `MemoryExtractor` parses the tag (including malformed variants)
   and strips it from the visible text.
2. **From the user's own words.** Small models frequently ignore the tag
   rule, so `FactMiner` extracts high-confidence first-person facts locally
   (`my name is…`, `I live in…`, `I support…`) and skips third-party
   statements (`my friend lives in Kandy`). Model-emitted tags win on conflict.

Stored facts are injected into every prompt for that person — as a block in
the persona and again as a compact note directly above the live message, where
they are far less likely to be diluted by a long system prompt. A recall
question (*"do you remember me?"*) additionally receives an explicit
`[MEMORY CHECK]` directive, and `AmnesiaGuard` rewrites any residual
*"as a bot I can't remember"* from the database so the reply is never false.

```js
await ai.getMemories(jid);                        // { name: 'Nimal', ... }
await ai.remember(jid, 'favourite_team', 'Sri Lanka');
await ai.forget(jid, 'favourite_team');
await ai.forgetAll(jid);
await ai.clearHistory(jid);                       // wipe the DM transcript (memories stay)
await ai.clearHistory(jid, groupJid);             // wipe one group thread
await ai.getProfile(jid);                         // user + memories + threads
```

Every `jid` argument follows the alias graph, so any address the person is
known under works.

### Images and documents

An attachment on `chat()` runs through a provider chain; the first provider
that produces text wins:

| # | Provider | Handles | Free key |
|---|----------|---------|----------|
| 0 | DeepAI document extraction | `.txt` `.pdf` `.docx` `.csv` `.md` … | ✅ |
| 1 | DeepAI native vision | full understanding of any photo | paid plans |
| 2 | OCR (`ocr.space`) | text inside images and screenshots | ✅ |
| 3 | Honest fallback | photos with no readable text | ✅ |

- The file is uploaded **once** and reused by every provider.
- Vision walks the full `visionModels` chain per model. A plan refusal puts
  native vision on a 30-minute cooldown rather than disabling it for the life
  of the process, so upgrading the key simply starts working.
- When the upload succeeded but nothing could be pre-read, the attachment
  uuid is forwarded with the real conversation; an account with vision then
  sees the picture in full context.
- A photo with no readable text gets an honest reply asking what it shows —
  the model is never allowed to invent a description.
- Oversized files are rejected (`maxImageBytes`, default 12 MB) rather than
  truncated.

```js
// a screenshot -> OCR
await ai.chat({ message: 'what does this say?', userId, image: buffer });
// -> "It says: SECRETCODE ZQ7412 …"

// a document -> server-side extraction
await ai.chat({ message: 'what is the total?', userId,
                image: { buffer, mimetype: 'text/plain', filename: 'invoice.txt' } });
// -> "`Total: 4500 LKR, due 2026-10-01`"

// read something without touching the conversation
await ai.describeImage(buffer, 'is this a receipt?');   // { ok, text, description, source }
```

> **Tip:** the default OCR key is `ocr.space`'s shared demo key and is
> rate-limited. Get a free key at [ocr.space/ocrapi](https://ocr.space/ocrapi)
> and set `OCR_API_KEY` (or `ocrApiKey`).

### Image generation, web search and other tools

These helpers live on the engine and **never throw** — each resolves to
`{ ok, …, error?, message? }` so a command handler can check `ok` and forward
`message` when it is false.

```js
await ai.generateImage('a red tuk-tuk in Galle at sunset'); // { ok, url, id, via }
await ai.searchWeb('coffee');                               // { ok, text, answer, sources: [{ title, url }] }
await ai.summarizeText(longText);                           // { ok, text }
await ai.describeImage(buffer, caption);                    // { ok, text, description, source }

await ai.upscaleImage(buffer);                              // { ok, url }   4x super-resolution
await ai.editImage(buffer, 'make the sky purple');          // { ok, url }
await ai.colorizeImage(buffer);                             // { ok, url }
await ai.detectNsfw(buffer);                                // { ok, score, nsfw }

await ai.deepaiHealth();                                    // { ok, latencyMs, reply }
await ai.deepai.runApi('waifu2x', { image: buffer });       // any /api/<name> endpoint
```

All media arguments accept the same shapes as `chat({ image })`.

**`generateImage()` on a free key.** `POST /api/text2img` is a paid endpoint:
anonymous keys receive `{"status": "Out of API credits"}`. The engine tries it
first because it is fast and returns a plain URL; when it is refused, it
drives the same in-chat `generate_image` tool the deepai.org web client uses,
which works on free chat keys. The result reports the route that answered
(`via: 'api' | 'chat'`). Options: `{ apiOnly }`, `{ chatToolOnly }`,
`{ aspectRatio: '16:9' }` for the chat tool, and `width` / `height` /
`image_generator_version` for the API.

**`summarizeText()`** follows the same pattern — `/api/summarization` first, a
stateless chat request as the fallback.

**`searchWeb()`** is a one-off research request that touches no user's
memory or history, so it can be called with no jid at all. The engine does the
searching itself — Bing, Bing News, Wikipedia, Google News and DuckDuckGo, in
parallel, no API key needed — and hands the results to the model as numbered
material. The model writes the report from them and cites result numbers; it
is told never to write a URL. The `*Sources:*` block is then built from the
search results only (cited ones first), so every link the bot shows is a page
that actually came back from a search, never one the model made up. The
default answer is long-form and ready to send to WhatsApp — an intro, three to
five `*Heading:*` sections with numbered `*Title*: detail` points, and one
`*Sources:*` block at the end:

```
Coffee remains one of the most traded commodities in the world, and 2026 has
brought record prices.

*Recent Coffee News:*
1. *Arabica futures hit a high*: Prices rose 12% in August after frost damaged
   crops in Brazil.
2. *Starbucks menu shake-up*: The chain removed 30% of its drinks.
…

*Coffee Trends:*
1. *Cold brew keeps growing*: Ready-to-drink sales are up 20%.
…

*Sources:*
1. Reuters – Coffee prices — https://www.reuters.com/…
2. National Coffee Association — https://www.ncausa.org/
```

The model is given the layout as a fill-in template rather than a description
of one; small models follow a visible layout far more reliably. If a long-form
answer still comes back under `minWords` (default 150), one follow-up turn asks
the model to rewrite it in full, and the longer reply wins — `attempts` and
`words` in the result show what happened.

The result tells you which path answered:

```js
const r = await ai.searchWeb('coffee');
// r.grounded   true  → the engine searched; sources are real search results
//              false → no search results (host offline / providers blocked);
//                      DeepAI's own web access answered, and its sources are
//                      whatever the model reported — treat them with care
// r.providers  ['bing', 'bing-news', 'wikipedia', 'google-news', 'duckduckgo'] — who answered
// r.sources    [{ title, url, description, date, provider, cited }]
// r.via        'model' | 'digest' (the model failed but the search worked:
//                                  a plain list of the results is returned)
// r.words, r.attempts, r.model
```

Sentences in which the model talks about itself — *"I'm a language model"*,
*"I can't browse the web"*, *"based on my training data"* — are removed, and
leftover template placeholders are dropped. Third-party names in the research
itself (news about OpenAI or Google) are kept verbatim.

```js
await ai.searchWeb('coffee', {
    detail: 'short',          // 2–4 sentences instead of the sectioned long form
    minWords: 0,              // never retry a short long-form answer (default 150)
    includeSources: false,    // keep the *Sources:* block out of `text`
    maxSources: 3,            // how many to list in `text` (the array is not capped)
    language: 'Sinhala',      // answer language (default: the language of the query)
    instructions: 'focus on Sri Lanka',
    providers: ['bing-news', 'google-news'],   // only news for this call
    maxResults: 5,            // results handed to the model (default 8)
    search: false,            // skip the built-in search, use DeepAI's web access
});

// Bring your own search API (Brave, Serper, Tavily, …): pass its results and
// the built-in search is skipped — the sources block is built from them.
await ai.searchWeb('coffee', {
    results: [{ title, url, description, date }],
});
```

Engine-wide settings in the constructor:

```js
new AlexaAI({
    webSearch: true,                       // false = never search; always use DeepAI's
    webSearchProviders: ['bing', 'bing-news', 'wikipedia', 'google-news', 'duckduckgo'],
    webSearchTimeout: 8000,                // per provider, ms
    webSearchResults: 8,                   // results handed to the model
    webSearchProvider: async (query, { maxResults, signal }) => [...],  // replace the built-ins
});
```

The built-in providers are public pages and feeds, so they can change or be
rate-limited; each one is best-effort and a failure just means fewer results.
When none return anything the request falls back to DeepAI's server-side web
access — which on the free models is exactly the behaviour that motivated this
design: it often skips the search and writes a plausible report with invented
links. Check `grounded` if that matters to you.

### Moderation and administration

```js
await ai.blockUser(jid);                    // any of the person's addresses
await ai.unblockUser(jid);
await ai.isBlocked(jid);

await ai.setGroupEnabled(groupJid, false);  // mute Alexa in one group
await ai.isGroupEnabled(groupJid);          // unknown groups are enabled

await ai.stats();      // { users, groups, conversations, messages, memories, active_24h }
await ai.health();     // { ok, now, database }
await ai.close();      // close the pool on shutdown
```

`blockUser()` and `setGroupEnabled()` create the row when the person or group
has never been seen, so a pre-emptive block or mute is already in force on
the first message. Blocked users and disabled groups get
`{ text: '', error: 'user_blocked' | 'group_disabled' }` from `chat()`, so the
bot can simply skip sending.

---

## Configuration

```js
new AlexaAI({
    key: 'tryit-...',              // required (alias: apiKey); falls back to DEEPAI_API_KEY
    postgresUrl: 'postgres://...', // required (alias: databaseUrl); falls back to POSTGRES_URL / DATABASE_URL

    // DeepAI
    model: 'standard',             // chat model
    fallbackModels: ['standard'],  // tried in order when the main model is refused
    visionModel: 'gpt-4o-mini',    // first model tried for attachments
    visionModels: [...],           // full vision fallback chain
    keys: ['tryit-a', 'tryit-b'],  // rotated automatically on "try it exceeded"
    autoKeyRotation: false,        // mint a fresh anonymous key when every key is spent
                                   // (protocol-valid: hashed over userAgent with the live salt)
    tryitSalt: null,               // pin the anonymous-key salt (default: auto-discovered
                                   // from the /chat page, newest known salt as fallback)
    imageApiFields: { generation_source: 'chat', width: '640', height: '640',
                      image_generator_version: 'hd', quality: 'true' },
                                   // browser fields that unlock /api/text2img on free
                                   // keys; false restores the bare { text } post
    userAgent: 'Mozilla/5.0 …',    // must match the UA your tryit keys were hashed with
    webAccess: false,              // DeepAI web search on every turn
    thinkingSupport: false,        // asynchronous reasoning path
    serverMemory: false,           // DeepAI's own /chat_memory profile
    enabledTools: ['image_generator', 'image_editor'],
    endpoints: { chat: '/hacking_is_a_serious_crime', ... },  // override any route

    // Persona
    assistantName: 'Alexa',        // also drives IdentityGuard / AmnesiaGuard
    creator: 'Hansaka',
    systemPrompt: '...',           // replace the whole persona
    systemRole: true,              // also send a role:'system' digest
    identityLock: true,            // inject the identity lock on identity questions
    amnesiaGuard: true,            // repair "I can't remember" denials

    // Identity & memory
    linkIdentities: true,          // @lid <-> phone alias graph
    mergeIdentities: true,         // merge rows that prove to be one person
    historyLimit: 14,              // past messages replayed to the model
    maxMemories: 25,               // facts injected per request
    sharedGroupThread: false,      // true = one thread per group instead of per member
    triggers: true,                // deterministic weather/menu/ping/doc matching
    memory: true,                  // long-term memory
    factMining: true,              // local fact extraction

    // Media
    ocr: true,
    ocrApiKey: process.env.OCR_API_KEY,
    maxImageBytes: 12 * 1024 * 1024,

    // Infrastructure
    timeout: 60000,
    maxRetries: 2,
    autoMigrate: true,
    ssl: undefined,                // auto: off for localhost, relaxed for managed PostgreSQL
    pool: { max: 10 },             // extra node-postgres pool options
    logger: console,
    debug: false,
});
```

---

## Architecture

The bot talks to one class, `AlexaAI`. Every other responsibility is its own
class with a single job:

```
AlexaAI                     orchestrator; the only class the bot touches
├── Config                  validated settings, env fallbacks, redacted logging
├── Endpoints               every DeepAI route in one overridable map
├── DeepAIClient            DeepAI transport: chat, tasks, attachments, sessions,
│                           settings, /api/* — retries and key rotation
├── StreamParser            splits DeepAI's stream: text | tool activity |
│                           web results | generated images | chain-of-thought
├── Persona / SystemPrompt  the Alexa prompt, renameable per deployment
├── Database                pg pool, migrations, transactions
├── UserRepository          users, groups, membership, blocking
├── IdentityRepository      the alias graph (@lid <-> phone) and row merging
├── MemoryRepository        long-term facts (global per person)
├── ConversationRepository  threads, messages, history windows, usage log
├── IdentityResolver        "which person is this?" across every address
├── PromptBuilder           assembles chatHistory (system + persona + memory)
├── TriggerDetector         deterministic weather/menu/ping/doc matching
├── MathDetector            flags maths questions for terse answers
├── MemoryExtractor         parses and strips the @MEMORY tag
├── FactMiner               local first-person fact extraction
├── ResponseFormatter       enforces WhatsApp formatting; chunks long replies
├── IdentityGuard           keeps Alexa in character (no vendor names,
│                           no "Alexa Mini", no self-denial)
├── AmnesiaGuard            never lets her deny a memory she actually has
├── ImageDescriber          vision chain: documents -> DeepAI -> OCR -> fallback
├── WebSearch               the engine's own web search (Bing, Bing/Google News, Wikipedia, DuckDuckGo)
├── WebAnswer               searchWeb prompt, citation handling, sources block
├── Media                   normalises every media input shape
└── JidParser               normalises @lid / @s.whatsapp.net / @g.us
```

All classes are exported from the package entry point for advanced use and
testing (`const { StreamParser, Media, JidParser } = require('alexa-ai')`).

### Design notes

**Command triggers are matched in code, not by the model.**
The bot's command router expects byte-exact outputs for four intents
(`weather <city>`, `menu`, `ping`, `doc`). Small models do not comply reliably
— `standard` will happily answer *"send me the docs"* with an essay.
`TriggerDetector` matches these intents deterministically and bypasses the
model entirely, so routing can never break. Disable with `triggers: false`.

**Memory is injected next to the question, not only at the top.**
Facts placed solely in the header of a long persona get diluted; in testing
the model insisted *"our conversation just started"* in 0/4 trials from the
header alone and recalled correctly in 4/4 when the same facts were repeated
as a compact note above the live message. Both placements are used.

**Facts are mined locally as a safety net.**
The model frequently ignores the `@MEMORY:` rule. `FactMiner` extracts
high-confidence facts from explicit first-person statements and defers to the
model's own tags on conflict. Disable with `factMining: false`.

**Identity is a graph, not a column.**
A person is not their jid. `wa_user_identities` maps every address to one
row, and rows that prove to be the same person are merged in a transaction.
This is what makes DM facts appear in groups.

**The engine has the last word, not the model.**
Two deterministic post-processors run on every reply: `IdentityGuard`
(vendor names, `Alexa Mini`-style renames, self-denials) and `AmnesiaGuard`
(*"I can't remember you"* while the database holds facts about you). Both
rewrite from data already in hand, add no latency and make no extra API call.

---

## Database schema

Eight tables, created automatically. Full DDL in
[`src/db/schema.sql`](src/db/schema.sql); the migration is idempotent.

| table                | purpose                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `wa_users`           | one row per person; canonical `jid`, push name, counters, block flag |
| `wa_user_identities` | every address a person is seen under → one `user_id` (`@lid` ↔ phone) |
| `wa_groups`          | one row per group; subject, per-group AI on/off switch             |
| `wa_group_members`   | which user was seen in which group (per-room stats, admin flag)    |
| `wa_conversations`   | one thread per DM / per (group, user); `context_key` unique        |
| `wa_messages`        | transcript; de-duplicated by `(conversation_id, wa_message_id)`    |
| `wa_memories`        | long-term facts, `UNIQUE (user_id, key)`, optional `expires_at`    |
| `wa_ai_usage`        | audit log: model, latency, ok/error                                |

Indexes cover the hot paths (newest-N messages per thread, memories per user,
recently active users). `updated_at` columns are maintained by triggers.

---

## DeepAI API reference

`DeepAIClient` implements every route used by the deepai.org web client. All
of them are reachable as `ai.deepai.*`, and the paths live in one overridable
map (`endpoints`), so a rename on DeepAI's side is a configuration change.

| area | route | client method |
| ---- | ----- | ------------- |
| chat | `POST /hacking_is_a_serious_crime` | `chat()` / `chatDetailed()` |
| reasoning tasks | `GET /check_chat_task_status?type=&task_id=` | `taskStatus()` / `waitForTask()` |
| moderation score | `GET /check-sensitivity?request_id=` | `checkSensitivity()` |
| attachments | `POST /chat_attachments/upload` | `uploadAttachment()` |
| attachments | `GET /chat_attachments/get?uuid=` | `getAttachment()` |
| sessions | `POST /save_chat_session` | `saveSession()` |
| sessions | `GET /get_chat_session?uuid=` | `getSession()` |
| sessions | `POST /rename_chat_session` | `renameSession()` |
| sessions | `POST /delete_chat_session` | `deleteSession()` |
| sessions | `POST /delete_all_chat_history` | `deleteAllSessions()` |
| account memory | `GET/POST /chat_memory` | `chatMemory()` |
| agent mode | `GET/POST /chat_sandbox` | `chatSandbox()` |
| background tasks | `GET/POST /chat_concierge` | `chatConcierge()` |
| abuse report | `POST /report_character` | `reportCharacter()` |
| image generation | `POST /api/text2img` | `text2img()` |
| image editing | `POST /api/image-editor` | `editImage()` |
| upscaling | `POST /api/torch-srgan` | `upscaleImage()` |
| colourising | `POST /api/colorizer` | `colorizeImage()` |
| moderation | `POST /api/nsfw-detector` | `detectNsfw()` |
| summarising | `POST /api/summarization` | `summarize()` |
| anything else | `POST /api/<name>` | `runApi(name, fields)` |

### The chat request

```http
POST https://api.deepai.org/hacking_is_a_serious_crime
api-key: tryit-...
Origin: https://deepai.org
Content-Type: multipart/form-data

chat_style                 = chat
chatHistory                = [{"role":"user","content":"..."}]
model                      = standard
session_uuid               = <uuid v4>
tool_activity_support      = 1
thinking_image_tool_support= 1
enabled_tools              = ["image_generator","image_editor"]
attachment_uuids           = ["..."]      (top level — never inside a message)
memory_enabled             = true|false
web_access_enabled         = true|false
sandbox_enabled            = true|false   (+ sandbox_turn_id)
concierge_enabled          = true|false
thinking_support           = 1            (-> {"task_id"} + polling)
hacker_is_stinky           = very_stinky
```

### The chat response

The body is streamed UTF-8 text with out-of-band packets embedded in it.
`StreamParser` separates them so none of this reaches WhatsApp:

```
\u001C{"tool_activity":"Searching the web"}\u001C     tool status pings
…answer…\u001C[{"title":…,"url":…}]                   web-search sources
…answer…\u001C{"type":"generated_image","share_url":…} generated image
\u001DTHINKING_START12s\u001E<chain of thought>\u001DTHINKING_END
```

### Observed behaviour worth knowing

- The response is **streamed text**, not JSON and not SSE.
- Refusals arrive as a short JSON body — `{"status": "Only paid accounts can
  use genius"}`, `{"status": "Out of API credits"}` — often with **HTTP 200**.
  The client treats these as errors; quota refusals rotate to the next
  configured key before the model chain is tried.
- **Anonymous `tryit-` keys are hash-validated.** The browser computes
  `tryit-{rand}-{md5rev(ua+md5rev(ua+md5rev(ua+rand+SALT)))}` with a salt that
  lives in the inline JS of the `/chat` page and rotates server-side; a random
  `tryit-…`-shaped string is rejected. `DeepAIClient.generateTryItKey()`
  implements the chain and `discoverTryItSalt()` keeps the salt current
  (2026-09: `hackers_become_a_little_stinkier_every_time_they_hack`, older:
  `suditya_is_a_smelly_hacker`). A key is only valid for the user agent it was
  hashed with, so minted keys always use the engine's configured `userAgent`.
- **`/api/text2img` has a free route.** A bare `{ text }` post is billed
  against API credits (free keys: "Out of API credits"), but the same key is
  served from the free chat quota when the post carries the browser fields —
  `generation_source: 'chat'` plus `width`, `height`,
  `image_generator_version`, `quality` (2026-09 values: `hd`, `true`,
  640×640). `generateImage()` sends them by default; `imageApiFields: false`
  restores the bare post.
- **The in-chat image tool no longer returns a url.** Its packet is
  `{type:'generated_image', prompt}` and the client completes the generation
  itself with an `/api/text2img` post carrying that prompt — the engine does
  the same (`via: 'chat-api'` in the result).
- **`role: "system"` is ignored** by the chat endpoint. The persona is
  therefore delivered as a priming user/assistant pair, which the API does
  honour; a short system digest is sent as well for backends that respect it.
- Anonymous `tryit-` keys are limited to `standard` and `gpt-4o-mini`.
  Requesting `gpt-4.1`, `claude-*` or Genius returns a paid-account refusal.
- **Any request carrying an attachment is routed to a text-only model on free
  keys**, whatever the `model` field says — we confirmed this by requesting
  non-existent model names, matched browser headers, signed-in cookies and the
  full browser field set; every variant resolved to
  `llama-3.1-8b-instruct-turbo`, while the same key routes text-only requests
  to `gpt-4o-mini` correctly. DeepAI states the reason in the reply itself:
  *"neither native vision nor document text extraction added their contents to
  this model request."* Document extraction (`.txt`, `.pdf`, …) does work on
  free keys, which is why documents are provider #0 in the vision chain.
- `attachment_uuids` **must be a top-level form field**. Placing it inside a
  message object forces the text-only downgrade even on paid keys.
- `/chat_attachments/upload` rejects the `api-key` header but succeeds
  anonymously **with** an `Origin` header.
- Message `content` must be a **plain string**. OpenAI-style array content
  (`[{type:'text'},{type:'image_url'}]`) is rejected with HTTP 500.

---

## Troubleshooting

**`TypeError: getEngine(...).generateImage is not a function`** (or
`.searchWeb`, `.upscaleImage`, …)
The copy of `alexa-ai` in your bot's `node_modules` is older than the wrapper
expects. Because the package is installed from GitHub, `npm install` does not
refresh it automatically. Reinstall and verify:

```bash
npm uninstall alexa-ai
npm install github:AlexaInc/deepai
node -e "console.log(require('alexa-ai').version)"   # must print 2.1.2 or newer
```

`AlexaAI.version` and `AlexaAI.methods()` let the bot assert this at startup;
`examples/bot-ai.js` does so in `assertEngineVersion()`.

**`searchWeb()` answers are short, or `sources` is empty while links appear in
`text`**
Fixed in 2.1.1. Earlier builds asked the model for *"a short, direct answer"*
and only read sources from DeepAI's structured packet, which `gpt-4o-mini`
does not send. If a particular model still answers briefly, check `attempts` /
`words` in the result: the engine retries once below `minWords`, and a
persistently short model is best swapped with the `model` option.

**`searchWeb()` sometimes has no sources, or the sources are links that do
not exist**
Fixed in 2.1.2. Before, the model was both researcher and writer: DeepAI's
server-side search ran unreliably on the free models, so the model often
wrote from memory — one run had no sources, the next had four invented ones.
The engine now searches the web itself and the sources block is built only
from those results. If `sources` is still empty, look at `grounded` in the
result: `false` means none of the search providers answered from your host
(firewall, DNS, rate limit — enable `debug:true` to see each provider's
error), and the reply came from DeepAI's own web access. Point
`webSearchProvider` at a search API you control if the public endpoints are
blocked where the bot runs.

**`generateImage()` returns `{ ok: false, error: 'DEEPAI_QUOTA_EXCEEDED' }`**
Fixed in 2.2.0 — this used to be the normal outcome on free keys. Three
things had changed on DeepAI's side and are now handled:

- `tryit-…` keys are **hash-validated**. The engine used to mint random
  `tryit-<digits>-<hex>` strings, which the server rejects like any unknown
  key. Keys are now produced with the site's own protocol —
  `tryit-{rand}-{md5rev(ua+md5rev(ua+md5rev(ua+rand+SALT)))}` — with the salt
  scraped from the `/chat` page at runtime (`discoverTryItSalt()`), falling
  back to the newest known salt when the page is unreachable.
- `/api/text2img` answers "Out of API credits" for a bare `{ text }` post on
  free keys, but serves the same key when the post carries the browser fields
  (`generation_source: 'chat'`, `width`, `height`, `image_generator_version`,
  `quality`). Those fields are now sent by default (`imageApiFields`).
- The in-chat tool's reply packet stopped carrying a url: it now contains
  only `{type:'generated_image', prompt}` and the *client* completes the
  generation on `/api/text2img`. The engine does the same, then falls back to
  one natural-language image turn before giving up.

If it still fails, run `npm run test:live` (see [Testing](#testing)) — it
tells you exactly which of the three routes answers on your host and key. A
genuine `DEEPAI_QUOTA_EXCEEDED` now means the key's chat quota itself is
spent: add more `keys: [...]`, enable `autoKeyRotation`, or wait for the
reset. `message` always carries DeepAI's exact wording.

**Photos are answered with "I can't view images right now"**
Native vision needs a paid DeepAI key; on a free key only text inside the
image can be read (OCR). Set your own `OCR_API_KEY` if the shared demo key is
rate-limited. Documents (`.txt`, `.pdf`, `.docx`) are extracted server-side
and work on free keys.

**Alexa recognises someone in a DM but not in a group**
Only one of the person's addresses is being passed. Supply both on group
messages (`userId: key.participant`, `aliases: [key.participantAlt]`) or call
`linkIdentity()` once when you learn the mapping.

**`Only paid accounts can use …`**
The configured `model` is not available on the key. The engine falls through
`fallbackModels`; keep `'standard'` in that list.

**`Cannot connect to PostgreSQL`**
Managed providers usually require SSL. The engine enables relaxed SSL
automatically for non-local hosts; pass `ssl: { rejectUnauthorized: true }`
(or a CA bundle) to enforce verification, or `ssl: false` to disable it.

---

## Testing

```bash
npm test                                          # no network, no database
POSTGRES_URL=postgres://... npm test              # + live PostgreSQL
POSTGRES_URL=... DEEPAI_KEY=tryit-... node test/run-tests.js   # + live DeepAI
```

- `test/run-tests.js` — 217 unit assertions covering jid parsing, alias
  collection, memory extraction from malformed model output, trigger
  matching, formatting enforcement, identity and amnesia repair, the DeepAI
  stream format and the exact request shape of every endpoint (mocked
  transport), plus an end-to-end run of the `chat()` pipeline on a fake
  database and a fake DeepAI. With `POSTGRES_URL` it additionally proves the
  identity model against a real database: a fact learned under a phone jid in
  a DM is readable under the `@lid` in a group, two pre-existing rows merge
  without losing a memory or a transcript, and unrelated users stay isolated.
- `test/wrapper-methods.js` — 175 assertions exercising every method exposed
  to the bot (`generateImage`, `searchWeb`, `summarizeText`, the media
  helpers, `describeImage`, `deepaiHealth`, and the memory, identity and
  moderation API) against a mock that behaves like DeepAI's free tier —
  including both ways DeepAI reports web-search sources — plus alias and
  unseen-row cases on a real database when `POSTGRES_URL` is set.

487 assertions run offline; 553 with a database.

```bash
# live API verification (needs a host that can reach api.deepai.org):
DEEPAI_KEY=your-account-key npm run test:live      # account-key matrix
npm run test:live -- --tryit                       # minted free-key matrix
```

---

## Examples

| file | what it shows |
| ---- | ------------- |
| [`examples/bot-ai.js`](examples/bot-ai.js) | complete drop-in AI module for the bot: callback signature, Baileys helper, admin and media commands, startup version check |
| [`examples/demo.js`](examples/demo.js) | interactive walkthrough — a user introduces themselves in a DM, is recognised in two groups, a second user stays isolated, triggers return exact output |

```bash
POSTGRES_URL=... DEEPAI_KEY=tryit-... node examples/demo.js
```

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[ISC](LICENSE) © Hansaka
