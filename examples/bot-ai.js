/**
 * src/modules/Aii.js  (or callai.js — whichever your bot requires)
 * ---------------------------------------------------------------------------
 * Alexa's AI layer, powered by the `alexa-ai` package (DeepAI + PostgreSQL)
 * instead of the Hugging Face Gradio Space.
 *
 * DROP-IN COMPATIBLE: the exported function keeps the exact same signature as
 * the old Gradio version, so no call site in the bot has to change:
 *
 *     ai(message, userId, groupId, userName, callback)
 *
 *   • `message` may be a string OR { text: "...", files: [...] }
 *   • `userId`  is the sender jid  ('78151912841263@lid', '947...@s.whatsapp.net')
 *               …or, better, everything you know: see IDENTITY below
 *   • `groupId` is the group jid   ('120363413125431525@g.us') or "" for a DM
 *   • `userName` is the WhatsApp push name
 *   • `callback(err, reply)` is optional; the function also returns the reply
 *
 * THE PERSONA
 *   This module deliberately does NOT pass `systemPrompt`, `assistantName` or
 *   `creator`. The engine's DEFAULT system prompt is used — the full Alexa
 *   persona (identity rules, WhatsApp formatting, the 4 strict triggers, math
 *   rules, vision rules, @MEMORY tracking). Overriding it here would silently
 *   disable those guarantees, so don't, unless you really mean to.
 *
 * IDENTITY — read this once, it is the important bit
 *   WhatsApp calls the same human by two different addresses:
 *
 *       DM     ->  94771234567@s.whatsapp.net      (phone jid)
 *       GROUP  ->  78151912841263@lid              (privacy / LID jid)
 *
 *   If the bot only ever passes one of them, the engine sees two people and
 *   Alexa "forgets" the user the moment they speak in a group. Baileys hands
 *   you both on every group message, so pass both:
 *
 *       const sender    = msg.key.participant || msg.key.remoteJid;
 *       const senderAlt = msg.key.participantAlt || msg.key.participantPn;
 *
 *       await ai(text, { id: sender, phone: senderAlt }, groupId, pushName);
 *       // or simply:  await ai.fromMessage(msg, sock);
 *
 *   Plain strings still work exactly as before — you just don't get the
 *   cross-chat recognition until you supply the second address.
 *
 * REQUIRED alexa-ai VERSION
 *   The extras below (generateImage, searchWeb, upscaleImage, …) exist from
 *   alexa-ai 2.0.0; the media/alias fixes from 2.1.0, the long-form
 *   searchWeb() from 2.1.1, and the free-key image fixes from 2.2.0
 *   (hash-valid anonymous keys, browser text2img fields, prompt-only tool
 *   packets, anonymous uploads). `getEngine()` checks
 *   this at startup and throws a clear message instead of the confusing
 *   "getEngine(...).generateImage is not a function" you get from an old copy
 *   in node_modules. If you see that error:
 *
 *       npm install github:AlexaInc/deepai      # or your fork / tarball
 *       node -e "console.log(require('alexa-ai').version)"   # must print >= 2.2.0
 *
 * REQUIRED .env
 *   DEEPAI_API_KEY=tryit-xxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   (your DeepAI key)
 *   POSTGRES_URL=postgres://user:pass@host:5432/dbname
 *
 * OPTIONAL .env
 *   DEEPAI_API_KEYS=key1,key2      extra keys, rotated when one hits its quota
 *   CHAT_MODEL=standard            DeepAI model ('standard' on free keys)
 *   OCR_API_KEY=...                your own ocr.space key (reads text in images)
 *   AI_DEBUG=1                     verbose engine logging
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const config = require("../config");
const AlexaAI = require("alexa-ai");

/** Oldest alexa-ai build this wrapper is known to work with. */
const MIN_ENGINE_VERSION = "2.2.0";

/** Every engine method this file calls. Checked once at startup. */
const REQUIRED_METHODS = [
  "chat", "init", "close", "health", "deepaiHealth", "stats",
  "forgetAll", "getMemories", "remember", "forget", "clearHistory",
  "blockUser", "unblockUser", "isBlocked", "setGroupEnabled", "isGroupEnabled", "getProfile",
  "linkIdentity", "getAliases", "whoIs",
  "generateImage", "editImage", "upscaleImage", "colorizeImage", "detectNsfw",
  "describeImage", "summarizeText", "searchWeb",
];

/** Singleton engine — one PostgreSQL pool for the whole bot. */
let engine = null;

/** Throw a clear error when node_modules holds an older alexa-ai. */
function assertEngineVersion(instance) {
  const installed = String(AlexaAI.version || instance.version || "0.0.0");
  const missing = REQUIRED_METHODS.filter((m) => typeof instance[m] !== "function");
  if (missing.length || compareVersions(installed, MIN_ENGINE_VERSION) < 0) {
    throw new Error(
      `alexa-ai ${installed} is too old for src/modules/Aii.js (needs >= ${MIN_ENGINE_VERSION}). ` +
        (missing.length ? `Missing methods: ${missing.join(", ")}. ` : "") +
        `Reinstall it: npm install github:AlexaInc/deepai (then delete node_modules/alexa-ai if npm kept the old copy).`,
    );
  }
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/** Create (once) and return the AI engine. */
function getEngine() {
  if (engine) return engine;

  const key = config.DEEPAI_API_KEY || process.env.DEEPAI_API_KEY;
  const postgresUrl =
    config.POSTGRES_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;

  if (!key) throw new Error("DEEPAI_API_KEY is missing from .env");
  if (!postgresUrl) throw new Error("POSTGRES_URL is missing from .env");

  // Extra keys are optional: "key1,key2" in .env, or an array in config.
  const extraKeys = []
    .concat(config.DEEPAI_API_KEYS || [])
    .concat(String(process.env.DEEPAI_API_KEYS || "").split(","))
    .map((k) => String(k || "").trim())
    .filter(Boolean);

  const instance = new AlexaAI({
    key,
    keys: extraKeys, // rotated automatically on "try it exceeded"
    postgresUrl,

    // --- model -------------------------------------------------------------
    // 'standard' is the safe free-tier default; anything else is tried first
    // and falls back automatically if DeepAI refuses it.
    model: config.CHAT_MODEL || process.env.CHAT_MODEL || "standard",
    fallbackModels: ["gpt-4o-mini", "standard"],
    visionModel: "gpt-4o-mini",

    // --- persona -----------------------------------------------------------
    // NOTHING here on purpose: the engine's default Alexa system prompt is
    // used, together with the identity lock and the memory guard.

    // --- conversation tuning ------------------------------------------------
    historyLimit: 14, // past messages replayed to the model
    maxMemories: 25, // facts injected per request
    sharedGroupThread: false, // false = each member has their own thread

    // --- identity -----------------------------------------------------------
    linkIdentities: true, // @lid <-> phone jid are the same human
    mergeIdentities: true, // fold duplicate rows together when proven

    // --- images ---------------------------------------------------------------
    ocr: true, // read text inside screenshots on free keys
    ocrApiKey: config.OCR_API_KEY || process.env.OCR_API_KEY, // optional

    // --- infrastructure -------------------------------------------------------
    timeout: 60000,
    maxRetries: 2,
    autoMigrate: true, // create tables on first run
    debug: Boolean(config.AI_DEBUG || process.env.AI_DEBUG),
  });

  assertEngineVersion(instance);
  engine = instance;

  console.log(`✅ Alexa AI engine ready (alexa-ai ${AlexaAI.version}, DeepAI + PostgreSQL)`);
  return engine;
}

// ---------------------------------------------------------------------------
//  Input normalisation
// ---------------------------------------------------------------------------

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".log": "text/plain",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function guessMime(filePath) {
  return (
    MIME_BY_EXT[path.extname(String(filePath)).toLowerCase()] || "image/jpeg"
  );
}

function isReadableFile(p) {
  try {
    return typeof p === "string" && p.length < 4096 && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Turn anything the bot might hand us into something the engine accepts.
 *
 * The engine itself (>= 2.1.0) already understands Buffer · Uint8Array ·
 * data URI · raw base64 · http(s) URL · { buffer } · { url } · { base64 } ·
 * { data }. The only thing it cannot do is read the bot's DISK, so local
 * paths and `{ path }` objects are loaded here; everything else is passed
 * through untouched.
 *
 * @returns {object|Buffer|string|null}
 */
function toMedia(file) {
  if (!file) return null;

  if (typeof file === "string" && !/^data:|^https?:\/\//i.test(file) && isReadableFile(file)) {
    return {
      buffer: fs.readFileSync(file),
      mimetype: guessMime(file),
      filename: path.basename(file),
    };
  }

  if (file && typeof file === "object" && !Buffer.isBuffer(file) && !(file instanceof Uint8Array)) {
    if (!file.buffer && !file.url && !file.base64 && !file.data && file.path && isReadableFile(file.path)) {
      return {
        buffer: fs.readFileSync(file.path),
        mimetype: file.mimetype || guessMime(file.path),
        filename: file.filename || path.basename(file.path),
      };
    }
  }

  // Buffers, base64, data URIs, URLs and { buffer | url | base64 } objects:
  // the engine normalises these itself.
  return file;
}

/**
 * Turn whatever the bot knows about the sender into the address list the
 * engine needs. See the IDENTITY note at the top of the file.
 *
 * Accepts:
 *   'x@lid'                                    (classic — still works)
 *   ['x@lid', '947...@s.whatsapp.net']
 *   { id, lid, phone, aliases: [] }
 */
function toIdentity(userId) {
  if (Array.isArray(userId)) {
    const list = userId.map(String).filter(Boolean);
    return { userId: list[0] || "default_user", aliases: list.slice(1) };
  }
  if (userId && typeof userId === "object") {
    const primary = userId.id || userId.jid || userId.lid || userId.phone;
    return {
      userId: String(primary || "default_user"),
      userLid: userId.lid ? String(userId.lid) : undefined,
      userPhone: userId.phone ? String(userId.phone) : undefined,
      aliases: (userId.aliases || []).map(String).filter(Boolean),
    };
  }
  return { userId: String(userId || "default_user") };
}

// ---------------------------------------------------------------------------
//  Main entry point
// ---------------------------------------------------------------------------

/**
 * Main AI function — same signature as the old Gradio implementation.
 *
 * @param {string|{text:string, files:Array}} message
 * @param {string|string[]|{id:string,lid?:string,phone?:string}} userId
 * @param {string} [groupId] e.g. '120363413125431525@g.us' ("" for DM)
 * @param {string} [userName]
 * @param {function} [callback] (err, reply)
 * @param {object} [options] extra per-call options: { groupName, messageId,
 *        isAdmin, model, webAccess, thinking, onToken, signal, full }
 * @returns {Promise<string>} the reply text ('' on failure)
 */
async function ai(
  message,
  userId,
  groupId = "",
  userName = "User",
  callback,
  options = {},
) {
  try {
    const client = getEngine();

    // --- normalise the message shape (string OR { text, files }) -----------
    let text = "";
    let media = null;

    if (typeof message === "string") {
      text = message;
    } else if (typeof message === "object" && message !== null) {
      text = message.text || message.body || message.caption || "";

      // `files` may hold a Buffer, a URL, a local path, a raw base64 string, a
      // data URI, or an object. `image` / `base64` / `file` are also accepted.
      const file =
        (Array.isArray(message.files) ? message.files.find(Boolean) : null) ||
        message.image ||
        message.file ||
        message.base64 ||
        null;

      media = toMedia(file);
    }

    if (!text && !media) {
      if (typeof callback === "function") callback(null, "");
      return "";
    }

    // --- ask Alexa ----------------------------------------------------------
    const result = await client.chat({
      ...toIdentity(userId),
      message: text,
      groupId: groupId ? String(groupId) : null,
      groupName: options.groupName || null,
      userName: String(userName || "User"),
      image: media,
      messageId: options.messageId || null,
      isAdmin: Boolean(options.isAdmin),
      model: options.model,
      webAccess: options.webAccess,
      thinking: options.thinking,
      onToken: options.onToken,
      signal: options.signal,
    });

    // Blocked users / disabled groups come back as an empty reply on purpose:
    // the bot should simply stay silent.
    const reply = result.text || "";

    if (typeof callback === "function") callback(null, reply);
    // `full: true` gives you chunks, generated image urls, memories, timings…
    return options.full ? result : reply;
  } catch (err) {
    console.error("❌ Error in Alexa AI call:", err.message);
    if (typeof callback === "function") callback(err.message, null);
    return options.full ? { text: "", error: err.message, chunks: [] } : "";
  }
}

/**
 * Convenience wrapper for Baileys: extracts the sender, the LID/phone pair,
 * the group, the push name and any attached image from a raw message object.
 *
 *   const reply = await ai.fromMessage(msg, sock);
 *
 * @param {object} msg   a Baileys `messages.upsert` message
 * @param {object} [sock] the Baileys socket (used to download media, optional)
 * @param {object} [options] forwarded to ai()
 */
ai.fromMessage = async (msg, sock = null, options = {}) => {
  const info = msg?.message || {};
  const remoteJid = msg?.key?.remoteJid || "";
  const isGroup = remoteJid.endsWith("@g.us");

  const sender = isGroup ? msg?.key?.participant || remoteJid : remoteJid;
  const senderAlt =
    msg?.key?.participantAlt ||
    msg?.key?.participantPn ||
    msg?.key?.senderPn ||
    null;

  const text =
    info.conversation ||
    info.extendedTextMessage?.text ||
    info.imageMessage?.caption ||
    info.videoMessage?.caption ||
    info.documentMessage?.caption ||
    "";

  // Download an attached image/document when the socket is available.
  let files = [];
  const mediaNode = info.imageMessage || info.documentMessage || null;
  if (mediaNode && sock?.downloadMediaMessage) {
    try {
      const buffer = await sock.downloadMediaMessage(msg);
      if (buffer) {
        files = [
          {
            buffer,
            mimetype: mediaNode.mimetype || "image/jpeg",
            filename: mediaNode.fileName || "image.jpg",
          },
        ];
      }
    } catch (err) {
      console.warn("⚠️  Could not download media:", err.message);
    }
  }

  return ai(
    { text, files },
    { id: sender, phone: senderAlt || undefined },
    isGroup ? remoteJid : "",
    msg?.pushName || "User",
    undefined,
    { messageId: msg?.key?.id || null, ...options },
  );
};

// ---------------------------------------------------------------------------
//  Extras — handy for bot commands. Ignore them if you don't need them.
//  None of these throw: every one returns `{ ok, ... }` (or a row / value),
//  so a command handler can do `if (!r.ok) return reply(r.message)`.
// ---------------------------------------------------------------------------

/** `.forget` command — wipe everything Alexa remembers about a user. */
ai.forgetUser = async (userId) => getEngine().forgetAll(userId);

/** `.memory` command — show what Alexa remembers. */
ai.getMemories = async (userId) => getEngine().getMemories(userId);

/** Teach Alexa one fact by hand. */
ai.remember = async (userId, key, value) =>
  getEngine().remember(userId, key, value);

/** Forget one fact. */
ai.forget = async (userId, key) => getEngine().forget(userId, key);

/** `.reset` command — clear the chat transcript (memories are kept). */
ai.clearHistory = async (userId, groupId = null) =>
  getEngine().clearHistory(userId, groupId || null);

/** Block / unblock a user from using the AI (any of their addresses works). */
ai.blockUser = async (userId) => getEngine().blockUser(userId);
ai.unblockUser = async (userId) => getEngine().unblockUser(userId);
ai.isBlocked = async (userId) => getEngine().isBlocked(userId);

/** Turn Alexa on/off inside one group (works before she has spoken there). */
ai.setGroupEnabled = async (groupId, enabled) =>
  getEngine().setGroupEnabled(groupId, enabled);
ai.isGroupEnabled = async (groupId) => getEngine().isGroupEnabled(groupId);

/** Full profile: user row + memories + threads. */
ai.getProfile = async (userId) => getEngine().getProfile(userId);

// --- identity ---------------------------------------------------------------

/**
 * Tell Alexa two WhatsApp addresses are the same human. Call it whenever
 * Baileys reveals a mapping:
 *
 *   const pn = await sock.signalRepository.lidMapping.getPNForLID(lid);
 *   if (pn) await ai.linkIdentity(lid, pn);
 */
ai.linkIdentity = async (jidA, jidB) => getEngine().linkIdentity(jidA, jidB);

ai.getAliases = async (userId) => getEngine().getAliases(userId);

ai.whoIs = async (userId) => getEngine().whoIs(userId);

// --- media & extras ----------------------------------------------------------

/**
 * `.image <prompt>` — text-to-image. `{ ok, url, via, error, message }`.
 * On free keys `/api/text2img` is refused ("Out of API credits"); the engine
 * then drives DeepAI's in-chat image tool automatically, so this works on
 * the same `tryit-…` key as chat.
 *
 *   const r = await ai.generateImage(prompt);
 *   if (r.ok) await sock.sendMessage(jid, { image: { url: r.url }, caption: prompt });
 *   else      await sock.sendMessage(jid, { text: `Couldn't draw that: ${r.message}` });
 */
ai.generateImage = async (prompt, opts) =>
  getEngine().generateImage(prompt, opts);

ai.editImage = async (file, prompt) =>
  getEngine().editImage(toMedia(file), prompt);

ai.upscaleImage = async (file) => getEngine().upscaleImage(toMedia(file));

ai.colorizeImage = async (file) => getEngine().colorizeImage(toMedia(file));

ai.detectNsfw = async (file) => getEngine().detectNsfw(toMedia(file));

/** `{ ok, text, description, source }` — `text` is ready to send as-is. */
ai.describeImage = async (file, caption = "") =>
  getEngine().describeImage(toMedia(file), caption);

ai.summarizeText = async (text) => getEngine().summarizeText(text);

/**
 * `.search <query>` — one-off web research, no memory writes.
 * `{ ok, text, answer, sources: [{ title, url }], error, message }`
 *
 * `text` is the full WhatsApp message: a long, sectioned answer followed by
 * one *Sources:* block. A short first reply is retried once automatically
 * (`attempts` tells you). Pass `{ detail: "short" }` for a 2–4 sentence
 * reply, `{ includeSources: false }` to keep the block out of `text`, or
 * `{ language: "Sinhala" }` to answer in another language. Long answers can
 * be split with `AlexaAI.ResponseFormatter.chunk(text)` if they exceed a
 * single message.
 */
ai.searchWeb = async (query, opts) => getEngine().searchWeb(query, opts);

// --- ops ----------------------------------------------------------------------

ai.stats = async () => getEngine().stats();

ai.health = async () => getEngine().health();

ai.deepaiHealth = async () => getEngine().deepaiHealth();

ai.engine = () => getEngine();

ai.version = () => AlexaAI.version;

ai.init = async () => getEngine().init();
ai.close = async () => {
  if (engine) {
    await engine.close();
    engine = null;
  }
};

module.exports = ai;
