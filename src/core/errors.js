'use strict';

/** Base class for every error thrown by the engine. */
class AlexaAIError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = this.constructor.name;
        this.code = options.code || 'ALEXA_AI_ERROR';
        this.retryable = Boolean(options.retryable);
        if (options.cause) this.cause = options.cause;
        Error.captureStackTrace?.(this, this.constructor);
    }
}

/** Network/HTTP/parse failure talking to DeepAI. */
class DeepAIError extends AlexaAIError {
    constructor(message, options = {}) {
        super(message, { code: options.code || 'DEEPAI_ERROR', ...options });
        this.status = options.status ?? null;
        this.body = options.body ?? null;
    }
}

/** DeepAI refused the request: quota, paid-model, or auth. */
class QuotaExceededError extends DeepAIError {
    constructor(message, options = {}) {
        super(message, { code: 'DEEPAI_QUOTA_EXCEEDED', retryable: false, ...options });
    }
}

/** PostgreSQL failure. */
class DatabaseError extends AlexaAIError {
    constructor(message, options = {}) {
        super(message, { code: options.code || 'DATABASE_ERROR', ...options });
    }
}

/** Bad arguments handed to a public method. */
class ValidationError extends AlexaAIError {
    constructor(message, options = {}) {
        super(message, { code: 'VALIDATION_ERROR', retryable: false, ...options });
    }
}

module.exports = {
    AlexaAIError,
    DeepAIError,
    QuotaExceededError,
    DatabaseError,
    ValidationError,
};
