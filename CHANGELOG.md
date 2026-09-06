# Changelog

All notable changes to `alexa-ai` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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

[2.1.0]: https://github.com/AlexaInc/deepai/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/AlexaInc/deepai/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/AlexaInc/deepai/releases/tag/v1.0.0
