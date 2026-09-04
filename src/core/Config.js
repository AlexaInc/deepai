'use strict';

const SYSTEM_PROMPT = require('./SystemPrompt');

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
     * @param {string} options.postgresUrl         PostgreSQL connection string
     * @param {string} [options.model]             DeepAI model id
     * @param {string} [options.visionModel]       Model used when images are attached
     * @param {string} [options.systemPrompt]      Override the Alexa persona
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

        // ---- DeepAI endpoint / model ---------------------------------------
        this.baseUrl = (opts.baseUrl || 'https://api.deepai.org').replace(/\/+$/, '');
        this.chatPath = opts.chatPath || '/hacking_is_a_serious_crime';
        this.uploadPath = opts.uploadPath || '/chat_attachments/upload';
        this.chatStyle = opts.chatStyle || 'chat';
        this.model = opts.model || 'standard';
        // Vision requests are routed to a vision-capable model. On anonymous
        // "tryit" keys DeepAI downgrades this server-side; ImageDescriber
        // detects that and degrades gracefully.
        this.visionModel = opts.visionModel || 'gpt-4o-mini';

        // ---- Persona --------------------------------------------------------
        this.systemPrompt = opts.systemPrompt || SYSTEM_PROMPT;

        // ---- Conversation / memory tuning -----------------------------------
        this.historyLimit = Config._int(opts.historyLimit, 14, 2, 60);
        this.maxMemories = Config._int(opts.maxMemories, 25, 0, 200);
        this.maxMessageLength = Config._int(opts.maxMessageLength, 8000, 100, 100000);
        this.sharedGroupThread = Boolean(opts.sharedGroupThread);

        // ---- Vision / OCR ----------------------------------------------------
        // DeepAI's own vision needs a PAID key (free 'tryit' keys are
        // downgraded to a text-only model), so OCR is used as a fallback to
        // read screenshots, documents and error messages.
        this.ocrEnabled = opts.ocr !== false;
        this.ocrUrl = opts.ocrUrl || 'https://api.ocr.space/parse/image';
        this.ocrApiKey = opts.ocrApiKey || process.env.OCR_API_KEY || 'helloworld';
        this.ocrLanguage = opts.ocrLanguage || 'eng';
        this.ocrTimeout = Config._int(opts.ocrTimeout, 25000, 1000, 120000);

        // ---- Networking ------------------------------------------------------
        this.timeout = Config._int(opts.timeout, 60000, 1000, 600000);
        this.maxRetries = Config._int(opts.maxRetries, 2, 0, 10);
        this.retryDelay = Config._int(opts.retryDelay, 800, 0, 30000);

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

    get chatUrl() {
        return `${this.baseUrl}${this.chatPath}`;
    }

    get uploadUrl() {
        return `${this.baseUrl}${this.uploadPath}`;
    }

    /** Redacted view, safe to log. */
    toJSON() {
        return {
            baseUrl: this.baseUrl,
            model: this.model,
            visionModel: this.visionModel,
            historyLimit: this.historyLimit,
            maxMemories: this.maxMemories,
            sharedGroupThread: this.sharedGroupThread,
            timeout: this.timeout,
            maxRetries: this.maxRetries,
            autoMigrate: this.autoMigrate,
            schema: this.schema,
            key: `${this.key.slice(0, 10)}…`,
            postgresUrl: this.postgresUrl.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@'),
        };
    }
}

module.exports = Config;
