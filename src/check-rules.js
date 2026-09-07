'use strict';

const { evaluateItemTypes, normalizeItemTypes, BUILTIN_ITEM_TYPES } = require('./item-type');

// 호출자가 유형 정의를 넘기지 않으면 내장으로 떨어진다. 다만 내장은 정규화 전 형태이고
// 해석기는 정규화된 것만 받으므로, 여기서 한 번 정규화해 둔다. 넘기지 않는 호출자를
// 던져서 막으면 이 판정 하나 때문에 검사기를 부르던 모든 자리가 함께 멈춘다.
const NORMALIZED_BUILTIN = normalizeItemTypes(BUILTIN_ITEM_TYPES);

// 완료 게이트의 기본값. 게이트를 유형이 면제할 수 있게 만들면서 호출자가 넘기는 값이
// 되었는데, 넘기지 않으면 판정 자체가 사라진다 — 규칙을 유형에 열어 준 대가로 규칙이
// 아무 데서도 돌지 않는 상태가 되면 그것은 여는 것이 아니라 없애는 것이다.
//
// 그래서 기본값을 여기 둔다. 호출자가 정책 층에서 읽은 것을 넘기면 그것이 이기고,
// 넘기지 않으면 이관 전과 같은 판정이 돈다.
// 사람이 사유를 대고 면제한 게이트는 판정하지 않는다. 면제를 여기서 보지 않으면 저장
// 계층이 받아 준 것을 검사가 다시 위반이라 말하고, 그러면 면제는 닫히지 않는 태스크를
// 닫는 수단이 아니라 경고를 하나 더 만드는 일이 된다.
// 면제 판정이 보는 게이트 이름. 문자열을 세 군데에 적으면 한 곳만 고쳐지는 날이 온다.
const READINESS_GATE = 'implementation-readiness';

const workflow = require('./workflow');

// 면제 기록은 gates 배열이 정본이고 gate 하나만 든 옛 기록도 읽는다. 그 규칙은
// 판정부가 갖는다 — 예전에는 같은 다섯 줄이 이 파일과 저장 계층에 따로 있었고,
// 둘 다 "저쪽은 부를 수 없다"는 이유로 자기 사본을 들고 있었다.
const exemptionGates = workflow.exemptionGates;
const exempted = workflow.exempted;

// 게이트의 판정은 workflow.js의 카탈로그가 갖는다. 여기 남는 것은 이름과 그
// 판정을 잇는 줄 하나뿐이다 — 유형 해석기와 발화 이력이 이 표를 규칙 목록으로
// 읽으므로 표 자체는 사라지지 않고, 규칙의 내용만 한 곳으로 간다.
//
// 같은 규칙이 저장 계층과 여기에 두 벌로 있던 것이 이 설계가 고치려던 것이다.
// 두 벌은 갈릴 것이 아니라 이미 갈려 있었다 — 저장은 blocker가 있기만 하면
// 받았고 여기서는 세 부분을 요구했다.
// 게이트도 그 태스크의 흐름을 탄다. 흐름을 넘기지 않으면 내장이다 — 유형 해석기가
// 이 표를 규칙 목록으로도 읽으므로 흐름 없이 부르는 자리가 남는다.
function gateFor(ruleId, flow) {
  return (task) => (flow || workflow).judgeTransition(null, task && task.status, task, null)
    .filter((blocker) => blocker.ruleId === ruleId)
    .map((blocker) => ({ code: blocker.code, message: blocker.message }));
}

// 흐름별 게이트 표. 흐름을 안 주면 내장 표가 나오고 그것이 예전 동작이다.
function taskGatesFor(flow) {
  return Object.freeze({
    'done-requires-test-link': gateFor('done-requires-test-link', flow)
  });
}

const DEFAULT_TASK_GATES = taskGatesFor(null);

// 검사의 판정부. 파일을 읽지 않고 이미 읽어 둔 값만 보고 진단을 만든다.
//
// 이 분리가 필요한 이유는 코드 정리가 아니라 답의 일치다. 같은 저장소 상태에서
// 명령줄과 보드와 워커 어댑터가 다른 판정을 내면 사람과 에이전트는 같은 계층이
// 아니게 된다. 판정이 파일 읽기와 붙어 있는 한 각 표면은 자기 경로로 다시
// 구현하게 되고, 다시 구현한 것들은 조금씩 달라진다.
//
// 그래서 여기에는 파일에 닿는 require가 없다. 값을 만드는 일은 check.js가 하고, 그
// 값을 보고 옳고 그름을 말하는 일만 여기서 한다. worker-contract-purity.test.js가
// 전이 의존까지 따라가며 이 경계를 지킨다.

const { isAssetPath } = require('./image-header');

// 자산 한계. 이 값들은 취향이 아니라 저장소 규모에서 나온다 — 문서 93개 전체가
// 780KB인 저장소에서 스크린샷 한 장이 그 절반을 차지하면, 방치했을 때 문서
// 브랜치는 곧 그림 브랜치가 된다.
//
// 긴 변 한계를 2560으로 둔 이유는 레티나 화면 갈무리가 그 두 배로 찍히기 때문이다.
// 사람이 문서에서 읽을 그림은 그 절반이면 충분하고, 넘으면 rdl asset add가
// 자동으로 줄인다.
const MAX_ASSET_BYTES = 512 * 1024;
const MAX_ASSET_EDGE = 2560;

/**
 * 코드 구역을 같은 길이의 공백으로 덮는다. 줄 번호와 열 위치가 그대로 남아야
 * 진단이 엉뚱한 줄을 지목하지 않으므로, 지우지 않고 덮는다.
 *
 * 코드 안의 `[[...]]`는 참조가 아니라 예시다. Obsidian도 코드 스팬 안의 링크를
 * 걸지 않는다. 덮지 않으면 링크 문법을 설명하는 문서가 자기 예시 때문에 검사에
 * 걸리고, 그러면 그 문법을 문서로 설명할 수 없게 된다.
 */
function maskCode(body) {
  const blank = (match) => match.replace(/[^\n\r]/gu, ' ');
  return String(body || '')
    // 울타리 블록이 먼저다. 그 안의 백틱은 인라인 스팬이 아니다.
    .replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\2[^\n]*$/gmu, blank)
    .replace(/(`+)(?:[^`]|(?!\1)`)*\1/gu, blank);
}

/**
 * 자산 embed가 실재하는 자산을 가리키는지 본다.
 *
 * 문서 참조와 자산 embed는 다른 것이다. `[[REQ-001]]`은 문서를 가리키고
 * `![[diagram.png]]`는 자산을 가리킨다. 둘을 같은 규칙으로 보면 이미지를 넣는
 * 순간 "해결되지 않은 문서 참조"가 되어 정본에 그림을 넣을 수 없게 된다.
 */
function checkAssetReference(list, values) {
  const { assets, target, sourceDoc, artifactId, line, strict } = values;
  const name = String(target || '');
  if (assets.has(name)) return;
  const suggestion = Array.from(assets.keys()).find((key) => key.toLowerCase() === name.toLowerCase());
  diagnostic(list, {
    code: 'RDL-ASSET-001',
    category: 'link',
    severity: strict ? 'error' : 'warning',
    file: sourceDoc.relativeFile,
    line: line || 1,
    artifactId: artifactId || null,
    target: name,
    message: suggestion
      ? `자산 참조의 대소문자가 실제 파일과 다릅니다: ${name} (실제: ${suggestion})`
      : `해결되지 않은 자산 참조입니다: ${name}. rdl asset add로 넣으면 자산 디렉터리에 자리를 잡습니다.`
  });
}

/**
 * 자산 자체의 규격과 쓰임을 본다. 값만 받는다 — 바이트를 읽는 일은 호출자가 하고
 * 여기서는 이미 잰 크기와 차원만 본다.
 *
 * 한 자산이 여러 진단에 걸릴 수 있다. 첫 진단에서 멈추지 않는 이유는, 크기만
 * 알려주고 차원을 감추면 사람이 압축만 해 보고 다시 걸리기 때문이다.
 */
function checkAssetInventory(list, values) {
  const { assets, referenced, limits } = values;
  const maxBytes = (limits && limits.bytes) || MAX_ASSET_BYTES;
  const maxEdge = (limits && limits.edge) || MAX_ASSET_EDGE;
  for (const [name, asset] of assets) {
    if (asset.bytes > maxBytes) {
      diagnostic(list, {
        code: 'RDL-ASSET-002',
        category: 'structure',
        severity: 'warning',
        file: asset.relativeFile,
        target: name,
        message: `자산이 ${Math.round(asset.bytes / 1024)}KB로 한계 ${Math.round(maxBytes / 1024)}KB를 넘습니다. rdl asset add --max-edge <px>로 다시 넣으면 PNG와 JPEG는 자동으로 줄어듭니다.`
      });
    }
    const longest = Math.max(asset.width || 0, asset.height || 0);
    if (longest > maxEdge) {
      diagnostic(list, {
        code: 'RDL-ASSET-003',
        category: 'structure',
        severity: 'warning',
        file: asset.relativeFile,
        target: name,
        message: `자산이 ${asset.width}x${asset.height}로 긴 변 한계 ${maxEdge}px를 넘습니다. 문서에서 읽을 그림은 그 절반이면 충분합니다.`
      });
    }
    // 형식을 알아보지 못하는 파일은 그림이 아닐 수 있다. 자산 디렉터리는 문서가
    // 참조하는 그림의 자리이므로, 알아보지 못한 것이 있으면 그 사실을 말한다.
    if (!asset.format) {
      diagnostic(list, {
        code: 'RDL-ASSET-004',
        category: 'structure',
        severity: 'warning',
        file: asset.relativeFile,
        target: name,
        message: '자산의 형식을 알아보지 못했습니다. 자산 디렉터리에는 문서가 참조하는 그림만 둡니다.'
      });
    }
    // 아무 문서도 가리키지 않는 자산은 지워도 아무 일이 없다. 그런데 지워도 되는지
    // 아무도 모르면 지우지 못하고, 그렇게 쌓인다.
    if (!referenced.has(name)) {
      diagnostic(list, {
        code: 'RDL-ASSET-005',
        category: 'structure',
        severity: 'warning',
        file: asset.relativeFile,
        target: name,
        message: '어느 문서도 참조하지 않는 자산입니다. 참조를 넣거나 파일을 지우세요.'
      });
    }
  }
}

const REQUIRED_FIELDS = ['id', 'type', 'kind', 'title', 'description', 'owner', 'state', 'tags', 'aliases', 'related'];
const ID_PATTERN = /^[A-Z]{3}-\d{3,}$/u;
const FILE_PATTERN = /^[A-Z]{3}-\d{3,}-(?=.*[가-힣])[가-힣A-Za-z0-9]+(?:-[가-힣A-Za-z0-9]+)*\.md$/u;
const NON_CANONICAL_CODES = new Set(['NTE']);
const REQUIRED_TAG_NAMESPACES = ['rundol/', 'artifact/', 'domain/', 'feature/'];
const NOTE_TAG_NAMESPACES = ['rundol/'];
// 조인 키의 형식 판정. 정체성 모듈이 아니라 규칙 쪽에 두는 이유는, 이것이 값 하나를
// 보고 옳고 그름을 말하는 규칙이기 때문이다. 저장·부여는 정체성 모듈의 일이고
// 그 모듈은 파일을 읽으므로, 판정이 거기 있으면 판정도 함께 파일에 묶인다.
const DOCUMENT_UID = /^[0-9A-HJKMNP-TV-Z]{8}$/u;

// 두 축의 어휘. 목록을 여기 다시 적지 않는 이유는 이 저장소가 vocabulary.js를 만든
// 이유 그대로다 — 두 번째로 적을 수 있으면 언젠가 두 목록은 갈리고, 갈린 날 검사기는
// 정본이 모르는 값을 통과시키거나 정본이 아는 값을 막는다.
const { DOCUMENT_STATE_KEYS, DOCUMENT_LIFECYCLE_KEYS } = require('./vocabulary');

/**
 * `state`와 `lifecycle`의 값 판정. 두 칸이 같은 모양인데 심각도가 다르다.
 *
 * `lifecycle`은 **사람이 소유한다.** 아무것도 이 칸을 굴리지 않으므로 어휘 밖 값은
 * 스스로 낫지 않고, 낫지 않는 오타는 그 문서를 수명 조회에서 영영 빼놓는다. 고칠 수
 * 있는 사람이 그 자리에 있으므로 오류로 막는다.
 *
 * `state`는 **rdl이 소유한다.** 사람은 이 칸을 적는 자리에 있지 않고, 어휘 밖 값은
 * 다음 동기화의 투영이 덮어써 스스로 낫는다. 그 값을 오류로 막으면 아직 이관하지 않은
 * 저장소가 판올림만으로 전 문서에서 멈추는데 — 여기만 해도 151건, run-ops는 55건이다 —
 * 막힌 사람이 할 수 있는 일은 자기가 소유하지도 않은 칸을 손으로 고치는 것뿐이다.
 * 그리고 모든 문서에서 터지는 관문은 곧 꺼진다. 그래서 경고로 알리고 갈 길을 말한다.
 *
 * 요약하면 심각도는 "무엇이 잘못됐나"가 아니라 "누가 고칠 수 있나"로 갈린다.
 *
 * 없는 것은 진단하지 않는다. `lifecycle`은 선택 칸이고, 비어 있는 것과 `active`는
 * 다르다 — 대부분의 문서는 수명을 따로 말할 것이 없다. `state`가 없는 것은 필수 필드
 * 판정(RDL-DOC-002 · RDL-PROJECT-002)이 이미 말하므로 여기서 다시 말하지 않는다.
 */
function checkStateVocabulary(list, doc, artifactId) {
  const meta = doc.frontmatter.data;
  const locations = doc.frontmatter.locations;
  const value = (key) => {
    const raw = meta[key];
    if (raw === undefined || raw === null || raw === '') return null;
    // 값 없는 `lifecycle:` 한 줄은 파서가 빈 배열로 읽는다. 그것을 "없음"으로 접으면
    // 적다 만 줄이 정상으로 보이므로, 문자열이 아닌 것은 어긋난 값으로 다룬다.
    return typeof raw === 'string' ? raw.trim() : String(Array.isArray(raw) ? raw.join(', ') : raw);
  };
  const lifecycle = value('lifecycle');
  if (lifecycle !== null && !DOCUMENT_LIFECYCLE_KEYS.includes(lifecycle)) {
    diagnostic(list, {
      code: 'RDL-DOC-017', file: doc.relativeFile, line: locations.lifecycle || 2, artifactId,
      message: `문서 수명 값이 어휘 밖입니다: ${lifecycle || '(빈 값)'} (가능: ${DOCUMENT_LIFECYCLE_KEYS.join(', ')}, 또는 칸 자체를 두지 않습니다)`
    });
  }
  const state = value('state');
  if (state !== null && !DOCUMENT_STATE_KEYS.includes(state)) {
    diagnostic(list, {
      code: 'RDL-DOC-018', severity: 'warning', file: doc.relativeFile, line: locations.state || 2, artifactId,
      message: `문서 상태 값이 어휘 밖입니다: ${state} (가능: ${DOCUMENT_STATE_KEYS.join(', ')}). state는 rdl이 원장에서 투영하는 칸입니다. 수명을 뜻하는 값이면 rdl doc migrate가 lifecycle 칸으로 옮깁니다.`
    });
  }
}

const GOVERNANCE_HEADINGS = ['미션', '목표', '범위', '역할', '프로젝트 팀원', '이해관계자', '책임 매트릭스', '의사결정과 에스컬레이션', '위험과 제약', '협업 리듬', '완료 정의'];
const GOVERNANCE_BLOCK_FIELDS = {
  ROLE: ['미션', '결정권', '주요 산출물', '에스컬레이션'],
  MEMBER: ['역할', '소속', '업무 계정', '책임 영역', '상태'],
  STAKEHOLDER: ['유형', '관심', '영향력', '참여 방식', '담당 역할']
};

function headingKey(value) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function wikiTarget(value) {
  if (typeof value !== 'string') return null;
  const match = /^\[\[([^|\]#]+)(?:#([^|\]]+))?(?:\|[^\]]+)?\]\]$/.exec(value.trim());
  return match ? { id: match[1], anchor: match[2] || null } : null;
}

function lineOf(source, needle) {
  const index = source.indexOf(needle);
  if (index < 0) return 1;
  return source.slice(0, index).split(/\r?\n/).length;
}

function diagnostic(list, values) {
  // 진단은 자기 코드와 메시지와 대상만 나른다. 여기서 정본 문서 번호를 붙여 내보내던
  // 때에는 남의 저장소에서 검사를 돌려도 그 저장소에 없는 REQ 번호가 근거로 실렸다.
  // 진단 코드는 제품 것이고 문서 번호는 그 프로젝트 것이라, 둘은 섞이는 게 아니라
  // 만나지 않는다. 근거는 문서가 선언하고 조회가 모은다 — diagnostic-rules.js 머리말.
  list.push(Object.assign({ severity: 'error', category: 'metadata', file: null, line: 1, artifactId: null, target: null }, values));
}

function resolveArtifact(registry, id) {
  return registry.get(id) || null;
}

function uniqueDocuments(documents) {
  const seen = new Set();
  return documents.filter((document) => {
    const key = document.file || document.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function governanceBlocks(doc) {
  const result = [];
  const pattern = /^###\s+(.+?)\s+\^(ROLE|MEMBER|STAKEHOLDER)-([A-Z0-9]+)\s*$/gm;
  const matches = Array.from(doc.body.matchAll(pattern));
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const nextHeading = doc.body.slice(match.index + match[0].length).search(/^#{2,3}\s+/m);
    const end = nextHeading < 0 ? doc.body.length : match.index + match[0].length + nextHeading;
    const source = doc.body.slice(match.index, end);
    const fields = new Map();
    for (const field of source.matchAll(/^-\s+([^:]+):\s*(.*)$/gm)) fields.set(field[1].trim(), field[2].trim());
    result.push({ type: match[2], id: `${match[2]}-${match[3]}`, name: match[1].trim(), source, fields, line: doc.bodyStartLine + doc.body.slice(0, match.index).split(/\r?\n/).length - 1 });
  }
  return result;
}

function checkProjectGovernance(list, projectDoc) {
  if (!projectDoc) return;
  for (const heading of GOVERNANCE_HEADINGS) {
    if (!projectDoc.headings.has(headingKey(heading))) diagnostic(list, { code: 'RDL-GOV-001', category: 'governance', file: projectDoc.relativeFile, artifactId: projectDoc.id, message: `프로젝트 거버넌스 필수 섹션이 없습니다: ${heading}` });
  }
  const blocks = governanceBlocks(projectDoc);
  for (const type of Object.keys(GOVERNANCE_BLOCK_FIELDS)) {
    if (!blocks.some((block) => block.type === type)) diagnostic(list, { code: 'RDL-GOV-002', category: 'governance', file: projectDoc.relativeFile, artifactId: projectDoc.id, message: `${type} 정의가 하나 이상 필요합니다.` });
  }
  for (const block of blocks) {
    for (const field of GOVERNANCE_BLOCK_FIELDS[block.type]) {
      if (!block.fields.has(field) || !block.fields.get(field)) diagnostic(list, { code: 'RDL-GOV-003', category: 'governance', file: projectDoc.relativeFile, line: block.line, artifactId: projectDoc.id, target: block.id, message: `${block.id}에 필수 필드가 없습니다: ${field}` });
    }
  }
}

function checkReference(list, fileRegistry, artifactRegistry, sourceDoc, rawValue, values) {
  const target = wikiTarget(rawValue);
  if (!target) {
    diagnostic(list, Object.assign({
      code: 'RDL-LINK-001', category: 'link', file: sourceDoc.relativeFile,
      line: lineOf(sourceDoc.source, String(rawValue)), artifactId: values.artifactId,
      message: `Wiki link 형식이 아닙니다: ${rawValue}`
    }, values));
    return;
  }
  const targetDoc = fileRegistry.get(target.id) || null;
  if (!targetDoc) {
    const aliasDoc = resolveArtifact(artifactRegistry, target.id);
    diagnostic(list, Object.assign({
      code: aliasDoc ? 'RDL-LINK-006' : 'RDL-LINK-002', category: 'link', file: sourceDoc.relativeFile,
      line: lineOf(sourceDoc.source, rawValue), artifactId: values.artifactId, target: target.id,
      message: aliasDoc
        ? `Obsidian link 대상은 alias가 아니라 실제 파일명이어야 합니다: [[${aliasDoc.fileStem}|${target.id}]]`
        : `존재하지 않는 Obsidian 파일을 참조합니다: ${target.id}`
    }, values));
    return;
  }
  if (target.anchor) {
    const exists = target.anchor.startsWith('^')
      ? targetDoc.blocks.has(target.anchor.slice(1))
      : targetDoc.headings.has(headingKey(target.anchor));
    if (!exists) {
      diagnostic(list, Object.assign({
        code: 'RDL-LINK-003', category: 'link', file: sourceDoc.relativeFile,
        line: lineOf(sourceDoc.source, rawValue), artifactId: values.artifactId, target: `${target.id}#${target.anchor}`,
        message: `존재하지 않는 섹션 또는 block을 참조합니다: ${target.id}#${target.anchor}`
      }, values));
    }
  }
}

// ── 기능 ID가 가리키는 부모 ─────────────────────────────────────────────────
//
// 기능 ID는 부모를 단 참조다 — REQ-033#FN-001. related는 실재를 확인받고 없는 대상을
// 가리키면 거절당하는데, 이 값은 아무 확인도 받지 않았다. 없는 REQ를 가리켜도, 있는
// REQ이지만 그 REQ가 선언한 적 없는 기능을 가리켜도 문서가 만들어지고 검사는 0건을
// 냈다. 그러면 그 기능은 원천 계약 없이 존재하고, 추적성은 그것을 "TST가 없는 기능"이
// 아니라 "REQ가 없는 기능"으로 세는데 아무도 그 수를 보지 않는다.
//
// 구현 계약 계층이 아니라 링크 계층에 두는 이유. 없앤 RDL-IMPL-011이 남긴 물음이
// 정확히 이것이고, 그 물음은 "원천이 없다"가 아니라 "가리킨 것이 해결되지 않는다"이다 —
// 참조 해결은 링크 계층이 답한다(implementation-contract.js의 머리말이 그렇게 적어 두었다).
//
// 코드도 새로 파지 않는다. 부모 문서가 없는 것은 related가 없는 문서를 가리킬 때와 같은
// 사건이고(RDL-LINK-002), 부모는 있는데 그 기능을 선언하지 않은 것은 문서는 있는데 그
// 안의 자리가 없는 것과 같은 사건이다(RDL-LINK-003). 두 사건 다 frontmatter의 값 하나를
// 고치라고 시키고, 시키는 일이 같으면 코드도 같다.
function checkFunctionParents(list, artifactRegistry, sourceDoc, values) {
  const { IMPLEMENTATION_TYPES, FUNCTION_SOURCE_TYPE, qualifiedFunctionIds, subParent } = require('./implementation-contract');
  const type = documentTypeCode(sourceDoc.id);
  // 기능 ID를 나르지 않는 유형(PRD·ADR·ARC…)에는 이 물음이 없다. REQ도 아니다 —
  // REQ는 기능의 원천이라 자기 기능을 선언하는 것이지 남을 가리키는 것이 아니고,
  // 그 갈래를 여기서 막으면 원천이 자기 자신을 못 찾는다.
  if (!type || type === FUNCTION_SOURCE_TYPE || !IMPLEMENTATION_TYPES.includes(type)) return;
  const meta = (sourceDoc.frontmatter && sourceDoc.frontmatter.data) || {};
  // 표기가 어긋난 값은 여기서 말하지 않는다. qualifiedFunctionIds가 부모를 단 표기만
  // 돌려주고, 표기 자체는 RDL-IMPL-003이 이미 같은 값을 보고 답한다.
  for (const functionId of qualifiedFunctionIds(type, sourceDoc.id, meta)) {
    const parent = subParent(functionId);
    const parentDoc = parent ? artifactRegistry.get(parent) : null;
    if (!parentDoc) {
      diagnostic(list, Object.assign({
        code: 'RDL-LINK-002', category: 'link', file: sourceDoc.relativeFile,
        line: lineOf(sourceDoc.source, functionId), artifactId: sourceDoc.id, target: parent,
        message: `기능 ID의 원천 문서가 없습니다: ${functionId} (${parent}을(를) 찾지 못했습니다)`
      }, values));
      continue;
    }
    const parentMeta = (parentDoc.frontmatter && parentDoc.frontmatter.data) || {};
    const declared = qualifiedFunctionIds(documentTypeCode(parent), parent, parentMeta);
    if (declared.includes(functionId)) continue;
    diagnostic(list, Object.assign({
      code: 'RDL-LINK-003', category: 'link', file: sourceDoc.relativeFile,
      line: lineOf(sourceDoc.source, functionId), artifactId: sourceDoc.id, target: functionId,
      // 그 문서가 선언한 기능을 함께 싣는다. 없는 자리를 가리켰다는 말만 하면 사람은
      // 무엇으로 고쳐야 하는지를 다시 조사해야 하고, 답은 이미 여기 있다.
      message: declared.length
        ? `${parent}이(가) 선언하지 않은 기능을 가리킵니다: ${functionId} (${parent}의 기능: ${declared.join(', ')})`
        : `${parent}이(가) 선언하지 않은 기능을 가리킵니다: ${functionId} (${parent}은(는) 기능을 하나도 선언하지 않았습니다)`
    }, values));
  }
}

// ── 하류가 상류 확정보다 앞서 있다 ──────────────────────────────────────────
//
// related는 방향이 없는 연결이다. 무엇이 상류이고 무엇이 하류인지는 유형이 정하고,
// 그 유형 순서는 문서 작성 순서 표가 이미 알고 있다 — contract next가 "다음에 무엇을
// 쓸 수 있나"를 답할 때 보는 그 표다. 여기서 표를 다시 지으면 두 벌이 되고, 두 벌은
// 한쪽만 고쳐지는 날 갈린다. 그때 같은 문서가 "쓸 수 있다"와 "상류가 아직 없다"를
// 동시에 듣는다.
//
// 표는 어휘에서 가져오고 판정은 여기 둔다. 표가 계약 층(document-profile)에 있으면
// 이 판정은 그것을 볼 수 없다 — 그 모듈은 파일을 읽고 판정 계층은 파일을 몰라야 하며,
// 그 불변식은 worker-contract-purity 시험이 지킨다.
const { DEFAULT_DOCUMENT_ORDER } = require('./vocabulary');

// 직계 선행만으로는 부족하다. SCR의 선행은 REQ뿐이지만 REQ의 선행인 PRD도 SCR의
// 상류다 — 상류가 흔들리면 거리와 무관하게 하류가 흔들린다. 그래서 이행 폐포를
// 미리 접어 둔다. 표가 상수라 한 번만 돈다.
//
// 층수도 같은 표에서 나온다. 선행이 없으면 0, 있으면 선행 중 가장 깊은 것보다 하나
// 아래다. 문서 생성 파이프라인의 흐름을 훑는 자리가 이 값으로 층을 센다.
const { UPSTREAM_CLOSURE, DOCUMENT_LAYERS } = (() => {
  const closure = {};
  const layers = {};
  const resolve = (type, seen) => {
    if (closure[type]) return closure[type];
    // 표에 순환이 생기면 여기서 무한히 돈다. 순환은 계약의 오류지 이 함수가 고칠
    // 것이 아니므로, 되짚어 온 유형은 자기 자신을 상류로 세지 않고 끊는다.
    if (seen.has(type)) return new Set();
    seen.add(type);
    const direct = DEFAULT_DOCUMENT_ORDER[type] || [];
    const collected = new Set();
    let depth = 0;
    for (const dependency of direct) {
      collected.add(dependency);
      for (const ancestor of resolve(dependency, seen)) collected.add(ancestor);
      depth = Math.max(depth, (layers[dependency] === undefined ? 0 : layers[dependency]) + 1);
    }
    seen.delete(type);
    closure[type] = collected;
    layers[type] = depth;
    return collected;
  };
  for (const type of Object.keys(DEFAULT_DOCUMENT_ORDER)) resolve(type, new Set());
  return { UPSTREAM_CLOSURE: Object.freeze(closure), DOCUMENT_LAYERS: Object.freeze(layers) };
})();

/**
 * 낡음과 미승인은 하류에 주는 뜻이 다르다. 앞엣것은 "네가 근거로 삼은 것이 바뀌었다"이고
 * 뒤엣것은 "네가 아직 확정되지 않은 것 위에 섰다"이다. 한 코드로 묶으면 사람이 목록을
 * 보고 어느 쪽을 먼저 볼지 정하지 못한다 — 보드의 attention이 낡음만 드는 것과 같은 가름.
 */
const UPSTREAM_TRUST_CODES = Object.freeze({ stale: 'RDL-APPROVE-030', unapproved: 'RDL-APPROVE-031' });

// 한 줄에 실을 하류 이름의 수. 41건을 늘어놓은 줄은 읽히지 않고, 읽히지 않는 줄은
// 없는 줄과 같다. 전부는 dependents가 값으로 나르므로 사람이 볼 것만 여기서 줄인다.
const UPSTREAM_DEPENDENT_SAMPLE = 4;

function documentTypeCode(id) {
  const value = String(id || '');
  return ID_PATTERN.test(value) ? value.slice(0, 3) : null;
}

/** 이 유형이 근거로 삼는 유형 전부. 없는 유형에는 상류가 없다 — 모른다가 아니라 없다. */
function upstreamTypes(type) {
  return Array.from(UPSTREAM_CLOSURE[String(type || '')] || []).sort();
}

/** 문서 생성 파이프라인에서 이 유형이 서는 층. 정규 유형이 아니면 null이다. */
function documentLayer(type) {
  const key = String(type || '');
  return DOCUMENT_LAYERS[key] === undefined ? null : DOCUMENT_LAYERS[key];
}

/**
 * related 값에서 문서 식별자를 뽑는다. 표시 링크가 정본이라 [[REQ-001-제목|REQ-001]]과
 * [[REQ-001]]이 모두 오고, 링크 표기 없이 식별자만 적힌 값도 온다.
 *
 * 그 대상이 실재하는지는 묻지 않는다. 여기서 걸러 버리면 "가리키는 것이 없다"와
 * "가리킨 것이 미승인이다"가 같은 null이 되어 부르는 쪽이 둘을 가르지 못한다.
 */
function relatedTargetId(value) {
  const target = wikiTarget(value);
  const raw = String((target && target.id) || value || '').trim();
  return ID_PATTERN.test(raw) ? raw : (/^([A-Z]{3}-\d{3,})-/u.exec(raw) || [])[1] || null;
}

function trustStatusOf(trust, id) {
  if (!trust) return null;
  const value = typeof trust.get === 'function' ? trust.get(id) : trust[id];
  return value || null;
}

/**
 * 하류가 미승인·낡은 상류를 근거로 삼고 있는가.
 *
 * 명령이 아니라 진단으로 내는 자리의 판정부다. 진단이면 check·보드·watch가 전부
 * 공짜로 이것을 보고, 명령이면 따로 불러야 하는 통제가 되어 며칠 뒤 아무도 안 부른다.
 *
 * used는 이 프로젝트가 승인 축을 쓰는지다. 한 번도 승인하지 않은 프로젝트에서 전
 * 문서가 미승인인 것은 상태가 아니라 그 축을 안 쓴다는 뜻이라, 화면은 "0건"과 "해당
 * 없음"을 이 값으로 가른다(doc pipeline의 used). 이 규칙의 문턱은 아니다 — 문턱은
 * 아래처럼 줄마다 선다.
 *
 * ── 미승인 상류의 문턱은 프로젝트가 아니라 줄에 있다 ────────────────────────
 *
 * 한때 문턱이 전역이었다. 승인이 하나라도 살아 있으면(approved > 0) 미승인 상류를 전부
 * 냈고, 처음에는 그보다 넓게 approved + stale > 0이었다 — 런돌 자신의 프로젝트(승인 0 ·
 * 낡음 2 · 미승인 131)가 그 넓은 문턱을 넘어 경고가 2건에서 121건이 됐고 그중 119줄이
 * 같은 문장이었다. 좁힌 뒤에도 같은 그림이 남았다: 승인 1건(REQ-064)이 59줄을 열었는데
 * 137쌍 · 하류 118건 중 승인이나 낡음인 하류를 가진 줄은 0건이었다. 즉 59줄 전부가
 * "미승인이 미승인 위에 섰다"였고, 그 줄들이 시키는 일은 "이 59건을 승인하라" —
 * 진단이 아니라 백로그 덤프다.
 *
 * 그래서 문턱을 줄로 옮겼다. 그 상류를 근거로 삼은 하류 중 하나라도 승인 또는 낡음일
 * 때만 그 줄을 낸다. 그러면 이 규칙이 말하는 사건이 하나로 좁혀진다 — 누군가 굳힌 것이
 * 아직 굳지 않은 것 위에 서 있다. 둘 다 아직 굳지 않은 자리는 앞선 것이 아니라 그냥
 * 아직 안 굳은 것이고, 그것은 목록이지 사건이 아니다.
 *
 * 전역 문턱은 이 문턱이 삼킨다. 승인이 하나도 없는 프로젝트에는 승인된 하류가 없어 줄이
 * 서지 않고, 낡은 하류가 있다면 그것은 누군가 실제로 승인했던 문서다. 문턱을 둘 겹치면
 * 그 자리에서 둘이 다른 답을 하므로 하나만 둔다.
 *
 * ── 낡은 상류는 줄 문턱도 유형 폐포도 지나지 않는다 ─────────────────────────
 *
 * 낡음은 "누군가 승인한 것이 흔들렸다"는 사건 자체다. 그 위에 선 하류가 굳었든 아니든
 * 이미 일어난 일이라 줄 문턱을 걸지 않는다.
 *
 * 유형 폐포도 걸지 않는다. 상류로 지목될 수 있는 유형은 작성 순서 표의 값 집합인
 * PRD · REQ · ARC 셋뿐인데, 실측에서 ADR-020이 승인 후 개정되어 낡았고 related로 12건이
 * 그것을 인용하며 그중 하나가 이 저장소의 유일한 승인 문서(REQ-064)인데도 진단이 0건이었다.
 * ADR은 REQ · SCR이 인용하므로 "상류" 방향이 애초에 맞지 않는다 — 낡음은 하류 유형과
 * 무관하게 낡은 문서 자신에게 걸려야 한다.
 *
 * 미승인에는 폐포를 그대로 둔다. 미승인은 문서 대부분의 기본 상태라, 폐포를 풀면 전
 * 문서가 서로를 지목한다. 두 축의 성격이 다른 것이 요점이다.
 *
 * 입력은 값뿐이다. documents는 { id, file, related }면 되고 trust는 id마다
 * approved·stale·unapproved를 답하는 Map 또는 객체다 — 승인 판정은 approval.js의
 * trustState가 이미 하므로 여기서 다시 세지 않는다.
 *
 * ── 세는 단위는 (하류, 상류) 짝이 아니라 상류다 ─────────────────────────────
 *
 * 짝으로 세면 같은 사실이 하류 수만큼 곱해진다. 런돌 자신의 프로젝트가 그 모양이었다:
 * 미승인 상류 59건을 하류 117건이 참조해 경고가 136줄이었고, 그중 77줄은 앞선 줄의
 * 사본이었다. 하류로 말아 올려도 소용이 없다 — 하류 117건 중 105건은 미승인 상류가
 * 하나뿐이라 136줄이 117줄이 될 뿐이다.
 *
 * 축을 상류로 잡은 근거는 수가 아니라 행동이다. 이 경고가 시키는 일은 언제나 "그
 * 상류를 승인하라" 하나이고, 그 일은 상류마다 하나 있다. PRD-001 한 건을 승인하면
 * 41줄이 함께 그친다 — 짝으로 세면 그 한 번의 행동이 41줄에 41번 적힌다.
 *
 * 문서 하나를 지목하는 갈래(rdl check REQ-064)는 이 판정을 다시 부르지 않는다.
 * bin/rdl.js의 filterDiagnostics가 같은 진단 목록에서 artifactId 또는 target이 그
 * ID와 같은 줄만 거를 뿐이라, 두 갈래는 한 규칙의 한 결과를 나눠 본다. 갈래마다 축을
 * 달리 잡을 자리가 없으므로 한 축이 둘을 다 서야 하고, 그 축은 행동이 있는 쪽이다.
 * 대신 그 갈래에서 하류를 지목하면 자기 상류 줄이 잡히지 않는다 — 그 ID는 이제
 * dependents에만 있고 거르개는 그 칸을 보지 않는다. 상류를 지목한 쪽(rdl check
 * PRD-001)은 그대로 남는다.
 */
function upstreamTrustIssues(input) {
  const documents = (input && input.documents) || [];
  const trust = input && input.trust;
  // 집합이 아니라 지도로 든다. 경고가 지목하는 문서가 하류에서 상류로 바뀌었으므로
  // 부르는 쪽이 여는 파일도 상류의 것이고, 그 파일은 문서 값에만 있다.
  const known = new Map(documents.map((document) => [String(document.id), document]));
  const counts = { approved: 0, stale: 0, unapproved: 0 };
  for (const document of documents) {
    const status = trustStatusOf(trust, String(document.id));
    if (status) counts[status] = (counts[status] || 0) + 1;
  }
  // 상류마다 한 칸. 짝을 그대로 담으면 이 규칙이 다시 교차곱이 된다.
  const rolled = new Map();
  for (const document of documents) {
    const type = documentTypeCode(document.id);
    const upstream = (type && UPSTREAM_CLOSURE[type]) || null;
    const seen = new Set();
    for (const value of Array.isArray(document.related) ? document.related : []) {
      const target = relatedTargetId(value);
      // 해결되지 않는 참조는 여기서 말하지 않는다. 링크 계층의 물음이고 RDL-LINK-002가
      // 이미 같은 값을 보고 답한다 — 없는 문서는 미승인 상류가 아니다.
      if (!target || !known.has(target) || target === document.id || seen.has(target)) continue;
      const targetType = documentTypeCode(target);
      if (!targetType) continue;
      seen.add(target);
      const status = trustStatusOf(trust, target);
      if (status !== 'stale' && status !== 'unapproved') continue;
      // 폐포는 미승인에만 건다. 미승인은 문서 대부분의 기본 상태라 방향을 유형이
      // 잡아 주지 않으면 전 문서가 서로를 지목하고, 낡음은 방향과 무관하게 낡은
      // 문서 자신의 사건이다 — ADR은 아무의 상류도 아니지만 낡을 수 있다.
      if (status === 'unapproved' && !(upstream && upstream.has(targetType))) continue;
      if (!rolled.has(target)) rolled.set(target, { status, targetType, dependents: [] });
      rolled.get(target).dependents.push(String(document.id));
    }
  }
  // 굳은 하류. 승인 또는 낡음이면 누군가 이 문서를 근거로 삼겠다고 한 번 결정한 것이고,
  // 낡음이 여기 드는 것은 그것이 "승인했다가 흔들렸다"이기 때문이다.
  const settledDependents = (dependents) => dependents.filter((id) => {
    const status = trustStatusOf(trust, id);
    return status === 'approved' || status === 'stale';
  });
  const issues = Array.from(rolled.entries())
    // 미승인 상류의 문턱은 줄에 있다. 그 위에 선 하류가 전부 미승인이면 그것은 아직
    // 아무도 굳지 않은 자리이고, 그 줄이 시키는 일은 진단이 아니라 백로그다.
    .filter(([, group]) => group.status !== 'unapproved' || settledDependents(group.dependents).length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([target, group]) => {
      const dependents = group.dependents.slice().sort((left, right) => left.localeCompare(right));
      const count = dependents.length;
      const upstreamDocument = known.get(target);
      const sample = dependents.slice(0, UPSTREAM_DEPENDENT_SAMPLE).join(' · ')
        + (count > UPSTREAM_DEPENDENT_SAMPLE ? ` 외 ${count - UPSTREAM_DEPENDENT_SAMPLE}건` : '');
      // 이 줄이 선 까닭. 굳은 하류가 없으면 미승인 줄은 서지 않으므로 그 줄은 언제나
      // 이 값을 갖는다. 줄이 그 이름을 들지 않으면 사람은 "왜 지금 이것을 승인해야
      // 하나"를 하류 목록에서 다시 찾아야 하고, 그 조사가 이 진단의 비용이 된다.
      const settled = settledDependents(dependents);
      const settledSample = settled.slice(0, UPSTREAM_DEPENDENT_SAMPLE).join(' · ')
        + (settled.length > UPSTREAM_DEPENDENT_SAMPLE ? ` 외 ${settled.length - UPSTREAM_DEPENDENT_SAMPLE}건` : '');
      return {
        code: UPSTREAM_TRUST_CODES[group.status],
        severity: 'warning',
        status: group.status,
        // artifactId와 file은 이제 상류의 것이다. 이 경고가 사람에게 시키는 하나의
        // 행동이 그 문서를 승인하는 일이고, 그러려면 열 파일도 그 문서의 것이어야 한다.
        artifactId: target,
        type: group.targetType,
        file: (upstreamDocument && upstreamDocument.file) || null,
        target,
        targetType: group.targetType,
        // 이 상류를 근거로 삼은 하류 전부. 줄에는 몇 개만 실리므로, 세거나 되짚는 쪽은
        // 메시지가 아니라 이 값을 본다.
        dependents,
        // 낡음 쪽은 "하류"라 부르지 않는다. 이 갈래는 유형 폐포를 지나지 않으므로
        // 인용한 쪽이 하류라는 보장이 없다 — ADR-020을 인용한 12건 중에는 ADR도 REQ도
        // 있고, 그 둘의 방향은 표가 정하지 않는다. 참인 것은 "근거로 삼았다" 하나다.
        message: group.status === 'stale'
          ? `${target}이(가) 승인 후 개정되어 낡았습니다. 이 문서를 근거로 삼은 문서 ${count}건(${sample})이 바뀐 내용 위에 서 있습니다 — rdl doc diff ${target} --since-approval로 바뀐 곳만 보고 재승인하면 ${count}건이 함께 그칩니다.`
          : `${target}이(가) 아직 승인되지 않았는데 이미 굳은 하류 ${settled.length}건(${settledSample})이 그 위에 서 있습니다. ${target}을(를) 승인하면 이를 상류로 삼은 하류 ${count}건(${sample})이 함께 그칩니다.`
      };
    });
  // used는 이 판정의 문턱이 아니라 화면이 "0건"과 "해당 없음"을 가르는 값이다. 승인이
  // 살아 있는 문서가 하나도 없으면 이 프로젝트는 승인을 관문으로 굴리고 있지 않다 —
  // 낡음만 남은 상태는 축을 쓴다는 증거가 아니라 축을 놓았거나 전면 개정 중이라는 뜻이다.
  return { used: counts.approved > 0, counts, issues };
}

function isDocumentUid(value) {
  return DOCUMENT_UID.test(String(value || ''));
}

/**
 * 문서 하나의 메타데이터 판정. 이미 읽어 둔 문서 값과 파일 이름만 보고 답한다.
 *
 * 파일을 여는 일은 호출자가 이미 끝냈다. 여기서 다시 열면 같은 문서를 두 번 읽게
 * 되고, 그보다 나쁘게는 이 판정이 파일 시스템에 묶여 보드나 워커 어댑터가 같은
 * 판정을 부를 수 없게 된다.
 *
 * 경계 계약과 구현 계약 판정은 각자 순수 모듈이 갖고 있으므로 그대로 위임한다.
 */
function checkDocumentMetadata(list, doc, fileName, delegates) {
  if (!doc.frontmatter) {
    diagnostic(list, { code: 'RDL-DOC-001', file: doc.relativeFile, message: 'YAML frontmatter가 없습니다.' });
    return null;
  }
  const meta = doc.frontmatter.data;
  const artifactId = typeof meta.id === 'string' ? meta.id : null;
  const locations = doc.frontmatter.locations;

  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(meta, field) || meta[field] === '' || meta[field] === null) {
      diagnostic(list, { code: 'RDL-DOC-002', file: doc.relativeFile, line: locations[field] || 2, artifactId, message: `필수 메타 필드가 없습니다: ${field}` });
    }
  }
  if (!artifactId || !ID_PATTERN.test(artifactId)) diagnostic(list, { code: 'RDL-DOC-003', file: doc.relativeFile, line: locations.id || 2, artifactId, message: `문서 ID는 3자리 코드와 3자리 이상 숫자여야 합니다: ${artifactId || '(없음)'}` });
  if (!FILE_PATTERN.test(fileName)) diagnostic(list, { code: 'RDL-DOC-004', file: doc.relativeFile, artifactId, message: '파일명은 <3자리 코드>-<번호>-<한글 제목>.md 형식이어야 합니다.' });
  if (artifactId && !fileName.startsWith(`${artifactId}-`)) diagnostic(list, { code: 'RDL-DOC-005', file: doc.relativeFile, artifactId, message: `파일명의 ID가 frontmatter ID와 다릅니다: ${fileName}` });
  if (typeof meta.title === 'string' && /[A-Za-z]/u.test(meta.title)) diagnostic(list, { code: 'RDL-DOC-006', file: doc.relativeFile, line: locations.title, artifactId, message: '문서 title은 한글 중심으로 작성하고 영문 약어는 description 또는 본문에서 설명하세요.' });

  const aliases = Array.isArray(meta.aliases) ? meta.aliases : [];
  if (aliases[0] !== artifactId) diagnostic(list, { code: 'RDL-DOC-007', file: doc.relativeFile, line: locations.aliases, artifactId, message: 'aliases의 첫 값은 문서 ID와 같아야 합니다.' });

  // 조인 키는 번호가 아니라 uid다. 형식이 어긋난 값은 조용히 무시하면 그 문서가
  // 조인에서 사라지므로 진단한다. 부여 자체가 없는 것은 아직 이관하지 않은 문서일
  // 수 있어 경고로 둔다.
  if (meta.uid === undefined) diagnostic(list, { code: 'RDL-DOC-014', severity: 'warning', file: doc.relativeFile, artifactId, message: '문서 고유 식별자(uid)가 없습니다. rdl doc identity --apply로 부여하세요.' });
  else if (!isDocumentUid(meta.uid)) diagnostic(list, { code: 'RDL-DOC-015', file: doc.relativeFile, line: locations.uid, artifactId, message: `문서 고유 식별자 형식이 잘못되었습니다: ${meta.uid}` });

  checkStateVocabulary(list, doc, artifactId);

  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  const namespaces = NON_CANONICAL_CODES.has(typeof artifactId === 'string' ? artifactId.slice(0, 3) : '') ? NOTE_TAG_NAMESPACES : REQUIRED_TAG_NAMESPACES;
  for (const namespace of namespaces) {
    if (!tags.some((tag) => typeof tag === 'string' && tag.startsWith(namespace))) {
      diagnostic(list, { code: 'RDL-DOC-008', file: doc.relativeFile, line: locations.tags, artifactId, message: `필수 태그 namespace가 없습니다: ${namespace}` });
    }
  }

  for (const issue of delegates.boundary(meta)) {
    diagnostic(list, { code: issue.code, category: 'granularity', file: doc.relativeFile, line: locations[issue.field] || 2, artifactId, message: issue.message });
  }
  for (const issue of delegates.implementation(doc)) {
    diagnostic(list, {
      code: issue.code, category: 'implementation', severity: issue.severity, file: doc.relativeFile,
      line: issue.line || locations.implementationContract || 2, artifactId, target: issue.target || null, message: issue.message
    });
  }
  return artifactId;
}

/**
 * 프로젝트 헌장의 메타데이터 판정. 이미 읽어 둔 문서 값과 프로젝트 키만 본다.
 *
 * 일반 문서와 규칙이 다른 이유는 헌장이 유형이 아니라 프로젝트 자체이기 때문이다.
 * 식별자가 프로젝트 키에서 파생하고, 파일 이름 규칙도 적용되지 않는다.
 */
function checkCharterMetadata(list, doc, projectKey) {
  if (!doc.frontmatter) {
    diagnostic(list, { code: 'RDL-PROJECT-001', category: 'governance', file: doc.relativeFile, message: 'project.md에 YAML frontmatter가 필요합니다.' });
    return;
  }
  const meta = doc.frontmatter.data;
  const locations = doc.frontmatter.locations;
  const expectedId = `project:${projectKey}`;
  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(meta, field) || meta[field] === '' || meta[field] === null) {
      diagnostic(list, { code: 'RDL-PROJECT-002', category: 'governance', file: doc.relativeFile, line: locations[field] || 2, artifactId: expectedId, message: `project.md 필수 메타 필드가 없습니다: ${field}` });
    }
  }
  // 값 어휘는 헌장이라고 달라지지 않는다. 필수 필드처럼 코드를 따로 주면 같은 오타가
  // 두 이름으로 답하게 되고, 그러면 어느 이름으로 찾아야 하는지를 파일 종류로 먼저
  // 판단해야 한다. 필수 필드가 코드를 가르는 이유는 규칙 자체가 다르기 때문이지만
  // (헌장은 파일명·ID 규칙이 아예 없다) 값 목록은 한 벌이므로 코드도 한 벌이다.
  checkStateVocabulary(list, doc, expectedId);
  if (meta.id !== expectedId) diagnostic(list, { code: 'RDL-PROJECT-003', category: 'governance', file: doc.relativeFile, line: locations.id || 2, artifactId: meta.id, message: `project.md id는 ${expectedId}여야 합니다.` });
  if (meta.type !== 'project') diagnostic(list, { code: 'RDL-PROJECT-004', category: 'governance', file: doc.relativeFile, artifactId: expectedId, message: 'project.md type은 project여야 합니다.' });
  const aliases = Array.isArray(meta.aliases) ? meta.aliases : [];
  if (aliases[0] !== expectedId) diagnostic(list, { code: 'RDL-PROJECT-005', category: 'governance', file: doc.relativeFile, artifactId: expectedId, message: 'project.md aliases의 첫 값은 프로젝트 ID여야 합니다.' });
}

// 계약 평가 결과를 진단으로 옮기는 표. 평가 자체는 계약 모듈이 하고 여기서는
// 그 결과에 코드와 심각도를 입힌다. 권장 누락만 경고로 남기는 이유는, 권장은
// 없어도 되는 것이고 강제 수준이 무엇이든 그 성질이 바뀌지 않기 때문이다.
const CONTRACT_VIOLATION_CODES = Object.freeze({
  'required-missing': 'RDL-PROFILE-002',
  'recommended-missing': 'RDL-PROFILE-003',
  'disabled-present': 'RDL-PROFILE-004'
});

function checkContractViolations(list, evaluation, context) {
  const severity = evaluation.enforcement === 'checkpoint' && context.strict ? 'error' : 'warning';
  for (const violation of evaluation.violations) {
    diagnostic(list, {
      code: CONTRACT_VIOLATION_CODES[violation.code] || 'RDL-PROFILE-009',
      category: 'profile',
      severity: violation.code === 'recommended-missing' ? 'warning' : severity,
      file: context.file, project: context.project, target: violation.type, message: violation.message
    });
  }
}

const TASK_ID_PATTERN = /^TASK-(?:[0-9A-HJKMNP-TV-Z]{8}|[A-Z0-9]{20,32})$/u;
// 완료와 반려는 둘 다 끝난 스텝이지만 게이트가 다르다. 완료는 수용조건과 검증
// 증거를, 반려는 사유와 결정자를 요구한다. 그 규칙들은 workflow.js의 카탈로그가
// 갖고, 여기 남는 것은 사람을 아는 판정 — 이 층만 아는 값이 있어야 답할 수 있는
// 것들뿐이다.
const ALLOWED_TASK_STATES = new Set(require('./vocabulary').TASK_STATES);
const REQUIRED_TASK_FIELDS = ['title', 'summary', 'owner', 'reviewers', 'stakeholders', 'status', 'priority', 'links', 'deps', 'acceptanceCriteria', 'blocker', 'createdAt', 'updatedAt', 'statusChangedAt', 'externalRefs'];

/**
 * 태스크 집합의 판정. 저장소를 읽는 일은 호출자가 끝냈고 여기서는 값만 본다.
 *
 * 종류·판정 목록과 검증 문서 추출, 구현 준비도 판정은 각자 다른 모듈이 갖고 있으므로
 * 위임으로 받는다. 여기서 직접 부르면 이 판정이 저장 계층에 묶이고, 그러면 보드가
 * 같은 판정을 부를 수 없어 자기 경로로 다시 구현하게 된다.
 */
function checkTaskEntries(list, tasks, context) {
  const { taskIds, taskFile, registry, memberIds, stakeholderIds, kinds, results, itemTypes, gates, testedDocuments, readiness, firings, flowFor } = context;
  const dependencies = new Map();

  for (const taskId of taskIds) {
    const task = tasks[taskId];
    if (!TASK_ID_PATTERN.test(taskId)) diagnostic(list, { code: 'RDL-TASK-004', category: 'task', file: taskFile, artifactId: taskId, message: `잘못된 태스크 ID입니다: ${taskId}` });
    for (const field of REQUIRED_TASK_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(task, field)) diagnostic(list, { code: 'RDL-TASK-005', category: 'task', file: taskFile, artifactId: taskId, message: `필수 태스크 필드가 없습니다: ${field}` });
    }
    if (!ALLOWED_TASK_STATES.has(task.status)) diagnostic(list, { code: 'RDL-TASK-006', category: 'task', file: taskFile, artifactId: taskId, message: `허용되지 않은 상태입니다: ${task.status}` });
    // 노드에 걸린 규칙은 판정부가 한 번에 답한다. 예전에는 여기 일곱 줄이었고
    // 같은 규칙 다섯이 저장 계층에 두 번째로 적혀 있었다. 판정은 그대로이고
    // 사는 자리만 옮겼다 — 어느 노드에 무엇이 걸리는지가 규칙 안의 목록이 아니라
    // 워크플로의 값이 되었고, 그래야 3단계가 그 값을 설정으로 받을 수 있다.
    //
    // 이름이 붙은 게이트는 여기서 내지 않는다. 유형 해석기가 게이트 표로 같은
    // 규칙을 부르므로, 두 자리가 모두 내면 한 위반이 진단 둘로 보인다.
    // 이 태스크가 탈 흐름. 넘어오지 않으면 내장이다 — 넘기지 않는 호출자를 던져서
    // 막으면 검사를 부르던 모든 자리가 함께 멈춘다.
    const flow = (flowFor && flowFor(task.kind)) || workflow;
    for (const blocker of flow.judgeItem(task, null)) {
      if (workflow.isGateRule(blocker.ruleId)) continue;
      diagnostic(list, { code: blocker.code, category: 'task', file: taskFile, artifactId: taskId, message: blocker.message });
    }
    if (task.owner && !memberIds.has(task.owner)) diagnostic(list, { code: 'RDL-TASK-010', category: 'task', file: taskFile, artifactId: taskId, target: task.owner, message: `존재하지 않는 owner입니다: ${task.owner}` });
    for (const reviewer of Array.isArray(task.reviewers) ? task.reviewers : []) if (!memberIds.has(reviewer)) diagnostic(list, { code: 'RDL-TASK-011', category: 'task', file: taskFile, artifactId: taskId, target: reviewer, message: `존재하지 않는 reviewer입니다: ${reviewer}` });
    for (const stakeholder of Array.isArray(task.stakeholders) ? task.stakeholders : []) if (!stakeholderIds.has(stakeholder)) diagnostic(list, { code: 'RDL-TASK-012', category: 'task', file: taskFile, artifactId: taskId, target: stakeholder, message: `존재하지 않는 stakeholder입니다: ${stakeholder}` });
    for (const link of Array.isArray(task.links) ? task.links : []) referenceFromTask(list, registry, taskFile, taskId, link);
    const deps = Array.isArray(task.deps) ? task.deps : [];
    dependencies.set(taskId, deps);
    for (const dependency of deps) if (!Object.prototype.hasOwnProperty.call(tasks, dependency)) diagnostic(list, { code: 'RDL-TASK-013', category: 'task', file: taskFile, artifactId: taskId, target: dependency, message: `존재하지 않는 선행 태스크입니다: ${dependency}` });
    if (task.blocker && !memberIds.has(task.blocker.waitingFor) && !stakeholderIds.has(task.blocker.waitingFor)) diagnostic(list, { code: 'RDL-TASK-016', category: 'task', file: taskFile, artifactId: taskId, target: task.blocker.waitingFor, message: `blocker 대기 대상이 존재하지 않습니다: ${task.blocker.waitingFor}` });
    if (task.cancellation && task.cancellation.decidedBy && !memberIds.has(task.cancellation.decidedBy)) diagnostic(list, { code: 'RDL-TASK-025', category: 'task', file: taskFile, artifactId: taskId, target: task.cancellation.decidedBy, message: `반려 결정자가 존재하지 않습니다: ${task.cancellation.decidedBy}` });
    const criteria = task.acceptanceCriteria && typeof task.acceptanceCriteria === 'object' ? Object.values(task.acceptanceCriteria) : [];
    if (criteria.length === 0) diagnostic(list, { code: 'RDL-TASK-017', category: 'task', file: taskFile, artifactId: taskId, message: '완료조건이 하나 이상 필요합니다.' });
    // 유형별 판정은 여기 없다. 유형이 데이터가 되면서 제약 해석기로 옮겼다 —
    // 분기 일곱이 유형마다 늘어나던 자리이고, 고칠 곳을 하나라도 빠뜨리면 그 유형만
    // 규칙 없이 통과하던 자리다.
    //
    // 판정을 태스크 하나씩 돌지 않고 다 모은 뒤 한 번에 도는 이유는 유일성 때문이다.
    // 같은 조합이 둘인지는 집합 전체를 봐야 알 수 있어 태스크 하나만 보고 답할 수 없다.
    const kind = task.kind || 'normal';
    const tested = testedDocuments(task);
    // 구현 준비도는 저장된 값이 아니라 링크에서 계산한다. 저장하면 링크가 바뀌어도
    // 갱신 경로가 없어 조용히 어긋나고, 그때 게이트는 낡은 값으로 판정한다.
    //
    // 검증 실행 태스크는 대상이 아니다. 구현하지 않고 이미 있는 시험 문서의 시나리오를
    // 밟을 뿐이라, 걸어두면 실행 기록마다 요구 문서를 끌고 다니게 된다.
    //
    // 옛 태스크에 남은 값은 읽되 보지 않는다. 지난 기록을 고쳐 쓰지 않는 것이 원칙이고,
    // 그 값으로 진단하면 이관하지 않은 저장소가 갑자기 실패한다.
    //
    // 게이트가 도는 조건은 연결된 문서가 실제로 원자 계약을 선언했는지다. 저장된
    // 필드는 그 선언의 사본이었고, 사본은 원본이 바뀌어도 따라가지 않아 어긋났다.
    // 원본을 직접 보면 그 어긋남이 생길 자리가 없다. 계약을 쓰지 않는 프로젝트는
    // 예전처럼 이 게이트의 대상이 아니다 — 쓰지 않기로 한 것을 위반으로 세지 않는다.
    const implementationReady = kind !== 'test' && (task.links || []).some((link) => /^(?:REQ|TST)-/u.test(String(link)));
    const completedNode = ((flowFor && flowFor(task.kind)) || workflow).stepOf(task.status) === 'completed';
    // 이 게이트는 유형 해석기 밖에 있다. 발화를 여기서 적지 않으면 이력에는 한 번도
    // 불리지 않은 것으로 남고, 그 침묵은 죽은 규칙과 구분되지 않는다 — 실제로 이력을
    // 처음 켰을 때 이 게이트가 죽은 규칙으로 나왔다.
    //
    // 유형이 선언한 면제도 여기서 읽는다. 게이트 표를 타는 done-requires-test-link와
    // 달리 이 게이트는 해석기 밖에서 판정하므로, 태스크가 든 면제만 보면
    // constraints.exempt에 적은 implementation-readiness가 아무 일도 하지 않는다.
    // 면제 가능 목록에 이 게이트를 넣은 이유가 "규칙을 지우지 않고 유형으로 푸는 것"인데
    // 그 길이 막혀 있었던 셈이다. 내장 test가 조용했던 것은 위의 kind !== 'test'가
    // 같은 일을 손으로 하고 있었기 때문이고, 그래서 이 구멍은 세 번째 유형이 서기
    // 전까지 드러날 수 없었다. 손으로 한 쪽은 남겨 둔다 — 지우면 test의 면제 선언을
    // 덮어쓴 프로젝트에서 검증 실행 태스크가 갑자기 요구 문서를 끌고 다닌다.
    const typeExemptions = (((itemTypes || NORMALIZED_BUILTIN)[kind] || {}).constraints || {}).exempt || [];
    const readinessExempted = exempted(task, READINESS_GATE) || typeExemptions.includes(READINESS_GATE);
    if (completedNode && implementationReady && readinessExempted && Array.isArray(firings)) {
      // 사유와 결정자는 사람이 낸 면제에만 있다. 유형이 선언한 면제는 설정이 미리
      // 면제한 것이라 결정자가 없고, 없는 것을 태스크에서 지어내면 이력이 사람의
      // 결정과 설정의 결정을 구분하지 못한다 — 해석기가 같은 자리에서 같은 규율을 쓴다.
      const byTask = exempted(task, READINESS_GATE);
      firings.push({
        target: taskId, origin: 'item-type', from: null, to: null, evaluated: [], blocked: [],
        exempted: [{
          ruleId: READINESS_GATE, gate: READINESS_GATE,
          reason: byTask ? (task.exemption.reason || null) : null,
          decidedBy: byTask ? (task.exemption.decidedBy || null) : null
        }]
      });
    }
    if (completedNode && implementationReady && !readinessExempted) {
      const linked = uniqueDocuments((task.links || []).map((link) => registry.get(String(link).split('#')[0])).filter(Boolean));
      const declaresAtomic = linked.some((doc) => doc.frontmatter && doc.frontmatter.data && doc.frontmatter.data.implementationContract === 'atomic-v1');
      const mark = list.length;
      for (const issue of (declaresAtomic ? readiness(linked) : [])) diagnostic(list, {
        code: issue.code, category: 'implementation', severity: issue.severity, file: taskFile,
        artifactId: taskId, target: issue.target || issue.artifactId || null, message: issue.message
      });
      if (Array.isArray(firings)) firings.push({
        target: taskId, origin: 'item-type', from: null, to: null,
        evaluated: [READINESS_GATE],
        blocked: list.slice(mark).map((item) => ({
          ruleId: READINESS_GATE, code: item.code, origin: 'item-type',
          source: null, method: null, target: item.target || taskId, message: item.message
        })),
        exempted: []
      });
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(id, trail) {
    if (visiting.has(id)) {
      diagnostic(list, { code: 'RDL-TASK-021', category: 'task', file: taskFile, artifactId: id, target: id, message: `태스크 의존성 순환이 있습니다: ${trail.concat(id).join(' -> ')}` });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) || []) if (dependencies.has(dependency)) visit(dependency, trail.concat(id));
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of taskIds) visit(id, []);
  // 유형 제약은 집합을 다 모은 뒤에 판정한다. 해석기가 값만 받고 파일을 읽지 않으므로
  // 검사기의 순수성이 유지되며, 유형이 늘어도 이 호출 하나는 그대로다.
  const itemTasks = {};
  for (const id of taskIds) itemTasks[id] = tasks[id];
  // 게이트 표도 흐름을 탄다. 유형별로 흐름이 갈릴 수 있으므로 유형마다 표를 만든다 —
  // 한 번 만들어 두면 첫 태스크의 흐름이 나머지 유형에까지 걸린다.
  const gateTable = gates || (flowFor
    ? taskGatesFor(flowFor(itemTasks[0] && itemTasks[0].kind))
    : DEFAULT_TASK_GATES);
  for (const issue of evaluateItemTypes(itemTasks, itemTypes || NORMALIZED_BUILTIN, { gates: gateTable, firings })) {
    diagnostic(list, Object.assign({ category: 'task', file: taskFile }, issue));
  }
  // 태스크가 든 면제는 게이트 함수 안에서 걸러진다. 해석기가 보기에는 게이트가 돌고
  // 아무것도 안 낸 것과 같아, 그대로 두면 면제로 조용해진 게이트가 "다들 지키는
  // 규칙"으로 집계된다. 판정하지 않은 것을 판정했다고 세지 않으려면 여기서 옮겨야
  // 한다 — 사유와 결정자를 아는 것도 이 층이다.
  if (Array.isArray(firings)) {
    for (const firing of firings) {
      const task = tasks[firing.target];
      const gateNames = exemptionGates(task && task.exemption);
      if (!gateNames.length) continue;
      for (const gate of gateNames) {
        const at = firing.evaluated.indexOf(gate);
        if (at < 0) continue;
        firing.evaluated.splice(at, 1);
        firing.exempted.push({ ruleId: gate, gate, reason: task.exemption.reason || null, decidedBy: task.exemption.decidedBy || null });
      }
    }
  }
  return taskIds.length;
}

function referenceFromTask(list, registry, taskFile, taskId, value) {
  const parts = String(value).split('#');
  const targetDoc = resolveArtifact(registry, parts[0]);
  if (!targetDoc) {
    diagnostic(list, { code: 'RDL-TASK-008', category: 'task', file: taskFile, line: 1, artifactId: taskId, target: parts[0], message: `태스크가 존재하지 않는 Artifact를 참조합니다: ${value}` });
  } else if (parts[1] && !targetDoc.headings.has(headingKey(parts.slice(1).join('#')))) {
    diagnostic(list, { code: 'RDL-TASK-009', category: 'task', file: taskFile, line: 1, artifactId: taskId, target: value, message: `태스크가 존재하지 않는 문서 섹션을 참조합니다: ${value}` });
  }
}

// FILE_PATTERN, TASK_ID_PATTERN, REQUIRED_TASK_FIELDS는 내보내지 않는다. 이 안의
// 판정만 쓰는 값이고, 내보내면 밖에서 같은 규칙을 다시 구현할 길이 열린다 — 판정을
// 한 곳에 모은 이유가 그것이었다.
module.exports = {
  GOVERNANCE_HEADINGS, GOVERNANCE_BLOCK_FIELDS, REQUIRED_FIELDS, ID_PATTERN,
  NON_CANONICAL_CODES, REQUIRED_TAG_NAMESPACES, NOTE_TAG_NAMESPACES,
  headingKey, wikiTarget, lineOf, diagnostic, resolveArtifact, uniqueDocuments, isDocumentUid,
  ALLOWED_TASK_STATES, CONTRACT_VIOLATION_CODES, DEFAULT_TASK_GATES,
  MAX_ASSET_BYTES, MAX_ASSET_EDGE, isAssetPath, maskCode,
  governanceBlocks, checkProjectGovernance, checkDocumentMetadata, checkCharterMetadata, checkStateVocabulary,
  checkContractViolations, checkTaskEntries, checkReference, referenceFromTask,
  checkAssetReference, checkAssetInventory,
  UPSTREAM_TRUST_CODES, upstreamTypes, documentLayer, documentTypeCode, relatedTargetId, upstreamTrustIssues, checkFunctionParents
};
