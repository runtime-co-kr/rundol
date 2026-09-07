'use strict';

// 통합 검색 시험.
//
// 이 검색이 생긴 이유는 "왜 이렇게 됐나"에 답할 자리가 화면에 하나도 없었다는 것이다.
// 그 답은 원장에 모인다 — 승인 사유, 제출 사유, 반려 사유, 태스크 댓글. 그래서 이
// 시험이 못박아야 할 것은 "검색이 돈다"가 아니라 다음 여섯이다.
//
//   1. 문서·태스크·원장 셋에서 각각 맞는다.
//   2. 결과가 출처와 붙은 대상을 갖는다 — 원장 줄은 붙은 대상 없이는 읽을 수 없다.
//   3. 기계 값(리비전 해시·eventId·다이제스트)이 검색에 걸리지 않는다.
//   4. 원장을 못 읽어도 문서·태스크는 나오고, 못 읽은 이유가 값에 실린다.
//   5. 인덱스가 있든 없든 낡았든 손상됐든 같은 답이 나온다(REQ-041).
//   6. 짧은 질의·빈 질의가 전건을 쏟지 않는다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { searchWorkspace, MIN_QUERY_LENGTH, MAX_QUERY_LENGTH, SEARCH_SOURCES } = require('../src/search');
const { boardSearch } = require('../src/board');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-search-'));
const home = path.join(temporary, 'runtime');

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd: cwd || temporary, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
  assert.strictEqual(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args) {
  return JSON.parse(command(process.execPath, [cli].concat(args, ['--root', temporary, '--json']), repository));
}

function find(result, id) {
  return result.results.find((hit) => hit.id === id) || null;
}

// 인덱스는 RUNDOL_HOME 아래 산다. 같은 프로세스에서 부르는 API도 같은 홈을 봐야
// 인덱스 유무 시험이 실제로 그 인덱스를 본다.
const previousHome = process.env.RUNDOL_HOME;
process.env.RUNDOL_HOME = home;

try {
  command('git', ['init', '-b', 'main']);
  command('git', ['config', 'user.name', 'Rundol Test']);
  command('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# search\n', 'utf8');
  command('git', ['add', 'README.md']);
  command('git', ['commit', '-m', 'initial']);
  rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean']);
  rdl(['client', 'register', 'laptop-h', '--name', '사람 노트북', '--type', 'human', '--owner', 'MEMBER-001']);

  // ── 대상 만들기 ────────────────────────────────────────────────────────
  //
  // 세 갈래 각각에 같은 낱말("가역성")을 심는다. 한 갈래에만 심으면 "섞여 나온다"를
  // 확인할 수 없고, 섞이지 않는 검색은 화면 셋을 그대로 둔 것과 같다.

  const first = rdl(['doc', 'create', 'ADR', '승인 관문을 어디에 둘 것인가', '--project', 'crm',
    '--owner', 'MEMBER-001', '--scope', '승인 관문의 위치에 대한 단일 결정', '--exclude', '표시 규칙']);
  const second = rdl(['doc', 'create', 'ADR', '되돌리기의 가역성 원칙', '--project', 'crm',
    '--owner', 'MEMBER-001', '--scope', '되돌리기 가역성에 대한 단일 결정', '--exclude', '성능 목표']);
  assert.strictEqual(first.id, 'ADR-001');
  assert.strictEqual(second.id, 'ADR-002');

  // 본문에만 있는 낱말을 심는다. 제목·설명에도 있는 낱말로만 재면 본문이 대상에
  // 들어갔는지 아무 시험도 확인하지 못한다.
  const firstFile = path.join(temporary, first.relativeFile);
  fs.appendFileSync(firstFile, '\n관문을 뒤에 두면 되돌릴 수 없는 일이 먼저 일어난다. 그래서 앞에 둔다.\n', 'utf8');

  const task = rdl(['task', 'add', '되돌리기 단추를 붙인다', '--project', 'crm',
    '--summary', '가역성 없는 실행을 막는다', '--acceptance', '되돌리기가 원장을 남긴다']);
  const other = rdl(['task', 'add', '검색 자리를 만든다', '--project', 'crm',
    '--summary', '문서와 태스크와 원장을 한 번에 찾는다', '--acceptance', '세 갈래가 섞여 나온다']);

  // 원장 셋: 승인(사유+근거 상세) · 제출(사유) · 반려(사유) · 댓글.
  rdl(['doc', 'approve', 'ADR-001', '--member', 'MEMBER-001', '--client-id', 'laptop-h',
    '--basis', 'read=본문을 끝까지 읽고 가역성 조항을 확인했다', '--reason', '관문 위치를 여기서 못박는다', '--project', 'crm']);
  rdl(['doc', 'submit', 'ADR-002', '--client-id', 'laptop-h', '--member', 'MEMBER-001',
    '--reason', '초안을 검토에 올린다', '--project', 'crm']);
  rdl(['doc', 'reject', 'ADR-002', '--client-id', 'laptop-h', '--member', 'MEMBER-001',
    '--reason', '가역성 조항이 빠져 되돌릴 수 없다', '--project', 'crm']);
  rdl(['task', 'comment', task.taskId, '가역성은 원장으로 보장하기로 했다', '--client-id', 'laptop-h', '--project', 'crm']);

  // ── 1. 세 갈래에서 각각 맞는다 ─────────────────────────────────────────

  const mixed = searchWorkspace(temporary, { project: 'crm', query: '가역성' });
  assert.strictEqual(mixed.status, 'ok');
  for (const source of SEARCH_SOURCES) {
    assert(mixed.counts[source] > 0, `${source} 갈래가 한 건도 안 나옵니다: ${JSON.stringify(mixed.counts)}`);
  }
  // 화면을 옮겨도 같은 낱말이 같은 일을 해야 한다. 갈래마다 실제 항목이 서는지 본다.
  assert(find(mixed, 'ADR-002'), '문서가 나와야 합니다.');
  assert(find(mixed, task.taskId), '태스크가 나와야 합니다.');
  assert(mixed.results.some((hit) => hit.source === 'ledger' && hit.origin.kind === 'approval.rejected'),
    '반려 사유가 나와야 합니다 — 반려는 사유가 필수인 자리이고, 그 사유가 안 잡히면 원장을 넣은 뜻이 없습니다.');

  // 본문에만 있는 낱말도 잡힌다. 잡히지 않으면 검색은 제목 목록일 뿐이다.
  const bodyOnly = searchWorkspace(temporary, { project: 'crm', query: '되돌릴 수 없는 일' });
  const bodyHit = find(bodyOnly, 'ADR-001');
  assert(bodyHit, '본문의 낱말이 잡혀야 합니다.');
  assert.strictEqual(bodyHit.matches[0].field, 'body');

  // 완료조건도 대상이다. 태스크에서 사람이 가장 자주 찾는 글이 여기 있다.
  const acceptance = searchWorkspace(temporary, { project: 'crm', query: '세 갈래가 섞여' });
  const acceptanceHit = find(acceptance, other.taskId);
  assert(acceptanceHit, '완료조건이 잡혀야 합니다.');
  assert(acceptanceHit.matches.some((match) => match.field === 'acceptance' && /AC-001/u.test(match.label)),
    '어느 완료조건인지가 라벨에 남아야 합니다.');

  // 승인 근거 상세도 대상이다. 근거 종류(read)는 열거값이라 대상이 아니지만 상세는
  // 사람이 쓴 글이고, 승인이 무엇에 기대었는지는 그 글에만 있다.
  const basis = searchWorkspace(temporary, { project: 'crm', query: '끝까지 읽고' });
  const basisHit = basis.results.find((hit) => hit.origin.kind === 'approval.granted');
  assert(basisHit, '승인 근거 상세가 잡혀야 합니다.');
  assert(basisHit.matches.some((match) => match.field === 'basis' && /read/u.test(match.label)),
    '어느 근거의 상세인지가 라벨에 남아야 합니다.');

  // ── 2. 출처와 붙은 대상 ────────────────────────────────────────────────
  //
  // 원장 줄은 그 자체로는 읽을 수 없다. "가역성 조항이 빠져 되돌릴 수 없다"만 보면
  // 무엇에 대한 말인지 알 수 없고, `ADR-002의 반려 사유`라야 뜻이 선다.

  const rejection = mixed.results.find((hit) => hit.origin.kind === 'approval.rejected');
  assert.strictEqual(rejection.source, 'ledger');
  assert.strictEqual(rejection.origin.label, '반려 사유');
  assert.deepStrictEqual(
    { kind: rejection.attachedTo.kind, id: rejection.attachedTo.id, found: rejection.attachedTo.found },
    { kind: 'document', id: 'ADR-002', found: true },
    '원장 줄은 어느 문서에 붙은 것인지를 들어야 합니다.'
  );
  assert.strictEqual(rejection.attachedTo.title, '되돌리기의 가역성 원칙', '붙은 대상은 제목까지 해소되어야 합니다.');
  assert.strictEqual(rejection.title, 'ADR-002의 반려 사유');
  assert.strictEqual(rejection.by, 'MEMBER-001');

  const commentHit = mixed.results.find((hit) => hit.origin.kind === 'task.comment');
  assert.strictEqual(commentHit.attachedTo.kind, 'task');
  assert.strictEqual(commentHit.attachedTo.id, task.taskId);
  assert.strictEqual(commentHit.title, `${task.taskId}의 댓글`);

  // 문서·태스크 결과도 같은 모양을 갖는다. 모양이 갈리면 화면이 출처 줄을 두 벌
  // 그려야 하고, 두 벌은 언젠가 갈라진다.
  for (const hit of mixed.results) {
    assert(hit.origin && typeof hit.origin.label === 'string', `출처 라벨이 없습니다: ${hit.id}`);
    assert(hit.attachedTo && typeof hit.attachedTo.kind === 'string', `붙은 대상 자리가 없습니다: ${hit.id}`);
    assert(SEARCH_SOURCES.includes(hit.source));
  }
  assert.strictEqual(find(mixed, 'ADR-002').attachedTo.id, 'ADR-002', '문서의 붙은 대상은 자기 자신입니다.');

  // "ADR-002"를 치면 그 문서와 그 문서에 붙은 원장 줄이 함께 나온다. 오너가 요구한
  // "데이터소스랑 문서가 같이 표현"의 실제 모양이 이것이다.
  const together = searchWorkspace(temporary, { project: 'crm', query: 'ADR-002' });
  assert(find(together, 'ADR-002'), '문서 자신이 나와야 합니다.');
  const attached = together.results.filter((hit) => hit.source === 'ledger' && hit.attachedTo.id === 'ADR-002');
  assert.deepStrictEqual(attached.map((hit) => hit.origin.kind).sort(), ['approval.rejected', 'approval.submitted'],
    '그 문서에 붙은 제출·반려가 함께 나와야 합니다.');
  // 문서 자신이 먼저다. 식별자가 통째로 맞은 문서가 그 문서에 붙은 줄 뒤로 밀리면
  // 사람은 찾던 것을 목록 아래에서 찾아야 한다.
  assert.strictEqual(together.results[0].id, 'ADR-002');

  // ── 발췌와 강조 ────────────────────────────────────────────────────────
  //
  // 강조는 HTML이 아니라 구간이다. 서버가 <mark>를 박아 보내면 화면은 innerHTML을
  // 써야 하고, 그 순간 문서 본문에 든 태그가 그대로 실행된다.
  for (const hit of mixed.results) {
    for (const match of hit.matches) {
      assert(match.excerpts.length > 0, `발췌가 없습니다: ${hit.id}/${match.field}`);
      for (const excerpt of match.excerpts) {
        assert.strictEqual(/[<>]/u.test(excerpt.text) && /<mark/u.test(excerpt.text), false, '서버가 마크업을 만들면 안 됩니다.');
        // 발췌는 한 줄이어야 한다. 줄바꿈이 남으면 목록의 한 줄이 문단이 된다.
        assert.strictEqual(/[\r\n]/u.test(excerpt.text), false, `발췌에 줄바꿈이 남았습니다: ${hit.id}`);
        for (const [offset, length] of excerpt.ranges) {
          // 구간이 실제로 질의를 가리켜야 한다. 오프셋이 한 글자만 밀려도 화면은
          // 엉뚱한 자리를 칠하고, 그것은 틀렸다는 신호를 내지 않는다.
          assert.strictEqual(excerpt.text.slice(offset, offset + length).toLowerCase(), '가역성',
            `강조 구간이 맞은 자리를 가리키지 않습니다: ${hit.id}/${match.field} ${JSON.stringify(excerpt)}`);
        }
      }
    }
  }
  // 긴 본문에서 잘렸으면 잘렸다는 사실을 값이 말한다.
  const longBody = bodyOnly.results.find((hit) => hit.matches.some((match) => match.field === 'body'));
  assert(longBody.matches.find((match) => match.field === 'body').excerpts[0].text.includes('…'),
    '본문 발췌는 잘린 쪽을 …으로 말해야 합니다.');

  // ── 순서 ───────────────────────────────────────────────────────────────
  //
  // 제목이 맞은 것과 본문이 맞은 것은 무게가 다르다. 같으면 목록의 앞이 "이 질의에
  // 가까운 것"이 아니라 "먼저 읽힌 파일"이 된다.
  {
    const ordered = searchWorkspace(temporary, { project: 'crm', query: '관문' });
    const titleAt = ordered.results.findIndex((hit) => hit.id === 'ADR-001');
    const ledgerAt = ordered.results.findIndex((hit) => hit.origin.kind === 'approval.granted');
    assert(titleAt >= 0 && ledgerAt >= 0);
    assert(titleAt < ledgerAt, '제목이 맞은 문서가 그 문서에 붙은 원장 줄보다 앞이어야 합니다.');
    // 두 번 쳐도 같은 순서다. 폴링이 되돌린 값과 겹치는 화면에서 순서가 흔들리면
    // 사람이 훑던 자리를 잃는다.
    const again = searchWorkspace(temporary, { project: 'crm', query: '관문' });
    assert.deepStrictEqual(again.results.map((hit) => `${hit.source}:${hit.id}`), ordered.results.map((hit) => `${hit.source}:${hit.id}`));
  }

  // ── 3. 기계 값은 걸리지 않는다 ─────────────────────────────────────────
  //
  // 16진 해시는 [0-9a-f]로만 이루어져 있어서 한 번 대상에 들어가면 "add"·"face"
  // 같은 낱말이 문서 전건의 해시 조각에 걸린다. 그러면 결과는 사람이 쓴 글이 아니라
  // 해시로 뒤덮인다.
  {
    const approvalShard = path.join(temporary, 'projects', 'workspace', 'events', 'approval', 'approval-crm-laptop-h-000001.jsonl');
    const events = fs.readFileSync(approvalShard, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    const granted = events.find((event) => event.type === 'approval.granted');
    for (const machine of [granted.eventId, granted.requestId, granted.rootRequestId, granted.canonicalDigest, granted.reviewedRevision, granted.clientId]) {
      const found = searchWorkspace(temporary, { project: 'crm', query: machine });
      assert.strictEqual(found.total, 0, `기계 값이 검색에 걸립니다: ${machine}\n${JSON.stringify(found.results.map((hit) => hit.id))}`);
    }
    // 해시 조각도 마찬가지다. 온전한 값만 막고 조각을 열어 두면 막은 것이 아니다.
    assert.strictEqual(searchWorkspace(temporary, { project: 'crm', query: granted.reviewedRevision.slice(0, 16) }).total, 0);

    // 붙은 대상의 이름이 뒷문이 되면 안 된다. 댓글 정정은 태스크가 아니라 다른 댓글을
    // 가리키고 그 댓글은 eventId로만 지목되는데, 그 식별자를 "붙은 대상" 칸으로 대상에
    // 넣으면 대상에서 eventId를 뺀 이유가 그대로 무너진다.
    const commentShard = path.join(temporary, 'projects', 'workspace', 'events', 'comment', 'comment-crm-laptop-h-000001.jsonl');
    const written = JSON.parse(fs.readFileSync(commentShard, 'utf8').split(/\r?\n/u).filter(Boolean)[0]);
    require('../src/comment').correctComment(temporary, {
      project: 'crm', clientId: 'laptop-h', targetEventId: written.eventId,
      workerKind: 'agent', reason: '기계 종류에서 잘못 파생된 작성 주체를 되돌린다'
    });
    // 정정의 사유는 사람이 쓴 글이므로 잡혀야 한다.
    const corrected = searchWorkspace(temporary, { project: 'crm', query: '잘못 파생된' });
    assert.strictEqual(corrected.results.filter((hit) => hit.origin.kind === 'task.comment.corrected').length, 1);
    // 그러나 그 정정이 가리키는 원 댓글의 식별자는 잡히면 안 된다.
    assert.strictEqual(searchWorkspace(temporary, { project: 'crm', query: written.eventId }).total, 0,
      '붙은 대상이 기계 값이면 대상에 넣으면 안 됩니다.');
  }

  // ── 4. 원장을 못 읽어도 나머지는 나온다 ────────────────────────────────
  //
  // 승인 원장은 뒷판 작업공간에만 있다. 없는 것을 오류로 만들면 판올림 전 저장소에서
  // 검색이 통째로 죽고, 조용히 삼키면 원장이 깨진 저장소와 원장을 안 쓰는 저장소가
  // 화면에서 같아 보인다 — 앞엣것은 고쳐야 할 사고인데 아무도 그것을 모른다.
  {
    const legacy = path.join(repository, 'test', 'fixtures', 'workspace');
    const found = searchWorkspace(legacy, { project: 'tms', query: '태스크' });
    assert.strictEqual(found.status, 'ok');
    assert(found.counts.document + found.counts.task > 0, '원장이 없어도 문서·태스크는 나와야 합니다.');
    assert.strictEqual(found.counts.ledger, 0);
    assert.strictEqual(found.scanned.ledger.read, false);
    assert.strictEqual(typeof found.scanned.ledger.reason, 'string', '못 읽은 이유가 값에 실려야 합니다.');
  }

  // 읽었는데 0건인 것과 못 읽은 것은 다르다. 갈래를 문서로 좁혀도 원장은 읽는다 —
  // 화면이 그 둘을 가르려면 걸러진 목록이 아니라 읽기 사실을 봐야 한다.
  {
    const scoped = searchWorkspace(temporary, { project: 'crm', query: '가역성', source: 'document' });
    assert(scoped.results.every((hit) => hit.source === 'document'));
    assert.strictEqual(scoped.scanned.ledger.read, true, '갈래를 걸러도 원장을 읽었다는 사실은 남아야 합니다.');
    assert.strictEqual(scoped.scanned.ledger.reason, null);
    // 모르는 갈래는 빈 결과가 아니라 거절이다. 빈 결과로 답하면 "그 갈래에 아무것도
    // 없다"로 읽힌다.
    assert.throws(() => searchWorkspace(temporary, { project: 'crm', query: '가역성', source: 'ledgers' }),
      (error) => error.statusCode === 400 && error.code === 'unknown-source');
  }

  // ── 5. 인덱스가 답을 바꾸지 않는다 (REQ-041) ───────────────────────────
  //
  // 인덱스는 삭제 가능한 캐시이고 정확성의 기준은 언제나 무인덱스 경로다. 검색은
  // 상세(본문·요약·사유)를 대상으로 하는데 인덱스는 조인 키만 갖도록 못박혀 있으므로,
  // 검색이 인덱스를 보는 순간 그 계약이 깨진다. 그래서 언제나 정본을 읽고, 인덱스가
  // 어느 상태이든 같은 답을 낸다.
  {
    const { buildIndex, clearIndex, readIndex, indexFile } = require('../src/query-index');
    const baseline = searchWorkspace(temporary, { project: 'crm', query: '가역성' });
    assert.strictEqual(baseline.index.used, false);
    assert.strictEqual(readIndex(temporary).status, 'missing');

    buildIndex(temporary);
    assert.strictEqual(readIndex(temporary).status, 'valid');
    assert.deepStrictEqual(searchWorkspace(temporary, { project: 'crm', query: '가역성' }), baseline,
      '유효한 인덱스가 있어도 같은 답이어야 합니다.');

    fs.writeFileSync(indexFile(temporary), '{깨진 JSON', 'utf8');
    assert.strictEqual(readIndex(temporary).status, 'corrupt');
    assert.deepStrictEqual(searchWorkspace(temporary, { project: 'crm', query: '가역성' }), baseline,
      '손상된 인덱스가 있어도 같은 답이어야 합니다.');

    clearIndex(temporary);
    assert.deepStrictEqual(searchWorkspace(temporary, { project: 'crm', query: '가역성' }), baseline,
      '인덱스를 지워도 같은 답이어야 합니다.');
  }

  // ── 6. 짧은 질의와 빈 질의 ─────────────────────────────────────────────
  //
  // 한 글자에 전건이 나오면 그것은 검색이 아니라 목록이다. 그렇다고 오류도 아니다 —
  // 사람이 두 글자를 치는 도중에 반드시 지나는 상태다.
  {
    const empty = searchWorkspace(temporary, { project: 'crm', query: '   ' });
    assert.strictEqual(empty.status, 'empty');
    assert.strictEqual(empty.total, 0);
    // 빈 질의는 아무것도 읽지 않는다. 입력을 지우는 동작이 가장 비싼 동작이면 안 된다.
    assert.strictEqual(empty.scanned.documents, 0);
    assert.strictEqual(empty.scanned.tasks, 0);

    const short = searchWorkspace(temporary, { project: 'crm', query: '가' });
    assert.strictEqual(short.status, 'too-short');
    assert.strictEqual(short.total, 0);
    assert.strictEqual(short.minLength, MIN_QUERY_LENGTH);
    assert.strictEqual(short.scanned.documents, 0);

    // 두 글자부터는 답한다. 경계가 값과 어긋나면 화면의 안내가 거짓말이 된다.
    assert.strictEqual(searchWorkspace(temporary, { project: 'crm', query: '가역' }).status, 'ok');

    // 문단을 통째로 붙여 넣은 것은 질의가 아니라 실수다. 조용히 잘라 내면 사람은
    // 자기가 무엇을 검색했는지 모른 채 빈 결과를 본다.
    assert.throws(() => searchWorkspace(temporary, { project: 'crm', query: '가'.repeat(MAX_QUERY_LENGTH + 1) }),
      (error) => error.statusCode === 400 && error.code === 'query-too-long');
  }

  // ── 질의는 경로도 정규식도 되지 않는다 ─────────────────────────────────
  //
  // 사람이 친 `.*`가 전건에 맞거나 `(?:`가 문법 오류로 검색을 죽이면, 검색어가
  // 코드로 해석되고 있다는 뜻이다. 질의는 indexOf의 인자로만 쓰인다.
  {
    fs.appendFileSync(firstFile, '\n정규식 예: `.*`는 아무것도 뜻하지 않는다.\n', 'utf8');
    const literal = searchWorkspace(temporary, { project: 'crm', query: '.*' });
    assert.strictEqual(literal.status, 'ok');
    assert.deepStrictEqual(literal.results.map((hit) => hit.id), ['ADR-001'], '정규식이 아니라 글자 그대로 찾아야 합니다.');
    for (const dangerous of ['(?:', '[a-z]+', '(((((((((((a+)+)+', '\\\\', '$^']) {
      const found = searchWorkspace(temporary, { project: 'crm', query: dangerous });
      assert.strictEqual(found.status, 'ok', `정규식 문법이 검색을 죽입니다: ${dangerous}`);
    }
    // 경로로도 쓰이지 않는다. 프로젝트 밖을 가리키는 문자열이 그냥 안 맞는 낱말이어야 한다.
    const traversal = searchWorkspace(temporary, { project: 'crm', query: '../../../etc/passwd' });
    assert.strictEqual(traversal.status, 'ok');
    assert.strictEqual(traversal.total, 0);
  }

  // ── 자를 때 갈래마다 자리를 남긴다 ─────────────────────────────────────
  //
  // 셈은 전건으로 하고 목록만 자르되, 잘렸다는 사실을 값이 말한다. 갈래마다 자리를
  // 남기는 이유는 화면이 실린 목록 위에서 "원장만"을 거르기 때문이다 — 셈이 1이라고
  // 말했는데 목록에 한 건도 없으면 사람은 수를 보고 그 수를 만든 목록으로 갈 수 없다.
  // 검토 인박스가 앞 50건에서 자르다가 정확히 그 일을 냈다.
  {
    const capped = searchWorkspace(temporary, { project: 'crm', query: '가역성', limit: 2 });
    const whole = searchWorkspace(temporary, { project: 'crm', query: '가역성' });
    assert.strictEqual(capped.truncated, true);
    assert.strictEqual(capped.results.length, 2);
    assert.deepStrictEqual(capped.counts, whole.counts, '셈은 자르기 전 전건이어야 합니다.');
    assert.strictEqual(capped.total, whole.total);
    const floored = searchWorkspace(temporary, { project: 'crm', query: '가역성', limit: 3 });
    assert.deepStrictEqual(
      Array.from(new Set(floored.results.map((hit) => hit.source))).sort(),
      SEARCH_SOURCES.slice().sort(),
      '자를 때도 갈래마다 자리가 남아야 합니다.'
    );
    // 상한 밖의 값은 거절이 아니라 조인다. 주소창에서 오는 값이라 사람이 친 실수가
    // 검색을 죽이면 안 된다 — 기존 태스크 조회가 같은 규칙을 쓴다.
    assert.strictEqual(searchWorkspace(temporary, { project: 'crm', query: '가역성', limit: '99999' }).limit, 200);
    assert.strictEqual(searchWorkspace(temporary, { project: 'crm', query: '가역성', limit: '0' }).limit, 1);
    assert.strictEqual(searchWorkspace(temporary, { project: 'crm', query: '가역성', limit: '아무거나' }).limit, 50);
  }

  // ── 보드 자리가 엔진과 같은 답을 낸다 ──────────────────────────────────
  //
  // 서버가 거르기를 한 줄이라도 다시 적으면 같은 질의가 보드와 엔진에서 다른 답을 낸다.
  {
    const viaBoard = boardSearch(temporary, 'crm', new URLSearchParams('q=%EA%B0%80%EC%97%AD%EC%84%B1&limit=3'));
    const viaEngine = searchWorkspace(temporary, { project: 'crm', query: '가역성', limit: 3 });
    assert.deepStrictEqual(viaBoard, viaEngine, '보드 자리는 엔진의 답을 그대로 옮겨야 합니다.');
    // 검색은 스냅숏에 실리지 않는다. 질의마다 다른 값이라 폴링에 실을 수 없다.
    const { workspaceSnapshot } = require('../src/board');
    const snapshot = workspaceSnapshot(temporary, 'crm', new URLSearchParams());
    assert.strictEqual(Object.prototype.hasOwnProperty.call(snapshot, 'search'), false, '스냅숏에 검색이 실리면 안 됩니다.');
  }

  // ── 작업공간 전체 ──────────────────────────────────────────────────────
  //
  // 프로젝트를 주지 않으면 모든 프로젝트를 훑는다. 결과마다 project가 실려 있어야
  // 화면이 어느 프로젝트의 것인지 말할 수 있다.
  {
    rdl(['project', 'add', 'ops', '--name', 'Ops', '--profile', 'lean']);
    rdl(['task', 'add', '가역성 점검을 운영 절차에 넣는다', '--project', 'ops', '--acceptance', '점검이 절차에 든다']);
    const all = searchWorkspace(temporary, { query: '가역성' });
    assert.deepStrictEqual(Array.from(new Set(all.results.map((hit) => hit.project))).sort(), ['crm', 'ops']);
    const scoped = searchWorkspace(temporary, { project: 'ops', query: '가역성' });
    assert(scoped.results.every((hit) => hit.project === 'ops'));
    assert(scoped.total < all.total, '프로젝트를 좁히면 결과도 좁아져야 합니다.');
  }

  process.stdout.write('search tests passed\n');
} finally {
  if (previousHome === undefined) delete process.env.RUNDOL_HOME;
  else process.env.RUNDOL_HOME = previousHome;
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
