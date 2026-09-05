'use strict';

/**
 * The default Alexa persona, as a plain string (back-compatible export).
 * Use `require('./Persona').build({ assistantName, creator })` to rename her.
 */
module.exports = require('./Persona').SYSTEM_PROMPT;
