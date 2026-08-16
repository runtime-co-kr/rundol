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
// 작성 순서는 프로젝트가 들고 다니던 상태에서 상수로 옮겼다. 프로필에는 남지 않는다.
assert.strictEqual(canonicalA.rules, undefined, '프로필은 더 이상 rules를 갖지 않습니다');
assert.deepStrictEqual(profile.DEFAULT_RULES.REQ, ['PRD'], '작성 순서 지식 자체는 상수로 남습니다');
assert.throws(() => profile.renderDocumentProfile({ name: 'service', policy: { required: ['PRD', 'PRD'], recommended: [], onDemand: [], disabled: [] } }), /중복/u);
assert.throws(() => profile.renderDocumentProfile({ name: 'unknown' }), /지원하지 않는/u);

// 흡수는 없앴다. 사용 안 함은 "만들지 않는다" 하나만 뜻하고, 프로필은 그 유형에 대해
// 아무 부가 설정도 들고 다니지 않는다. 제목만 보고 내용을 보지 않던 판정이 사라졌다.
const withDisabled = profile.normalizeProfile({
  name: 'lean',
  policy: { required: ['PRD', 'REQ'], recommended: [], onDemand: ['ARC', 'MOD', 'API', 'ADR', 'TST', 'RUN', 'GLS'], disabled: ['SCR'] }
});
assert.strictEqual(withDisabled.omissions, undefined, '프로필은 더 이상 흡수 설정을 갖지 않습니다');
for (const type of profile.REGULAR_TYPES) assert(profile.DEFAULT_SECTIONS[type].length > 0, `${type}의 하부 요소가 정의되어야 합니다`);
const rendered = profile.renderDocumentProfile(withDisabled);
assert(!rendered.includes('omissions:'), '렌더 결과에 흡수 블록이 남으면 안 됩니다');
assert(!rendered.includes('rules:'), '렌더 결과에 작성 순서 블록이 남으면 안 됩니다');
assert.strictEqual(profile.validateDocumentProfile(`---\n${rendered}\n---\n`).status, 'valid');

// 사용 안 함인 유형의 문서가 있으면 그것만 위반이다. 흡수 여부는 더 이상 묻지 않는다.
const evaluation = evaluateDocumentContract(withDisabled, [{ id: 'PRD-001', type: 'PRD', source: '# PRD' }, { id: 'REQ-001', type: 'REQ', source: '# 요구사항' }]);
assert.strictEqual(evaluation.violations.filter((item) => item.code !== 'recommended-missing').length, 0);
assert.deepStrictEqual(evaluation.absorbed, []);
const withScr = evaluateDocumentContract(withDisabled, [{ id: 'PRD-001', type: 'PRD', source: '# PRD' }, { id: 'REQ-001', type: 'REQ', source: '# 요구사항' }, { id: 'SCR-001', type: 'SCR', source: '# 화면' }]);
assert(withScr.violations.some((item) => item.code === 'disabled-present'), '사용 안 함인 유형을 만들면 위반입니다');
assert(evaluation.ready.some((item) => item.type === 'ARC'));
assert.strictEqual(evaluation.blocked.length, 0);
assert(evaluation.ready.find((item) => item.type === 'ADR').missingRecommendedContext.includes('ARC'));
assert(!evaluation.violations.some((item) => item.code === 'after-missing'));
// 판정은 문서 순서에 좌우되지 않는다.
assert.deepStrictEqual(evaluation, evaluateDocumentContract(withDisabled, [{ id: 'REQ-001', type: 'REQ', source: '# 요구사항' }, { id: 'PRD-001', type: 'PRD', source: '# PRD' }]));

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
  const nextRequirement = profile.missingActions(reparsed, ['PRD']).find((item) => item.type === 'REQ').command;
  assert(nextRequirement.includes('--scope "<단일 책임>"'));
  assert(nextRequirement.includes('--exclude "<제외 범위>"'));
  assert(nextRequirement.includes('--related <ARTIFACT-ID>'));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

// 규칙을 없앤 것이 남의 기록까지 지울 근거는 아니다. "해당 없음"과 그 사유는 기계가 만든
// 기본값이 아니라 사람이 왜 그렇게 정했는지 적어 둔 판단이고, 담긴 곳이 여기 말고 없다.
{
  const withReason = profile.normalizeProfile({
    name: 'lean', enforcement: 'checkpoint',
    policy: { required: ['REQ'], recommended: [], onDemand: ['PRD', 'ARC', 'MOD', 'API', 'ADR', 'TST', 'RUN', 'GLS'], disabled: ['SCR'] },
    omissions: { SCR: { notApplicable: true, reason: '이 제품에는 화면이 없다' } }
  });
  assert.strictEqual(withReason.omissions.SCR.notApplicable, true, '기록된 결정은 남아야 합니다');
  assert.strictEqual(withReason.omissions.SCR.reason, '이 제품에는 화면이 없다', '사유까지 남아야 합니다');
  const rendered = profile.renderDocumentProfile(withReason);
  assert.ok(rendered.includes('이 제품에는 화면이 없다'), '다시 쓸 때도 사유가 남아야 합니다');
  assert.strictEqual(profile.validateDocumentProfile(`---\n${rendered}\n---\n`).status, 'valid');

  // 흡수 규칙(대상·섹션)은 기계 기본값이라 계속 제거한다. 사람이 적은 것만 남긴다.
  const absorbed = profile.normalizeProfile({
    name: 'lean',
    policy: { required: ['REQ'], recommended: [], onDemand: ['PRD', 'ARC', 'MOD', 'API', 'ADR', 'TST', 'RUN', 'GLS'], disabled: ['SCR'] },
    omissions: { SCR: { absorbedBy: 'REQ', sections: ['사용자 흐름'] } }
  });
  assert.strictEqual(absorbed.omissions, undefined, '흡수 규칙은 남기지 않습니다');
}

process.stdout.write('document profile tests passed' + String.fromCharCode(10));
