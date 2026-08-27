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
    if (completedNode && implementationReady && exempted(task, 'implementation-readiness') && Array.isArray(firings)) {
      firings.push({
        target: taskId, origin: 'item-type', from: null, to: null, evaluated: [], blocked: [],
        exempted: [{ ruleId: READINESS_GATE, gate: READINESS_GATE, reason: task.exemption.reason || null, decidedBy: task.exemption.decidedBy || null }]
      });
    }
    if (completedNode && implementationReady && !exempted(task, 'implementation-readiness')) {
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
  governanceBlocks, checkProjectGovernance, checkDocumentMetadata, checkCharterMetadata,
  checkContractViolations, checkTaskEntries, checkReference, referenceFromTask,
  checkAssetReference, checkAssetInventory
};
