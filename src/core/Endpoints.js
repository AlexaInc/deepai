'use strict';

/**
 * Endpoints
 * ---------
 * Every DeepAI route the engine knows how to talk to.
 *
 * These were taken from the live deepai.org chat client, so the engine speaks
 * the *whole* API instead of only POSTing to the generative endpoint:
 *
 *   POST /hacking_is_a_serious_crime      chat completion (streamed text)
 *   GET  /check_chat_task_status          poll a background task (thinking, memory refresh)
 *   GET  /check-sensitivity               per-request sensitivity score
 *   POST /chat_attachments/upload         upload an image/document
 *   GET  /chat_attachments/get            attachment + server-side extraction status
 *   POST /save_chat_session               persist a transcript server-side
 *   GET  /get_chat_session                load a transcript
 *   POST /delete_chat_session             delete one transcript
 *   POST /rename_chat_session             rename one transcript
 *   POST /delete_all_chat_history         nuke every transcript
 *   GET/POST /chat_memory                 DeepAI's own long-term memory profile
 *   GET/POST /chat_sandbox                agent-mode ("sandbox") toggle
 *   GET/POST /chat_concierge              concierge/background-task toggle
 *   POST /report_character                abuse report
 *   POST /api/<name>                      the classic public API family
 *                                         (text2img, image-editor, torch-srgan,
 *                                          colorizer, nsfw-detector, …)
 *
 * All of them are overridable through `new AlexaAI({ endpoints: {...} })` so a
 * future DeepAI rename never requires a code change.
 */
const ENDPOINTS = {
    chat: '/hacking_is_a_serious_crime',
    taskStatus: '/check_chat_task_status',
    sensitivity: '/check-sensitivity',
    attachmentUpload: '/chat_attachments/upload',
    attachmentGet: '/chat_attachments/get',
    saveSession: '/save_chat_session',
    getSession: '/get_chat_session',
    deleteSession: '/delete_chat_session',
    renameSession: '/rename_chat_session',
    deleteAllSessions: '/delete_all_chat_history',
    memory: '/chat_memory',
    sandbox: '/chat_sandbox',
    concierge: '/chat_concierge',
    reportCharacter: '/report_character',
    api: '/api',
};

/**
 * Public "standard API" operations. `AlexaAI.deepai.runApi(name, fields)` can
 * call any of them; the named helpers below just document the common ones.
 */
const STANDARD_APIS = {
    text2img: 'text2img',
    imageEditor: 'image-editor',
    superResolution: 'torch-srgan',
    waifu2x: 'waifu2x',
    colorizer: 'colorizer',
    nsfwDetector: 'nsfw-detector',
    imageSimilarity: 'image-similarity',
    textTagging: 'text-tagging',
    summarization: 'summarization',
    sentiment: 'sentiment-analysis',
    textGenerator: 'text-generator',
};

/** Task types accepted by `/check_chat_task_status?type=…`. */
const TASK_TYPES = {
    thinking: 'thinking-task',
    memoryRefresh: 'memory-refresh-task',
};

module.exports = { ENDPOINTS, STANDARD_APIS, TASK_TYPES };
