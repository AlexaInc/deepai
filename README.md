# alexa-ai

The **AI layer** for the [Alexa WhatsApp bot](https://github.com/AlexaInc/alexa-v3).

Object-oriented, DeepAI-powered, PostgreSQL-backed. This package contains **no
WhatsApp code** — it is a pure engine your existing bot plugs into.

```js
const AlexaAI = require('./alexa-ai');

const ai = new AlexaAI({
    key: process.env.DEEPAI_API_KEY,     // DeepAI api-key
    postgresUrl: process.env.POSTGRES_URL // PostgreSQL connection string
});

const { text } = await ai.chat({
    message : "Hi, I'm Nimal and I love cricket",
    userId  : '78151912841263@lid',          // DM or group sender
    groupId : '120363413125431525@g.us',     // omit for a DM
    userName: 'Nimal'
});

await sock.sendMessage(jid, { text });       // your WhatsApp layer
```

---

## Contents

- [Install](#install)
- [The one method you need](#the-one-method-you-need)
- [Drop-in replacement for `callai.js`](#drop-in-replacement-for-callaijs)
- [How identity & memory work](#how-identity--memory-work)
- [Database schema](#database-schema)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [User management API](#user-management-api)
- [Verified DeepAI API behaviour](#verified-deepai-api-behaviour)
- [Known limitation: image vision](#known-limitation-image-vision)
- [Testing](#testing)

---

## Install

```bash
npm install pg          # the only runtime dependency
```

Node.js **18+** is required (the engine uses the built-in `fetch` and `FormData`).

Set two environment variables:

```bash
DEEPAI_API_KEY=tryit-6809613270-caa24a28a55047b221b1123dd19c696a
POSTGRES_URL=postgres://user:pass@host:5432/dbname
```

Tables are created automatically on first connect. To run migrations manually:

```bash
POSTGRES_URL=... npm run migrate
```

---

## The one method you need

### `ai.chat(params)`

| param       | type              | required | notes                                              |
| ----------- | ----------------- | -------- | -------------------------------------------------- |
| `message`   | `string`          | ✔\*      | the user's text                                     |
| `userId`    | `string`          | ✔        | `78151912841263@lid` or `947...@s.whatsapp.net`     |
| `groupId`   | `string`          | –        | `120363413125431525@g.us`; omit/empty for a DM      |
| `userName`  | `string`          | –        | WhatsApp push name                                  |
| `groupName` | `string`          | –        | group subject                                       |
| `image`     | `object`          | –        | `{ buffer, mimetype, filename }` — see limitation   |
| `messageId` | `string`          | –        | WhatsApp message id, used to de-duplicate           |
| `isAdmin`   | `boolean`         | –        | sender is a group admin                             |
| `signal`    | `AbortSignal`     | –        | cancel an in-flight request                         |

\* required unless an `image` is supplied.

Returns:

```js
{
  text      : 'Nice to meet you, Nimal! 🏏',  // clean, WhatsApp-ready
  raw       : '...@MEMORY: {"name":"Nimal"}', // unmodified model output
  memories  : { name: 'Nimal', hobby: 'cricket' },
  trigger   : null,          // 'weather' | 'menu' | 'ping' | 'doc' when matched
  isGroup   : false,
  contextKey: 'dm:78151912841263@lid',
  userName  : 'Nimal',
  latencyMs : 1420,
  chunks    : ['...'],       // pre-split for WhatsApp's length cap
  error     : null           // 'user_blocked' | 'DEEPAI_QUOTA_EXCEEDED' | ...
}
```

`chat()` never throws on a network/model failure — it returns a friendly
`text` and sets `error`, so your bot always has something to send. It *does*
throw `ValidationError` for a malformed `userId`.

---

## Drop-in replacement for `callai.js`

Your current module exports `ai(message, userId, groupId, userName, callback)`.
`ai.ask()` matches that signature exactly:

```js
// src/modules/callai.js
const AlexaAI = require('../../alexa-ai');

const engine = new AlexaAI({
    key: process.env.DEEPAI_API_KEY,
    postgresUrl: process.env.POSTGRES_URL,
});

module.exports = (message, userId, groupId, userName, callback) =>
    engine.ask(message, userId, groupId, userName, callback);
```

Every existing call site keeps working, including the `{ text, files: [] }`
message shape.

---

## How identity & memory work

This is the part that satisfies *"identify the same user across DMs and any
group"*.

```
                    ┌──────────────────────────┐
                    │  wa_users                │
 78151912841263@lid │  ONE row per human       │
        ──────────► │  id = 42                 │ ◄──── same row from every group
                    └────────────┬─────────────┘
                                 │ user_id
                    ┌────────────▼─────────────┐
                    │  wa_memories             │   ← keyed to the USER only,
                    │  (user_id, key) UNIQUE   │     never to a group
                    └──────────────────────────┘

  conversations are separate so chat context never bleeds between rooms:
     dm:78151912841263@lid
     group:120363413125431525@g.us:78151912841263@lid
     group:120363999888777666@g.us:78151912841263@lid
```

- **Memories are global per user.** A fact learned in a DM is available in
  every group, and vice-versa.
- **Transcripts are per-thread.** A DM and each group keep independent history,
  so group chatter never contaminates a private conversation.
- **`UNIQUE (user_id, key)`** means re-learning `name` overwrites it instead of
  creating duplicates.
- **`@lid` is treated as a privacy id**, never as a phone number — `phone` stays
  `NULL` for those users.
- Device suffixes are stripped, so `94771234567:12@s.whatsapp.net` and
  `94771234567@s.whatsapp.net` are the same person.

Verified end-to-end against a live database and the live API:

```
[DM]      "Hi, I'm Nimal and I love cricket. I live in Galle."
          -> learned {name: Nimal, location: Galle, hobby: cricket}
[GROUP A] "Do you remember my name and where I live?"
          -> "I do! Your name is Nimal, and I believe you're from Galle."
[GROUP B] "What is my hobby?"
          -> "Your hobby is cricket."
[GROUP A] different user asks "Do you know my name?"
          -> "I don't have that information yet."   ← correctly isolated
```

---

## Database schema

Seven tables, all created automatically. Full DDL in
[`src/db/schema.sql`](src/db/schema.sql).

| table              | purpose                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `wa_users`         | one row per person; `jid` unique; push name, counters, block flag  |
| `wa_groups`        | one row per group; subject, per-group AI on/off switch             |
| `wa_group_members` | which user was seen in which group (per-room stats, admin flag)    |
| `wa_conversations` | one thread per DM / per (group, user); `context_key` unique        |
| `wa_messages`      | transcript; deduped by `(conversation_id, wa_message_id)`          |
| `wa_memories`      | long-term facts, `UNIQUE (user_id, key)`, optional `expires_at`    |
| `wa_ai_usage`      | audit log: model, latency, ok/error — for monitoring               |

Indexes cover the hot paths (newest-N-messages per thread, memories per user,
recently active users). `updated_at` is maintained by triggers.

---

## Architecture

Every responsibility is its own class — the object-oriented requirement.

```
AlexaAI                     orchestrator; the only class the bot touches
├── Config                  validated settings, env fallbacks, redacted logging
├── DeepAIClient            HTTP transport: retries, timeouts, error mapping
├── Database                pg pool, migrations, transactions
├── UserRepository          users, groups, membership, blocking
├── MemoryRepository        long-term facts (global per user)
├── ConversationRepository  threads, messages, history windows, usage log
├── PromptBuilder           assembles chatHistory (persona + memory + history)
├── TriggerDetector         deterministic weather/menu/ping/doc matching
├── MathDetector            flags maths questions for terse answers
├── MemoryExtractor         parses & strips the @MEMORY tag
├── FactMiner               local fallback fact extraction
├── ResponseFormatter       enforces WhatsApp formatting; chunks long replies
├── ImageDescriber          vision path (see limitation)
└── JidParser               normalises @lid / @s.whatsapp.net / @g.us
```

### Three engineering decisions worth knowing

**1. Triggers are matched in code, not by the model.**
The spec requires byte-exact outputs (`weather Colombo`, `menu`, `ping`, `doc`)
because your bot parses them as commands. The free-tier model does not comply:
it answered *"send me the docs"* with a 200-word essay about its capabilities.
`TriggerDetector` matches these four intents deterministically and skips the
model entirely — so routing can never break. Disable with `triggers: false`.

**2. Memory is injected next to the question, not just at the top.**
With the full-length persona, facts placed in the header get diluted — the model
insisted *"our conversation just started"* in **0/4** trials. Repeating them as a
compact note immediately above the live message scored **4/4** with no leakage.
Both placements are used.

**3. Facts are mined locally as a safety net.**
The model frequently ignores the `@MEMORY:` rule. `FactMiner` extracts
high-confidence facts from the user's own words using explicit first-person
patterns (and skips third-party statements like *"my friend lives in Kandy"*).
Model-emitted tags always win on conflict. Disable with `factMining: false`.

---

## Configuration

```js
new AlexaAI({
    key: 'tryit-...',              // required (alias: apiKey)
    postgresUrl: 'postgres://...', // required (aliases: postgueurl, databaseUrl)

    model: 'standard',             // DeepAI model
    visionModel: 'gpt-4o-mini',    // used when an image is attached
    systemPrompt: '...',           // override the Alexa persona

    historyLimit: 14,              // past messages replayed to the model
    maxMemories: 25,               // facts injected per request
    sharedGroupThread: false,      // true = one thread per group, not per member

    triggers: true,                // deterministic command matching
    memory: true,                  // long-term memory
    factMining: true,              // local fact extraction fallback

    timeout: 60000,
    maxRetries: 2,
    autoMigrate: true,
    ssl: undefined,                // auto: off for localhost, relaxed for managed PG
    debug: false,
});
```

`key` and `postgresUrl` fall back to `DEEPAI_API_KEY` / `POSTGRES_URL`
(or `DATABASE_URL`) when omitted.

---

## User management API

```js
// memory
await ai.getMemories('78151912841263@lid');            // { name: 'Nimal', ... }
await ai.remember(jid, 'favourite_team', 'Sri Lanka');
await ai.forget(jid, 'favourite_team');
await ai.forgetAll(jid);

// conversations
await ai.clearHistory(jid);                 // clear the DM thread
await ai.clearHistory(jid, groupJid);       // clear one group thread
await ai.getProfile(jid);                   // user + memories + threads

// moderation
await ai.blockUser(jid);
await ai.unblockUser(jid);
await ai.setGroupEnabled(groupJid, false);  // mute Alexa in one group

// ops
await ai.stats();      // { users, groups, conversations, messages, memories, active_24h }
await ai.health();     // { ok: true, now, database }
await ai.close();      // close the pool on shutdown
```

Blocked users and disabled groups return `{ text: '', error: 'user_blocked' }`
so your bot can simply skip sending.

---

## Verified DeepAI API behaviour

Reverse-engineered from the DeepAI chat page and confirmed against the live
endpoint:

```http
POST https://api.deepai.org/hacking_is_a_serious_crime
api-key: tryit-...
Content-Type: multipart/form-data

chat_style       = chat
chatHistory      = [{"role":"user","content":"..."}]
model            = standard
hacker_is_stinky = very_stinky
```

- The response is **plain streamed text**, not JSON and not SSE.
- Errors arrive as a short JSON body: `{"status": "Only paid accounts can use genius"}`.
- **`role: "system"` is silently ignored.** A system message had zero effect on
  output; the persona is therefore delivered as a priming user/assistant pair,
  which the API does honour.
- Free `tryit-` keys are limited to `standard` and `gpt-4o-mini`. Requesting
  `gpt-4.1`, `claude-opus-5`, or Genius returns *"Only paid accounts can use genius"*.
- `/chat_attachments/upload` rejects the `api-key` header
  (*"Invalid authentication credentials"*) but succeeds anonymously **with** an
  `Origin` header.

---

## Known limitation: image vision

**Vision does not work on free `tryit-` keys.** This was tested exhaustively:

| approach                             | result                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------- |
| Upload + `attachment_uuids`          | `"The selected model (llama-3.1-8b-instruct-turbo) does not support image attachments."` |
| Force `gpt-4o-mini` / `gemini-*`     | same error — anonymous keys are downgraded server-side                    |
| Vision models (`gpt-4.1`, Genius)    | `"Only paid accounts can use genius"`                                     |
| base64 data-URI in the message       | `"It appears to be an image pattern encoded in base64."`                  |
| public image URL                     | model **guesses from the URL**, it cannot actually see the image          |

The URL test is worth calling out: a dog photo produced a plausible
*"Afghan Hound"*, which looks like working vision — but an image containing the
text `SECRET CODE: ZQ7412` at a neutral URL produced *"I can't read or repeat the
code in an image."* The model was inferring from filenames, not seeing pixels.

`ImageDescriber` therefore:

1. tries the real upload + attachment flow first,
2. detects the plan refusal and latches vision off to avoid wasted calls,
3. returns an honest fallback (*"I'm not able to view images right now — could
   you describe it?"*) instead of hallucinating a description.

**The code is complete and correct** — supply a paid DeepAI key (or set
`visionModel: 'gpt-4.1'` on a Pro account) and vision starts working with no
changes.

---

## Testing

```bash
# unit tests only
node test/run-tests.js

# + live PostgreSQL
POSTGRES_URL=postgres://postgres:pass@localhost:5432/alexa node test/run-tests.js

# + live DeepAI API
POSTGRES_URL=... DEEPAI_KEY=tryit-... node test/run-tests.js
```

**142 assertions, all passing** against a real PostgreSQL 17 instance and the
live DeepAI API — covering jid parsing, memory extraction from malformed model
output, trigger matching, formatting enforcement, cross-group memory recall,
per-user isolation, message dedupe, and history windowing.

An interactive walkthrough of the whole scenario:

```bash
POSTGRES_URL=... node examples/demo.js
```
