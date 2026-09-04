/**
 * src/modules/Aii.js  (or callai.js — whichever your bot requires)
 * ---------------------------------------------------------------------------
 * Alexa's AI layer, now powered by the `alexa-ai` package (DeepAI + PostgreSQL)
 * instead of the Hugging Face Gradio Space.
 *
 * DROP-IN COMPATIBLE: the exported function keeps the exact same signature as
 * the old Gradio version, so no call site in the bot has to change:
 *
 *     ai(message, userId, groupId, userName, callback)
 *
 *   • `message` may be a string OR { text: "...", files: [...] }
 *   • `userId`  is the sender jid  ('78151912841263@lid', '947...@s.whatsapp.net')
 *   • `groupId` is the group jid   ('120363413125431525@g.us') or "" for a DM
 *   • `userName` is the WhatsApp push name
 *   • `callback(err, reply)` is optional; the function also returns the reply
 *
 * WHAT YOU GAIN OVER THE OLD VERSION
 *   • No Hugging Face Space to keep warm (no cold starts, no ZeroGPU quota).
 *   • Real long-term memory in PostgreSQL: the same person is recognised in
 *     DMs and in every group.
 *   • The 4 strict triggers (weather/menu/ping/doc) are guaranteed byte-exact.
 *   • WhatsApp formatting is enforced (never ** or #).
 *
 * REQUIRED .env
 *   DEEPAI_API_KEY=tryit-6809613270-caa24a28a55047b221b1123dd19c696a
 *   POSTGRES_URL=postgres://user:pass@host:5432/dbname
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const config = require("../config");
const AlexaAI = require("alexa-ai");

/** Singleton engine — one PostgreSQL pool for the whole bot. */
let engine = null;

/** Create (once) and return the AI engine. */
function getEngine() {
  if (engine) return engine;

  const key = config.DEEPAI_API_KEY || process.env.DEEPAI_API_KEY;
  const postgresUrl =
    config.POSTGRES_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;

  if (!key) throw new Error("DEEPAI_API_KEY is missing from .env");
  if (!postgresUrl) throw new Error("POSTGRES_URL is missing from .env");

  engine = new AlexaAI({
    key,
    postgresUrl,

    // --- tuning (all optional) ---------------------------------------------
    model: "standard", // free-tier DeepAI model
    historyLimit: 14, // past messages replayed to the model
    maxMemories: 25, // facts injected per request
    sharedGroupThread: false, // false = each member has their own thread
    timeout: 60000,
    maxRetries: 2,
    autoMigrate: true, // create tables on first run
    debug: false,
  });

  console.log("✅ Alexa AI engine ready (DeepAI + PostgreSQL)");
  return engine;
}


/**
 * Normalise anything the bot might hand us into the { buffer | url } shape the
 * engine expects.
 *
 * Accepts: Buffer | data-URI | raw base64 | http(s) URL | local file path |
 *          { buffer, mimetype, filename }
 * @returns {object|null}
 */
function toImage(file) {
  if (!file) return null;

  if (Buffer.isBuffer(file)) {
    return { buffer: file, mimetype: "image/jpeg", filename: "image.jpg" };
  }

  if (typeof file === "string") {
    // data:image/jpeg;base64,....
    const dataUri = file.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (dataUri) {
      return {
        buffer: Buffer.from(dataUri[2], "base64"),
        mimetype: dataUri[1],
        filename: "image." + dataUri[1].split("/")[1],
      };
    }

    // remote URL
    if (/^https?:\/\//i.test(file)) return { url: file };

    // local path
    if (fs.existsSync(file)) {
      return {
        buffer: fs.readFileSync(file),
        mimetype: guessMime(file),
        filename: path.basename(file),
      };
    }

    // bare base64 (no data: prefix)
    if (/^[A-Za-z0-9+/]+=*$/.test(file) && file.length > 100) {
      return {
        buffer: Buffer.from(file, "base64"),
        mimetype: "image/jpeg",
        filename: "image.jpg",
      };
    }
    return null;
  }

  if (typeof file === "object") {
    // already { buffer, mimetype } — or { path } / { url }
    if (file.buffer || file.url) return file;
    if (file.path && fs.existsSync(file.path)) {
      return {
        buffer: fs.readFileSync(file.path),
        mimetype: file.mimetype || guessMime(file.path),
        filename: path.basename(file.path),
      };
    }
  }
  return null;
}

function guessMime(p) {
  const ext = path.extname(p).toLowerCase();
  return (
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
    }[ext] || "image/jpeg"
  );
}

/**
 * Main AI function — same signature as the old Gradio implementation.
 *
 * @param {string|{text:string, files:Array}} message
 * @param {string} userId    e.g. '78151912841263@lid'
 * @param {string} [groupId] e.g. '120363413125431525@g.us' ("" for DM)
 * @param {string} [userName]
 * @param {function} [callback] (err, reply)
 * @returns {Promise<string>} the reply text
 */
async function ai(message, userId, groupId = "", userName = "User", callback) {
  try {
    const client = getEngine();

    // --- normalise the message shape (string OR { text, files }) -----------
    let text = "";
    let image = null;

    if (typeof message === "string") {
      text = message;
    } else if (typeof message === "object" && message !== null) {
      text = message.text || "";

      // `files` may hold a Buffer, a URL, a local path, a raw base64 string,
      // or a data URI ("data:image/jpeg;base64,...."). Also accept
      // `message.image` / `message.base64` for convenience.
      const file =
        (Array.isArray(message.files) ? message.files[0] : null) ||
        message.image ||
        message.base64 ||
        null;

      image = toImage(file);
    }

    // --- ask Alexa ----------------------------------------------------------
    const result = await client.chat({
      message: text,
      userId: String(userId || "default_user"),
      groupId: groupId ? String(groupId) : null,
      userName: String(userName || "User"),
      image,
    });

    const reply = result.text || "";

    if (typeof callback === "function") callback(null, reply);
    return reply;
  } catch (err) {
    console.error("❌ Error in Alexa AI call:", err.message);
    if (typeof callback === "function") callback(err.message, null);
    return "";
  }
}

// ---------------------------------------------------------------------------
//  Extras — handy for bot commands. Ignore them if you don't need them.
// ---------------------------------------------------------------------------

/** `.forget` command — wipe everything Alexa remembers about a user. */
ai.forgetUser = async (userId) => getEngine().forgetAll(userId);

/** `.memory` command — show what Alexa remembers. */
ai.getMemories = async (userId) => getEngine().getMemories(userId);

/** `.reset` command — clear the chat transcript (memories are kept). */
ai.clearHistory = async (userId, groupId = null) =>
  getEngine().clearHistory(userId, groupId || null);

/** Block / unblock a user from using the AI. */
ai.blockUser = async (userId) => getEngine().blockUser(userId);
ai.unblockUser = async (userId) => getEngine().unblockUser(userId);

/** Turn Alexa on/off inside one group. */
ai.setGroupEnabled = async (groupId, enabled) =>
  getEngine().setGroupEnabled(groupId, enabled);

/** Full profile: user row + memories + threads. */
ai.getProfile = async (userId) => getEngine().getProfile(userId);

/** Engine stats for the dashboard. */
ai.stats = async () => getEngine().stats();

/** Health probe. */
ai.health = async () => getEngine().health();

/** Close the PostgreSQL pool on shutdown. */
ai.close = async () => {
  if (engine) {
    await engine.close();
    engine = null;
  }
};

module.exports = ai;
