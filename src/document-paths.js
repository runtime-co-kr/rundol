'use strict';

const path = require('path');

const CANONICAL_PATHS = Object.freeze({
  PRD: 'prd',
  REQ: 'requirements',
  ARC: 'architecture',
  SCR: 'screens',
  MOD: 'model',
  API: 'api',
  ADR: 'adr',
  TST: 'tests',
  RUN: 'runbooks',
  GLS: 'glossary',
  NTE: 'inbox'
});

function canonicalDocumentPath(type, projectRoot) {
  if (!CANONICAL_PATHS[type]) throw new Error(`지원하지 않는 문서 유형입니다: ${type}`);
  return CANONICAL_PATHS[type] === 'inbox'
    ? path.join(projectRoot, 'inbox')
    : path.join(projectRoot, 'docs', CANONICAL_PATHS[type]);
}

module.exports = { CANONICAL_PATHS, canonicalDocumentPath };
