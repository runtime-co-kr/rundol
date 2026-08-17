'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { newDocumentUid, isDocumentUid, documentUid, insertUid, localNextNumber, documentIdFor, duplicateUids } = require('../src/document-identity');
const { parseFrontmatter } = require('../src/frontmatter');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-doc-identity-'));
const home = path.join(temporary, 'runtime');

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd: cwd || temporary, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), repository));
}

try {
  // 식별자는 짧고 눈으로 헷갈리지 않아야 한다 — Crockford base32는 I·L·O·U를 뺀다.
  const uid = newDocumentUid();
  assert.strictEqual(uid.length, 8);
  assert(isDocumentUid(uid), uid);
  assert(!/[ILOU]/u.test(uid), `혼동 문자가 포함되면 안 됩니다: ${uid}`);
  for (const invalid of ['', 'SHORT', 'toolongvalue', 'ABCDEFGI', 'abcdefgh']) assert.strictEqual(isDocumentUid(invalid), false, invalid);
  // 난수라 매번 다르다 — 내용 해시가 아니므로 문서를 고쳐도 정체성이 유지된다.
  assert.notStrictEqual(newDocumentUid(), newDocumentUid());

  // frontmatter의 id 바로 다음에 들어가고, 이미 있으면 덮어쓰지 않는다.
  const source = '---\nid: REQ-001\ntype: document\ntitle: 예시\n---\n\n# 예시\n';
  const inserted = insertUid(source, uid);
  assert(inserted.includes(`id: REQ-001\nuid: ${uid}\n`), inserted.slice(0, 80));
  assert.strictEqual(insertUid(inserted, newDocumentUid()), inserted, '기존 식별자를 덮어쓰면 안 됩니다.');
  assert.strictEqual(documentUid(parseFrontmatter(inserted).data), uid);
  assert.strictEqual(documentUid({ uid: '잘못된값' }), null);
  assert.throws(() => insertUid('본문만 있는 문서', uid), /frontmatter/u);

  // 번호는 표시값이라 로컬 최대값에서 계산한다 — 원격 왕복이 없다.
  assert.strictEqual(localNextNumber([{ id: 'REQ-001' }, { id: 'REQ-004' }, { id: 'ADR-009' }], 'REQ'), 5);
  assert.strictEqual(localNextNumber([], 'ADR'), 1);
  assert.strictEqual(documentIdFor('REQ', 7), 'REQ-007');
  assert.throws(() => documentIdFor('REQ', 1000), /범위를 벗어/u);

  // 충돌은 조용한 손상이 아니라 진단 대상이다.
  assert.deepStrictEqual(duplicateUids([{ id: 'REQ-001', uid: 'AAAAAAAA' }, { id: 'REQ-002', uid: 'AAAAAAAA' }, { id: 'REQ-003', uid: 'BBBBBBBB' }]),
    [{ uid: 'AAAAAAAA', ids: ['REQ-001', 'REQ-002'] }]);
  assert.deepStrictEqual(duplicateUids([{ id: 'REQ-001', uid: 'AAAAAAAA' }, { id: 'REQ-002' }]), []);

  // 실제 Workspace: 생성 시 부여되고 원격 없이도 만들어진다.
  command('git', ['init', '-b', 'main']);
  command('git', ['config', 'user.name', 'Rundol Test']);
  command('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# identity\n', 'utf8');
  command('git', ['add', 'README.md']);
  command('git', ['commit', '-m', 'initial']);
  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);

  const created = rdl(['doc', 'create', 'ADR', '식별자 부여 확인', '--owner', 'MEMBER-001', '--scope', '식별자 부여 흐름', '--exclude', '조회 인덱스', '--project', 'crm']);
  assert(isDocumentUid(created.uid), `생성 시 식별자가 부여되어야 합니다: ${created.uid}`);
  assert.strictEqual(created.id, 'ADR-001', '번호는 로컬 최대값에서 계산됩니다.');
  const documentFile = path.join(temporary, 'projects', 'crm', created.relativeFile.replace(/^projects\/crm\//u, ''));
  assert.strictEqual(documentUid(parseFrontmatter(fs.readFileSync(documentFile, 'utf8')).data), created.uid);

  // 두 번째 문서는 번호가 이어지고 식별자는 서로 다르다.
  const second = rdl(['doc', 'create', 'ADR', '두 번째 결정', '--owner', 'MEMBER-001', '--scope', '두 번째 결정 범위', '--exclude', '그 밖', '--project', 'crm']);
  assert.strictEqual(second.id, 'ADR-002');
  assert.notStrictEqual(second.uid, created.uid);

  // 식별자가 없는 문서는 경고로 드러나고 마이그레이션이 부여한다.
  const legacy = fs.readFileSync(documentFile, 'utf8').replace(/^uid: .*\n/mu, '');
  fs.writeFileSync(documentFile, legacy, 'utf8');
  const warned = rdl(['check', '--project', 'crm']);
  assert(warned.diagnostics.some((item) => item.code === 'RDL-DOC-014'), '식별자 없는 문서는 경고로 드러나야 합니다.');

  const planned = rdl(['doc', 'identity', '--project', 'crm']);
  assert.strictEqual(planned.planned, 1);
  assert.strictEqual(planned.applied.length, 0, '--apply 없이는 부여하지 않습니다.');
  assert(planned.note.includes('승인'), '리비전 변경으로 승인이 낡는다는 사실을 알려야 합니다.');

  const applied = rdl(['doc', 'identity', '--project', 'crm', '--apply']);
  assert.strictEqual(applied.applied.length, 1);
  assert(isDocumentUid(documentUid(parseFrontmatter(fs.readFileSync(documentFile, 'utf8')).data)));
  const afterMigration = rdl(['check', '--project', 'crm']);
  assert(!afterMigration.diagnostics.some((item) => item.code === 'RDL-DOC-014'));

  // 중복 식별자는 두 문서를 모두 지목한다.
  const secondFile = path.join(temporary, 'projects', 'crm', second.relativeFile.replace(/^projects\/crm\//u, ''));
  const duplicated = fs.readFileSync(secondFile, 'utf8').replace(/^uid: .*$/mu, `uid: ${documentUid(parseFrontmatter(fs.readFileSync(documentFile, 'utf8')).data)}`);
  fs.writeFileSync(secondFile, duplicated, 'utf8');
  // 중복은 오류이므로 검사가 실패 종료한다 — 종료 코드까지가 계약이다.
  const conflicted = spawnSync(process.execPath, [cli, 'check', '--project', 'crm', '--root', temporary, '--json'], { cwd: repository, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  assert.strictEqual(conflicted.status, 1, '중복 식별자는 검사 실패여야 합니다.');
  const codes = JSON.parse(conflicted.stdout).diagnostics.filter((item) => item.code === 'RDL-DOC-016');
  assert.strictEqual(codes.length, 2, '중복은 두 문서를 모두 지목해야 합니다.');

  process.stdout.write('document identity tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
