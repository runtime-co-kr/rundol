'use strict';

const PROTOCOL_VERSION = 1;
const MESSAGE_TYPES = Object.freeze(['hello', 'snapshot', 'operation', 'ack', 'error']);

function envelope(type, payload, metadata) {
  if (!MESSAGE_TYPES.includes(type)) throw new Error(`Unsupported Rundol message type: ${type}`);
  return { protocolVersion: PROTOCOL_VERSION, type, payload: payload || null, metadata: metadata || {} };
}

module.exports = { PROTOCOL_VERSION, MESSAGE_TYPES, envelope };
