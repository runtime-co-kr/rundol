'use strict';

const TASK_STATES = Object.freeze(['todo', 'doing', 'waiting', 'review', 'done']);
const EXECUTORS = Object.freeze(['cli', 'llm', 'hybrid']);
const BRANCHES = Object.freeze({ settings: 'rundol/settings', project: (key) => `rundol/${key}` });

module.exports = { TASK_STATES, EXECUTORS, BRANCHES };
