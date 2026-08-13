'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const profile = require('../src/document-profile');
const { evaluateDocumentContract } = require('../src/document-contract');

const v1 = `---\nid: project:demo\ndocumentProfile:\n  schemaVersion: 1\n  revision: 2\n  name: service\n  traits: [api, operations]\n  history: [service]\n  policy:\n    required: [PRD, REQ, API, RUN]\n    recommended: [ARC, MOD, TST]\n    onDemand: [SCR, ADR, GLS]\n    disabled: []\n---\n# Demo\n`;
const parsedV1 = profile.parseDocumentProfile(v1);
assert.strictEqual(parsedV1.schemaVersion, 1);
assert.strictEqual(profile.validateDocumentProfile(v1).status, 'migration-required');
const migrated = profile.migrateProfile(parsedV1);
assert.strictEqual(migrated.schemaVersion, 2);
assert.strictEqual(migrated.revision, 2);
assert.deepStrictEqual(migrated.policy, parsedV1.policy);
assert.deepStrictEqual(migrated.traits, parsedV1.traits);

const canonicalA = profile.normalizeProfile({ name: 'lean', traits: ['operations', 'ui'] });
const canonicalB = profile.normalizeProfile({ name: 'lean', traits: ['ui', 'operations'] });
assert.deepStrictEqual(canonicalA, canonicalB);
assert.strictEqual(canonicalA.schemaVersion, 2);
assert.strictEqual(canonicalA.enforcement, 'checkpoint');
assert.deepStrictEqual(canonicalA.rules.REQ.after, ['PRD']);
assert.throws(() => profile.renderDocumentProfile({ name: 'service', policy: { required: ['PRD', 'PRD'], recommended: [], onDemand: [], disabled: [] } }), /중복/u);
assert.throws(() => profile.renderDocumentProfile({ name: 'unknown' }), /지원하지 않는/u);

const withOmission = profile.normalizeProfile({
  name: 'lean',
  policy: { required: ['PRD', 'REQ'], recommended: [], onDemand: ['ARC', 'MOD', 'API', 'ADR', 'TST', 'RUN', 'GLS'], disabled: ['SCR'] }
});
assert.strictEqual(withOmission.omissions.SCR.absorbedBy, 'REQ');
assert.deepStrictEqual(withOmission.omissions.SCR.sections, ['사용자 흐름', '바인딩', '상태', '접근성과 반응형', '디자인에 없는 것']);
for (const type of profile.REGULAR_TYPES) assert(profile.DOCUMENT_SECTION_CATALOG[type].length > 0, `${type} must define document sections`);
const rendered = profile.renderDocumentProfile(withOmission);
assert.strictEqual(profile.validateDocumentProfile(`---\n${rendered}\n---\n`).status, 'valid');
assert.strictEqual(profile.validateDocumentProfile(`---\n${rendered.replace('      after: [PRD]', '      after: [ARC]').replace('      after: [REQ]', '      after: [REQ, PRD]')}\n---\n`).status, 'valid', 'Recommended context may be cyclic because it never blocks authoring');
assert(profile.validateDocumentProfile(`---\n${rendered.replace(/    SCR:\n      absorbedBy:[\s\S]*?(?=\n---|$)/u, '')}\n---\n`).errors.some((message) => message.includes('생략 처리')));

const completeReq = { id: 'REQ-001', type: 'REQ', source: '# 요구사항\n## 사용자 흐름\n## 바인딩\n## 상태\n## 접근성과 반응형\n## 디자인에 없는 것\n' };
const evaluation = evaluateDocumentContract(withOmission, [{ id: 'PRD-001', type: 'PRD', source: '# PRD' }, completeReq]);
assert.strictEqual(evaluation.violations.filter((item) => item.code !== 'recommended-missing').length, 0);
assert.strictEqual(evaluation.absorbed[0].satisfied, true);
assert(evaluation.ready.some((item) => item.type === 'ARC'));
assert.strictEqual(evaluation.blocked.length, 0);
assert(evaluation.ready.find((item) => item.type === 'ADR').missingRecommendedContext.includes('ARC'));
assert(!evaluation.violations.some((item) => item.code === 'after-missing'));
assert.deepStrictEqual(evaluation, evaluateDocumentContract(withOmission, [completeReq, { id: 'PRD-001', type: 'PRD', source: '# PRD' }]));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-profile-'));
try {
  const file = path.join(temp, 'project.md');
  fs.writeFileSync(file, v1, 'utf8');
  const updated = profile.reconfigureProject(file, 'lean', { enforcement: 'advisory' });
  assert.strictEqual(updated.migratedFrom, 1);
  assert.strictEqual(updated.profile.schemaVersion, 2);
  assert.strictEqual(updated.profile.revision, 3);
  assert.strictEqual(updated.profile.enforcement, 'advisory');
  assert.deepStrictEqual(updated.profile.traits, ['api', 'operations']);
  assert(updated.impact.length > 0);
  const reparsed = profile.parseDocumentProfile(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(reparsed, updated.profile);
  assert(profile.missingActions(reparsed, ['PRD']).find((item) => item.type === 'REQ').command.includes('--related <ARTIFACT-ID>'));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write('document profile tests passed\n');
