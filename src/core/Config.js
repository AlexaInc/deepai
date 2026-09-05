'use strict';

const Persona = require('./Persona');
const { ENDPOINTS } = require('./Endpoints');

/**
 * Config
 * ------
 * Central, validated configuration object. Every subsystem receives an
 * instance of this class instead of reaching into `process.env`, which keeps
 * the engine testable and lets the host bot pass values inline:
 *
 *   new AlexaAI({ key: 'deepaikey', postgresUrl: 'postgres://...' })
 */
class Config {
    /**
     * @param {object} options
     * @param {string} options.key                 DeepAI api-key (tryit-... or account key)
     * @param {string[]} [options.keys]            Extra keys to rotate through on quota errors
     * @param {string} options.postgresUrl         PostgreSQL connection string
     * @param {string} [options.model]             DeepAI model id
     * @param {string[]} [options.fallbackModels]  Tried in order when the main model is refused
     * @param {string} [options.visionModel]       Model used when images are attached
     * @param {string[]} [options.visionModels]    Vision fallback chain
     * @param {string} [options.imageModel]        Model used by generateImage()
     * @param {string} [options.assistantName]     Persona name (default 'Alexa')
     * @param {string} [options.creator]           Persona creator (default 'Hansaka')
     * @param {string} [options.systemPrompt]      Override the whole persona text
     * @param {boolean} [options.systemRole]       Also send a role:'system' turn (default true)
     * @param {object} [options.endpoints]         Override any DeepAI route
     * @param {number} [options.historyLimit]      Messages replayed to the model
     * @param {number} [options.maxMemories]       Memory rows injected per request
     * @param {number} [options.timeout]           Per-request timeout (ms)
     * @param {number} [options.maxRetries]        Network retry attempts
     * @param {boolean} [options.sharedGroupThread] One shared thread per group
     * @param {boolean} [options.autoMigrate]      Create tables on first connect
     * @param {boolean} [options.debug]            Verbose logging
     * @param {object} [options.pool]              Extra node-postgres pool options
     * @param {boolean|object} [options.ssl]       SSL config passed to pg
     */
    constructor(options = {}) {
        const opts = options || {};

        // ---- Accept several aliases so the host bot can stay terse ----------
        const key = opts.key || opts.apiKey || opts.deepaiKey || process.env.DEEPAI_API_KEY;
        const postgresUrl =
            opts.postgresUrl ||
            opts.postgresURL ||
            opts.postgueurl ||
            opts.postgres ||
            opts.databaseUrl ||
            opts.connectionString ||
            process.env.POSTGRES_URL ||
            process.env.DATABASE_URL;

        if (!key || typeof key !== 'string') {
            throw new TypeError(
                "AlexaAI: 'key' is required. Example: new AlexaAI({ key: 'tryit-...', postgresUrl: 'postgres://...' })"
            );
        }
        if (!postgresUrl || typeof postgresUrl !== 'string') {
            throw new TypeError(
                "AlexaAI: 'postgresUrl' is required. Example: new AlexaAI({ key: '...', postgresUrl: 'postgres://user:pass@host:5432/db' })"
            );
        }

        this.key = key.trim();
        this.postgresUrl = postgresUrl.trim();

        // Extra keys are rotated to when DeepAI answers "try it exceeded".
        this.keys = Array.from(
            new Set(
                [this.key]
                    .concat(Array.isArray(opts.keys) ? opts.keys : [])
                    .concat(String(process.env.DEEPAI_API_KEYS || '').split(','))
                    .map((k) => String(k || '').trim())
                    .filter(Boolean)
            )
        );
        // Generate a fresh anonymous "tryit" key when every configured key is
        // exhausted. Off by default: it only works while DeepAI keeps issuing
        // anonymous keys client-side.
        this.autoKeyRotation = opts.autoKeyRotation === true;

        // ---- DeepAI endpoint / model ---------------------------------------
        this.baseUrl = (opts.baseUrl || 'https://api.deepai.org').replace(/\/+$/, '');
        this.origin = opts.origin || 'https://deepai.org';
        this.endpoints = { ...ENDPOINTS, ...(opts.endpoints || {}) };
        // Back-compat: the old flat options still win if supplied.
        if (opts.chatPath) this.endpoints.chat = opts.chatPath;
        if (opts.uploadPath) this.endpoints.attachmentUpload = opts.uploadPath;
        this.chatPath = this.endpoints.chat;
        this.uploadPath = this.endpoints.attachmentUpload;

        this.chatStyle = opts.chatStyle || 'chat';
        this.model = opts.model || 'standard';
        this.fallbackModels = Config._list(opts.fallbackModels, ['standard']).filter((m) => m !== this.model);
        // Vision requests are routed to a vision-capable model. On anonymous
        // "tryit" keys DeepAI downgrades this server-side; ImageDescriber
        // detects that and degrades gracefully.
        this.visionModel = opts.visionModel || 'gpt-4o-mini';
        this.visionModels = Config._list(opts.visionModels, [
            this.visionModel,
            'gpt-4.1-mini',
            'gpt-4o',
            'standard',
        ]);
        this.imageModel = opts.imageModel || 'text2img';

        // ---- Chat request feature flags (mirrors the deepai.org client) -----
        this.enabledTools = Config._list(opts.enabledTools, ['image_generator', 'image_editor']);
        this.toolActivitySupport = opts.toolActivitySupport !== false;
        this.thinkingImageToolSupport = opts.thinkingImageToolSupport !== false;
        this.thinkingSupport = opts.thinkingSupport === true; // needs a reasoning model
        this.serverMemory = opts.serverMemory === true; // DeepAI's own /chat_memory profile
        this.webAccess = opts.webAccess === true; // DeepAI web search
        this.sandbox = opts.sandbox === true; // "agent mode" (pro only)
        this.concierge = opts.concierge === true; // background tasks (pro only)
        this.sendSessionUuid = opts.sendSessionUuid !== false;
        this.checkSensitivity = opts.checkSensitivity === true;
        this.saveRemoteSessions = opts.saveRemoteSessions === true;
        this.taskPollInterval = Config._int(opts.taskPollInterval, 1500, 250, 15000);
        this.taskPollTimeout = Config._int(opts.taskPollTimeout, 120000, 5000, 600000);

        // ---- Persona --------------------------------------------------------
        this.assistantName = String(opts.assistantName || 'Alexa').trim() || 'Alexa';
        this.creator = String(opts.creator || opts.creatorName || 'Hansaka').trim() || 'Hansaka';
        this.systemPrompt =
            opts.systemPrompt ||
            Persona.build({ assistantName: this.assistantName, creator: this.creator });
        // DeepAI historically ignored role:'system'; sending it anyway costs
        // nothing and helps every backend that *does* honour it.
        this.systemRole = opts.systemRole !== false;
        this.identityLock = opts.identityLock !== false;
        this.amnesiaGuard = opts.amnesiaGuard !== false;

        // ---- Conversation / memory tuning -----------------------------------
        this.historyLimit = Config._int(opts.historyLimit, 14, 2, 60);
        this.maxMemories = Config._int(opts.maxMemories, 25, 0, 200);
        this.maxMessageLength = Config._int(opts.maxMessageLength, 8000, 100, 100000);
        this.sharedGroupThread = Boolean(opts.sharedGroupThread);
        // Link @lid <-> phone jids so one human is one row (see IdentityResolver).
        this.linkIdentities = opts.linkIdentities !== false;
        this.mergeIdentities = opts.mergeIdentities !== false;

        // ---- Vision / OCR ----------------------------------------------------
        // DeepAI's own vision needs a PAID key (free 'tryit' keys are
        // downgraded to a text-only model), so OCR is used as a fallback to
        // read screenshots, documents and error messages.
        this.ocrEnabled = opts.ocr !== false;
        this.ocrUrl = opts.ocrUrl || 'https://api.ocr.space/parse/image';
        this.ocrApiKey = opts.ocrApiKey || process.env.OCR_API_KEY || 'helloworld';
        this.ocrLanguage = opts.ocrLanguage || 'eng';
        this.ocrTimeout = Config._int(opts.ocrTimeout, 25000, 1000, 120000);
        this.maxImageBytes = Config._int(opts.maxImageBytes, 12 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024);

        // ---- Networking ------------------------------------------------------
        this.timeout = Config._int(opts.timeout, 60000, 1000, 600000);
        this.maxRetries = Config._int(opts.maxRetries, 2, 0, 10);
        this.retryDelay = Config._int(opts.retryDelay, 800, 0, 30000);
        this.userAgent =
            opts.userAgent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

        // ---- Database --------------------------------------------------------
        this.autoMigrate = opts.autoMigrate !== false; // default true
        this.schema = opts.schema || 'public';
        this.ssl = Config._resolveSsl(opts.ssl, this.postgresUrl);
        this.pool = Object.assign(
            { max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 },
            opts.pool || {}
        );

        this.debug = Boolean(opts.debug);
        this.logger = opts.logger || console;

        Object.freeze(this.pool);
    }

    /**
     * Managed Postgres (Supabase/Neon/Heroku/Railway) almost always needs SSL
     * but ships self-signed chains, so default to relaxed verification unless
     * the caller says otherwise or connects to localhost.
     */
    static _resolveSsl(ssl, url) {
        if (ssl !== undefined) return ssl;
        const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(url) || /host=(localhost|127\.0\.0\.1)/i.test(url);
        if (isLocal) return false;
        if (/[?&]sslmode=disable/i.test(url)) return false;
        return { rejectUnauthorized: false };
    }

    static _int(value, fallback, min, max) {
        const n = Number.parseInt(value, 10);
        if (Number.isNaN(n)) return fallback;
        return Math.min(Math.max(n, min), max);
    }

    static _list(value, fallback) {
        const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null;
        if (!source) return [...fallback];
        const cleaned = source.map((v) => String(v || '').trim()).filter(Boolean);
        return cleaned.length ? Array.from(new Set(cleaned)) : [...fallback];
    }

    /** Absolute URL for a named endpoint (`url('chat')`). */
    url(name, query = null) {
        const path = this.endpoints[name] || name;
        const base = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
        if (!query) return base;
        const qs = new URLSearchParams(
            Object.entries(query).filter(([, v]) => v !== undefined && v !== null)
        ).toString();
        return qs ? `${base}?${qs}` : base;
    }

    get chatUrl() {
        return this.url('chat');
    }

    get uploadUrl() {
        return this.url('attachmentUpload');
    }

    /** Redacted view, safe to log. */
    toJSON() {
        return {
            baseUrl: this.baseUrl,
            model: this.model,
            fallbackModels: this.fallbackModels,
            visionModels: this.visionModels,
            assistantName: this.assistantName,
            creator: this.creator,
            historyLimit: this.historyLimit,
            maxMemories: this.maxMemories,
            sharedGroupThread: this.sharedGroupThread,
            linkIdentities: this.linkIdentities,
            timeout: this.timeout,
            maxRetries: this.maxRetries,
            autoMigrate: this.autoMigrate,
            schema: this.schema,
            keys: this.keys.length,
            key: `${this.key.slice(0, 10)}…`,
            postgresUrl: this.postgresUrl.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@'),
        };
    }
}

module.exports = Config;
