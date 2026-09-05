'use strict';

/**
 * alexa-ai — AI engine for the Alexa WhatsApp bot.
 *
 *   const AlexaAI = require('./alexa-ai');
 *   const ai = new AlexaAI({ key: 'deepaikey', postgresUrl: 'connection string' });
 *
 *   const { text } = await ai.chat({
 *       message : 'Hello!',
 *       userId  : '78151912841263@lid',
 *       groupId : '120363413125431525@g.us', // omit for a DM
 *       userName: 'Nimal',
 *   });
 */

const AlexaAI = require('./src/AlexaAI');
const Config = require('./src/core/Config');
const DeepAIClient = require('./src/core/DeepAIClient');
const Database = require('./src/db/Database');
const UserRepository = require('./src/repositories/UserRepository');
const MemoryRepository = require('./src/repositories/MemoryRepository');
const ConversationRepository = require('./src/repositories/ConversationRepository');
const IdentityRepository = require('./src/repositories/IdentityRepository');
const PromptBuilder = require('./src/services/PromptBuilder');
const MemoryExtractor = require('./src/services/MemoryExtractor');
const FactMiner = require('./src/services/FactMiner');
const MathDetector = require('./src/services/MathDetector');
const IdentityGuard = require('./src/services/IdentityGuard');
const AmnesiaGuard = require('./src/services/AmnesiaGuard');
const IdentityResolver = require('./src/services/IdentityResolver');
const ResponseFormatter = require('./src/services/ResponseFormatter');
const TriggerDetector = require('./src/services/TriggerDetector');
const ImageDescriber = require('./src/services/ImageDescriber');
const JidParser = require('./src/utils/JidParser');
const StreamParser = require('./src/core/StreamParser');
const Persona = require('./src/core/Persona');
const { ENDPOINTS, STANDARD_APIS, TASK_TYPES } = require('./src/core/Endpoints');
const SYSTEM_PROMPT = require('./src/core/SystemPrompt');
const errors = require('./src/core/errors');

module.exports = AlexaAI;

// Named exports for advanced use / testing.
module.exports.AlexaAI = AlexaAI;
module.exports.Config = Config;
module.exports.DeepAIClient = DeepAIClient;
module.exports.Database = Database;
module.exports.UserRepository = UserRepository;
module.exports.MemoryRepository = MemoryRepository;
module.exports.ConversationRepository = ConversationRepository;
module.exports.IdentityRepository = IdentityRepository;
module.exports.PromptBuilder = PromptBuilder;
module.exports.MemoryExtractor = MemoryExtractor;
module.exports.FactMiner = FactMiner;
module.exports.MathDetector = MathDetector;
module.exports.IdentityGuard = IdentityGuard;
module.exports.AmnesiaGuard = AmnesiaGuard;
module.exports.IdentityResolver = IdentityResolver;
module.exports.ResponseFormatter = ResponseFormatter;
module.exports.TriggerDetector = TriggerDetector;
module.exports.ImageDescriber = ImageDescriber;
module.exports.JidParser = JidParser;
module.exports.StreamParser = StreamParser;
module.exports.Persona = Persona;
module.exports.ENDPOINTS = ENDPOINTS;
module.exports.STANDARD_APIS = STANDARD_APIS;
module.exports.TASK_TYPES = TASK_TYPES;
module.exports.SYSTEM_PROMPT = SYSTEM_PROMPT;
module.exports.errors = errors;
Object.assign(module.exports, errors);
