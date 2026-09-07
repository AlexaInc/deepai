# Changelog

All notable changes to `alexa-ai` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.2.0] — 2026-09-07

### Fixed
- **Image generation works on free keys again.** Verified against the live
  site and three independent 2026 clients, three server-side changes had
  silently broken the free routes; all three are now handled:
  - **Anonymous `tryit-…` keys are hash-validated.** `generateTryItKey()`
    used to return random digits + random hex, which the server rejects like
    any unknown key — after a quota rotation (`autoKeyRotation`) every
    request failed. Keys are now minted with the site's own protocol
    (`tryit-{rand}-{md5rev(ua+md5rev(ua+md5rev(ua+rand+SALT)))}`), hashed
    over the configured `userAgent` so the key and the request match. The
    salt rotates server-side, so `DeepAIClient.discoverTryItSalt()` reads it
    from the inline JS of the `/chat` page (memoised for an hour, warmed by
    `init()`); the newest known salt is the fallback and `tryitSalt` pins it
    manually. Known salts: `hackers_become_a_little_stinkier_every_time_they_hack`
    (2026-09), `suditya_is_a_smelly_hacker` (older).
  - **`/api/text2img` serves free keys only with the browser fields.**
    A bare `{ text }` post answers `{"status": "Out of API credits"}`;
    carrying `generation_source: 'chat'` (+ `width`, `height`,
    `image_generator_version: 'hd'`, `quality`) bills the free chat quota
    instead. `generateImage()` now sends those fields by default
    (constructor option `imageApiFields`, `false` restores the bare post),
    maps `aspectRatio` to dimensions, and retries once bare if a strict
    backend dislikes the extras.
  - **The in-chat image tool's packet no longer carries a url** — only
    `{type:'generated_image', prompt}`. The engine now completes the
    generation itself with an `/api/text2img` post carrying the tool's
    prompt (`via: 'chat-api'`), exactly like the browser, and falls back to
    one natural-language image turn ("Create image: …") before giving up.
    A quota refusal now short-circuits the remaining turns instead of
    burning them.
- **Attachment uploads no longer send the `api-key` header.**
  `/chat_attachments/upload` refuses it; the call is now anonymous with the
  `Origin` header (as the browser sends it). Previously every
  image/document message failed at the upload step, so vision and document
  reading never got a chance to run.

### Added
- `npm run test:live` (`test/live-api.js`) — a live verification matrix for
  any host that can reach api.deepai.org: salt discovery, minted-key chat,
  the refused bare text2img post, the browser-field post, `generateImage()`
  end-to-end on both key kinds, sentiment/summarization, and the anonymous
  upload. Distinguishes "host cannot reach DeepAI" from real API failures.
- `.env.example` documenting `DEEPAI_API_KEY`, `DEEPAI_API_KEYS`,
  `POSTGRES_URL` and `OCR_API_KEY`.
- Offline assertions grew from 392 to 487: the tryit hash fixtures (verified
  against the site's own minified minting code), salt scraping (both observed
  page shapes), salt discovery plumbing, anonymous-upload headers, the free
  text2img route, and the prompt-only tool-packet completion.

## [2.1.2] — 2026-09-06

### Changed
- **`searchWeb()` now searches the web itself** instead of trusting DeepAI's
  server-side web access. Observed live with `gpt-4o-mini`: the same query
  produced one report without any sources and one with four invented links,
  because the model skipped the search and wrote from memory. The engine now
  queries Bing, Bing News, Wikipedia, Google News and DuckDuckGo in parallel
  (no API key needed; the four feeds were verified live on 2026-09-06 —
  DuckDuckGo's html endpoint serves a bot challenge from data-centre IPs, so
  its lite endpoint is tried first and a challenge page yields no results), hands the results to the model as numbered material, and asks
  it to cite result numbers and never write URLs. The `*Sources:*` block is
  built from the search results only — cited first — so a link the model made
  up can never reach the chat. Citation markers are removed from the prose;
  URLs the model still types are turned into citations when they match a
  result and dropped otherwise.
- Result gained `grounded` (did the engine's search answer?), `providers`,
  `via` (`'model'` | `'digest'`), and each source carries `date`, `provider`
  and `cited`.
- New options: `results` (bring your own search API's results), `search:false`,
  `providers`, `maxResults`; constructor options `webSearch`,
  `webSearchProviders`, `webSearchTimeout`, `webSearchResults`,
  `webSearchProvider(query, { maxResults, signal })`.
- When every provider fails the request falls back to DeepAI's web access as
  before (`grounded:false`); when the search worked but the model call failed,
  a plain digest of the results is returned (`via:'digest'`, still `ok:true`).

### Added
- `WebSearch` service (exported) with parsers for the DuckDuckGo html/lite
  pages, RSS 2.0 news feeds and the MediaWiki search API, redirect unwrapping
  (`duckduckgo.com/l/?uddg=`, `bing.com/news/apiclick.aspx?url=`), ad and
  duplicate filtering, and provider round-robin.
- `WebAnswer.formatResults()`, `extractCitations()`, `stripUrls()`, `digest()`.
- The npm package now ships the test suite (`test/`), so the published
  tarball is a complete snapshot of the repository at the tagged version:
  `npm explore alexa-ai -- npm test`.

## [2.1.1] — 2026-09-06

### Fixed
- `searchWeb()` returned one or two sentences with a `Sources:` list dumped
  inside `text` and an empty `sources` array. The prompt asked for *"a short,
  direct answer"*, and sources were only read from DeepAI's structured
  web-results packet, which some models (`gpt-4o-mini`) never send — they
  write the list as prose instead. The method now asks for a long-form,
  sectioned answer (intro, 3–5 `*Heading:*` sections with numbered
  `*Title*: detail` points, ~300–450 words), lifts any `Sources:` list,
  inline `(Source: url)` citation or trailing link lines out of the prose
  into `sources`, merges them with the packet (de-duplicated by URL), and
  renders one `*Sources:*` block at the end of `text`.
- Sentences in which the model talks about itself — *"I'm a large language
  model"*, *"I don't have the ability to browse the web"*, *"based on my
  training data"* — are removed from web answers. Third-party mentions of AI
  companies in the research itself are kept verbatim: `IdentityGuard.sanitise()`
  gained a `{ vendors: false }` mode used for research output.
- `IdentityGuard.sanitise()` could drop the first letter of a reply that began
  with "A" after repairing it (a character-class typo in the clean-up regex).
- The example scripts no longer embed a real DeepAI key; `examples/demo.js`
  requires `DEEPAI_KEY` (or `DEEPAI_API_KEY`) in the environment.

### Added
- `searchWeb()` hands the model the layout as a fill-in template and, when a
  long-form answer still comes back under `minWords` (default 150), asks once
  for a full rewrite and keeps the longer reply. Leftover `<placeholder>`
  tokens are dropped.
- `searchWeb()` options: `detail: 'short' | 'long'` (default `long`),
  `minWords`, `includeSources`, `maxSources`, `language`, `instructions`.
- `searchWeb()` result fields `answer` (the prose without the sources block),
  `words` and `attempts`.
- `WebAnswer` service (exported) — the prompt, the sources parser, the
  disclaimer filter and the renderer, so a host bot can reuse them on its own
  text.

## [2.1.0] — 2026-09-06

### Added
- `Media` utility: one normaliser for every media input shape — `Buffer`,
  `Uint8Array`, `ArrayBuffer`, data URI, raw base64, `http(s)` URL and
  `{ buffer | base64 | data | url }` objects. Content type is sniffed from the
  bytes when missing or mislabelled. Used by `chat({ image })`, `ask()`,
  `describeImage()`, `upscaleImage()`, `editImage()`, `colorizeImage()` and
  `detectNsfw()`, so Baileys and whatsapp-web.js media objects work as-is.
- `generateImage()` falls back to DeepAI's in-chat `generate_image` tool when
  `/api/text2img` is refused, so image generation works on free `tryit-…`
  keys. The result reports the route used (`via: 'api' | 'chat'`); new
  options `apiOnly`, `chatToolOnly`, `aspectRatio`.
- `summarizeText()` falls back to a stateless chat request when
  `/api/summarization` is refused.
- `colorizeImage()`, `isBlocked()` and `isGroupEnabled()` on the engine.
- `AlexaAI.version` and `AlexaAI.methods()` so a host application can verify
  the installed build at startup.
- `describeImage()` now returns a WhatsApp-ready `text` alongside the raw
  `description`.
- `detectNsfw()` returns a boolean `nsfw` verdict (`threshold` option,
  default 0.7) alongside the score.
- `test/wrapper-methods.js`: every method exposed to the bot, run against a
  mock of DeepAI's free tier and — with `POSTGRES_URL` — a real database.
- `CHANGELOG.md`, `LICENSE`, `files` whitelist in `package.json`.

### Fixed
- `blockUser()`, `unblockUser()` and `setGroupEnabled()` matched the canonical
  jid only. Blocking a person by the `@lid` seen in a group (when their row
  was created from a DM phone jid), or muting a group Alexa had not yet
  spoken in, returned `null` and silently did nothing. They now follow the
  alias graph, create the row for pre-emptive blocks and mutes, and throw
  `ValidationError` for the wrong jid kind.
- `describeImage(buffer)` reported `unreadable` for a bare `Buffer`.
- `upscaleImage()` / `editImage()` / `detectNsfw()` given `{ base64 }` or a
  raw base64 string uploaded no image at all.
- `runApi()` treated `{"status": "Out of API credits"}` (HTTP 200) as a
  successful response with `url: null`; such bodies are now errors and quota
  wording maps to `DEEPAI_QUOTA_EXCEEDED`.
- `/api/*` uploads now carry a real content type and filename; URL inputs are
  sent as plain fields instead of being dropped.
- `searchWeb()` rejects an empty query instead of sending a bare prompt,
  passes replies through `IdentityGuard`, normalises `sources` to
  `{ title, url, description }`, and never throws.
- `chat()` accepts `file`, `media` and `attachment` as aliases of `image`.

### Changed
- `examples/bot-ai.js` updated to the bot's current wrapper, with a startup
  engine-version check and simplified media handling (the engine now
  normalises everything except local file paths).
- `npm test` runs both suites.
- README rewritten as reference documentation.

## [2.0.0] — 2026-09-05

### Added
- Cross-chat identity: `wa_user_identities` alias graph, `IdentityResolver`,
  automatic row merging, `linkIdentity()`, `getAliases()`, `whoIs()`,
  `mergeUsers()`. A person is one row whether they write from a DM phone jid
  or a group `@lid`.
- `AmnesiaGuard`: a `[MEMORY CHECK]` directive on recall questions and
  deterministic repair of *"as a bot I can't remember"* replies from the
  database.
- `IdentityGuard`: identity lock on identity questions and post-flight
  scrubbing of vendor names, model-tier renames (`Alexa Mini`) and
  self-denials.
- `StreamParser`: splits DeepAI's streamed body into text, tool activity,
  web results, generated images and chain-of-thought.
- Full DeepAI endpoint surface in `DeepAIClient`: reasoning tasks,
  attachments, sessions, account settings, `/api/*`. Routes live in an
  overridable `endpoints` map.
- Vision provider chain (document extraction → DeepAI vision → OCR → honest
  fallback) with a per-model fallback list, a cooldown instead of a permanent
  latch, and attachment passthrough to the real conversation.
- `FactMiner`: local first-person fact extraction as a safety net when the
  model omits the `@MEMORY` tag.
- Key rotation on quota refusals; optional anonymous key minting.

### Fixed
- `attachment_uuids` is sent as a top-level form field; inside a message
  object it forced DeepAI to downgrade the request to a text-only model.
- Control characters, JSON packets and model reasoning no longer reach
  WhatsApp.

## [1.0.0]

Initial release: DeepAI chat with the Alexa persona, PostgreSQL-backed
memory and conversation history, deterministic command triggers and
WhatsApp output formatting.

[2.1.1]: https://github.com/AlexaInc/deepai/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/AlexaInc/deepai/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/AlexaInc/deepai/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/AlexaInc/deepai/releases/tag/v1.0.0
