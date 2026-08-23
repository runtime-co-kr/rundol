'use strict';

const fs = require('fs');
const path = require('path');
const { readTaskStore, exemptionGates } = require('./tasks');
const { parseFrontmatter } = require('./frontmatter');
const { validateDocumentProfile } = require('./document-profile');
const { evaluateDocumentContract, projectArtifacts } = require('./document-contract');
const { loadBoardPresentation, resolveProfilePresets } = require('./board-presentation');
const { validateBoundaryMetadata } = require('./document-boundary');
const { validateDocumentDiagram } = require('./document-diagram');
const { validateTestDocument } = require('./test-contract');
const { TASK_KINDS, TEST_RESULTS, testedDocuments } = require('./tasks');
const { BUILTIN_ITEM_TYPES, normalizeItemTypes } = require('./item-type');

// 표 셀 안의 위키링크는 별칭 구분자를 `\|`로 적어야 한다. GFM이 표를 셀로 먼저
// 쪼개므로, escape하지 않은 `|`는 링크 문법에 닿기도 전에 셀 경계가 되기 때문이다.
// 그 escape를 링크 파서가 모르면 대상 이름 끝에 백슬래시가 붙어 "해결되지 않은
// 링크"가 된다. 즉 GFM대로 옳게 쓴 문서가 검사에서 틀린 것이 된다.
function unescapePipe(value) {
  return String(value).replace(/\\\|/gu, '|');
}

// 내장 정의도 파일 정의와 같은 정규화를 지난다. 건너뛰면 내장에만 있는 형태 오류가
// 영원히 잡히지 않고, 판정 경로가 둘로 갈린다. 값이 바뀌지 않으므로 한 번만 돈다.
const NORMALIZED_BUILTIN_ITEM_TYPES = normalizeItemTypes(BUILTIN_ITEM_TYPES);

// 유형 정의는 정책 층에서 온다. 설정을 읽지 못하는 상황 — 프로젝트가 없거나 파일이
// 깨졌거나 — 에서는 내장으로 떨어진다. 여기서 던지면 설정 하나 때문에 검사 전체가
// 멈추고, 그러면 사람은 무엇이 잘못됐는지 보기도 전에 도구를 잃는다.
//
// 정규화를 여기서 한 번 더 도는 이유는 병합 결과가 파일에서 온 값을 담기 때문이다.
// 읽는 시점에 이미 한 번 걸렀지만, 병합이 계층을 겹치면서 만든 조합은 그때 보지 못한
// 것이다 — 각 계층이 옳아도 합친 것이 옳다는 보장은 없다.
function resolveItemTypes(root, projectKey) {
  if (!projectKey) return NORMALIZED_BUILTIN_ITEM_TYPES;
  try {
    const presentation = loadBoardPresentation(root, projectKey);
    if (!presentation || !presentation.itemTypes) return NORMALIZED_BUILTIN_ITEM_TYPES;
    return normalizeItemTypes(presentation.itemTypes);
  } catch (error) {
    return NORMALIZED_BUILTIN_ITEM_TYPES;
  }
}
const { COMPOSITE_DIRECTORY, prepareCompositeDocuments, compositeIssues, compositeDrift } = require('./document-composite');
const { isIndexArtifact, validateImplementationDocument, validateImplementationTrace, validateTaskImplementationReadiness, implementationTrace } = require('./implementation-contract');
const { runGit } = require('./git');
const { readCommitBindings } = require('./task-commits');
const { currentBranch } = require('./branch-boundary');
const { normalizeVerdictEvent, verdictEnvelope } = require('./verify');
const { createEventEnvelope: createRunEnvelope, normalizeRunEvent } = require('./run-ledger');
const { normalizeDriverEvent, driverEnvelope } = require('./driver-lease');
const { normalizeDecisionEvent, decisionEnvelope } = require('./decision');
const { normalizeDelegationEvent, delegationEnvelope } = require('./delegation');
const { normalizeApprovalEvent, approvalEnvelope } = require('./approval');
const { duplicateUids } = require('./document-identity');
const workspaceApi = require('./workspace');
const { workspaceLayout, listProjects } = workspaceApi;
// 판정부는 값만 보고 답한다. 여기서 읽고, 저기서 판정한다 — 그래야 보드와 워커
// 어댑터가 같은 판정 함수를 부를 수 있다.
const {
  GOVERNANCE_HEADINGS, GOVERNANCE_BLOCK_FIELDS,
  headingKey, wikiTarget, lineOf, diagnostic, resolveArtifact, uniqueDocuments, ID_PATTERN, REQUIRED_FIELDS,
  checkDocumentMetadata, checkCharterMetadata, checkContractViolations, checkTaskEntries,
  governanceBlocks, checkProjectGovernance, checkReference, referenceFromTask,
  isAssetPath, maskCode, checkAssetReference, checkAssetInventory,
  DEFAULT_TASK_GATES,
} = require('./check-rules');
const { imageSize } = require('./image-header');

// 자산 디렉터리를 읽어 값으로 만든다. 바이트를 읽는 일은 여기까지고, 그 값을
// 보고 옳고 그름을 말하는 일은 판정부가 한다.
//
// 차원을 재려고 이미지를 디코딩하지 않는다 — 헤더 앞부분만 읽으면 네 형식 모두
// 나오므로, 5MB 그림이 100장 있어도 읽는 것은 100 × 4KB다.
const ASSET_HEADER_BYTES = 4096;

function readAssets(documentsRoot, root) {
  const assetsRoot = path.join(documentsRoot, 'assets');
  const assets = new Map();
  if (!fs.existsSync(assetsRoot)) return assets;
  const walk = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(target, name); continue; }
      if (!entry.isFile()) continue;
      let bytes = 0;
      let head = Buffer.alloc(0);
      try {
        bytes = fs.statSync(target).size;
        const handle = fs.openSync(target, 'r');
        try {
          const buffer = Buffer.alloc(Math.min(ASSET_HEADER_BYTES, bytes));
          fs.readSync(handle, buffer, 0, buffer.length, 0);
          head = buffer;
        } finally { fs.closeSync(handle); }
      } catch (error) { head = Buffer.alloc(0); }
      const size = imageSize(head) || {};
      assets.set(name, {
        name,
        relativeFile: relative(root, target),
        bytes,
        format: size.format || null,
        width: size.width || null,
        height: size.height || null
      });
    }
  };
  walk(assetsRoot, '');
  return assets;
}

// 태스크 식별자 규칙과 허용 상태는 판정 계층으로 옮겼다. 새 식별자는 문서와 같은
// 8자 규칙이고 옛 26자 식별자도 계속 읽는다 — 지난 기록을 고쳐 쓰지 않는 것이
// 원칙이므로 이관 전 저장소도 그대로 동작해야 한다.
// 폐지된 유형과 이름만 바뀐 유형은 다르다. 폐지는 사람이 내용을 나눠 옮겨야 하므로
// strict에서 막고, 이름 변경은 `rdl doc migrate`가 자동으로 옮기므로 막지 않는다.
// 자동 경로가 있는데도 막으면, 버전을 올린 것만으로 기존 프로젝트가 멈춘다.
const LEGACY_DOCUMENT_CODES = new Map([
  ['SPC', { hint: 'REQ 또는 관점별 설계문서로 이전하세요.', blocking: true }],
  ['API', { hint: '`rdl doc migrate --apply`가 IFC로 옮깁니다. 유형 이름만 바뀌었습니다.', blocking: false }]
]);

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

const WORKSPACE_MANIFEST = 'workspace.yaml';

function workspaceManifestPath(root) {
  return workspaceApi.manifestPath(root);
}

function findWorkspaceRoot(start) {
  return workspaceApi.findWorkspaceRoot(start);
}

function readWorkspaceManifest(root) {
  return workspaceApi.readWorkspaceManifest(root);
}

function yamlNestedValue(source, section, key) {
  const sectionMatch = new RegExp(`(?:^|\\n)${section}:\\s*\\n([\\s\\S]*?)(?=\\n[^ \\n][^\\n]*:|$)`).exec(source);
  if (!sectionMatch) return null;
  const keyMatch = new RegExp(`^\\s{2}${key}:\\s*(.+)$`, 'm').exec(sectionMatch[1]);
  return keyMatch ? keyMatch[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

function listMarkdownFiles(root) {
  const result = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      // 생성 디렉터리는 프로젝트 루트에만 있다. 이름만으로 어느 깊이에서나 건너뛰면
      // docs/views/ 같은 정상 문서 폴더가 조용히 검사에서 빠진다.
      if (entry.name === COMPOSITE_DIRECTORY && path.resolve(directory) === path.resolve(root)) continue;
      if (entry.name === 'templates' || entry.name.startsWith('.')) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'INDEX.md') result.push(full);
    }
  }
  if (fs.existsSync(root)) visit(root);
  return result.sort();
}

function listVaultMarkdownFiles(root) {
  const result = [];
  const excluded = new Set(['.git', '.obsidian', '.rundol', 'node_modules', '.npm-cache', 'templates']);
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === COMPOSITE_DIRECTORY && path.resolve(directory) === path.resolve(root)) continue;
      if (excluded.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) result.push(full);
    }
  }
  visit(root);
  return result.sort();
}

function inspectMarkdown(file, root) {
  const source = fs.readFileSync(file, 'utf8');
  const frontmatter = parseFrontmatter(source);
  const headings = new Set();
  const blocks = new Set();
  const body = frontmatter ? frontmatter.body : source;
  const bodyStartLine = frontmatter ? frontmatter.bodyStartLine : 1;
  body.split(/\r?\n/).forEach((line) => {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) headings.add(headingKey(heading[1].replace(/\s+\^[A-Za-z]+-[A-Z0-9]+\s*$/, '')));
    for (const block of line.matchAll(/\^([A-Z]+-[A-Z0-9]+)/g)) blocks.add(block[1]);
  });
  return { file, fileStem: path.basename(file, '.md'), relativeFile: relative(root, file), source, frontmatter, body, bodyStartLine, headings, blocks };
}

function checkTasks(list, root, taskPath, registry, memberIds, stakeholderIds, projectKey, firings) {
  if (!taskPath || !fs.existsSync(taskPath)) {
    diagnostic(list, { code: 'RDL-TASK-001', category: 'task', file: taskPath ? relative(root, taskPath) : null, message: '태스크 원본 또는 로컬 projection을 찾지 못했습니다.' });
    return 0;
  }
  const taskFile = relative(root, taskPath);
  let parsed;
  try {
    parsed = readTaskStore(taskPath);
  } catch (error) {
    diagnostic(list, { code: 'RDL-TASK-002', category: 'task', file: taskFile, message: `tasks.json을 파싱할 수 없습니다: ${error.message}` });
    return 0;
  }
  if (!parsed.tasks || typeof parsed.tasks !== 'object' || Array.isArray(parsed.tasks)) {
    diagnostic(list, { code: 'RDL-TASK-003', category: 'task', file: taskFile, message: 'tasks는 ID를 key로 가진 객체여야 합니다.' });
    return 0;
  }
  const taskIds = Object.keys(parsed.tasks).filter((taskId) => !projectKey || parsed.tasks[taskId].project === projectKey);
  // 기능별로 어느 문서가 덮는지는 이미 계산되는 값이다. 준비도 판정이 "REQ가 없다"에서
  // 멈추면 사람은 어느 REQ를 붙여야 하는지 다시 조사해야 하고, 실측에서 태스크 하나를
  // 닫는 데 드는 왕복의 상당수가 그 조사였다.
  const coverage = {};
  for (const entry of implementationTrace(uniqueDocuments(Array.from(registry.values()))).entries) {
    coverage[entry.functionId] = entry.artifacts;
  }
  // 읽기는 여기서 끝났다. 아래 판정은 값만 본다 — 종류·판정 목록과 검증 문서 추출,
  // 구현 준비도 판정은 각자 다른 모듈이 갖고 있으므로 위임으로 넘긴다.
  return checkTaskEntries(list, parsed.tasks, {
    taskIds, taskFile, registry, memberIds, stakeholderIds, firings,
    kinds: TASK_KINDS, results: TEST_RESULTS, testedDocuments,
    // 유형 정의는 정책 층에서 온다. 이제 board.json에 유형을 적으면 코드를 고치지
    // 않고도 새 유형이 판정을 받는다.
    itemTypes: resolveItemTypes(root, projectKey),
    // 면제는 게이트 이름으로 판정한다. 게이트는 함수이며 해석기가 면제 목록에 없는
    // 것만 부른다 — 판정하고 결과를 감추는 것이 아니라 판정 자체를 돌지 않는다.
    //
    // 완료 태스크에 검증 문서 연결을 요구하는 규칙이 여기로 옮겨 왔다. 전역이던 시절에는
    // 결정 문서만 저작한 태스크가 수용조건을 다 채우고도 완료되지 못했다 — 결정 저작에는
    // 검증 문서가 없기 때문이다. 이제 그 유형이 면제를 선언하면 규칙을 지우지 않고 풀린다.
    // 게이트 판정은 check-rules가 소유한다. 같은 규칙을 여기 다시 적었던 탓에 면제를
    // 한쪽에만 넣고도 통과한 줄 알았던 일이 있었다 — 규칙이 두 곳에 있으면 둘은 갈린다.
    gates: DEFAULT_TASK_GATES,
    readiness: (linked) => validateTaskImplementationReadiness(linked, { coverage })
  });
}

function checkObsidian(list, root, hasTaggedDocuments) {
  const branchSettings = path.join(root, '.rundol', 'settings', 'obsidian');
  const managedSettings = fs.existsSync(branchSettings) ? branchSettings : path.join(root, '.rundol', 'obsidian');
  const localSettings = path.join(root, '.obsidian');
  const settingsDir = fs.existsSync(managedSettings) ? managedSettings : localSettings;
  const settingsLabel = relative(root, settingsDir);
  if (!fs.existsSync(settingsDir)) {
    diagnostic(list, { code: 'RDL-OBS-001', category: 'obsidian', severity: 'warning', message: 'Rundol settings의 팀 공통 Obsidian 설정 디렉터리가 없습니다.' });
    return;
  }
  const settings = {};
  for (const entry of fs.readdirSync(settingsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(settingsDir, entry.name);
    try {
      settings[entry.name] = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      diagnostic(list, { code: 'RDL-OBS-002', category: 'obsidian', file: relative(root, file), message: `Obsidian 설정 JSON을 파싱할 수 없습니다: ${error.message}` });
    }
  }
  const app = settings['app.json'] || {};
  for (const item of [
    ['newFileFolderPath', 'RDL-OBS-003', '신규 문서 폴더'],
    ['attachmentFolderPath', 'RDL-OBS-004', '첨부파일 폴더']
  ]) {
    if (app[item[0]] && !fs.existsSync(path.resolve(root, app[item[0]]))) diagnostic(list, { code: item[1], category: 'obsidian', severity: 'warning', file: `${settingsLabel}/app.json`, message: `${item[2]}가 존재하지 않습니다: ${app[item[0]]}` });
  }
  const plugins = settings['core-plugins.json'] || {};
  if (hasTaggedDocuments && plugins['tag-pane'] !== true) diagnostic(list, { code: 'RDL-OBS-005', category: 'obsidian', severity: 'warning', file: `${settingsLabel}/core-plugins.json`, message: '태그를 사용하는 Vault에서 tag-pane core plugin이 활성화되어야 합니다.' });
  if (plugins.templates === true) {
    const templateSettings = settings['templates.json'];
    if (!templateSettings || !templateSettings.folder) diagnostic(list, { code: 'RDL-OBS-006', category: 'obsidian', severity: 'warning', file: `${settingsLabel}/templates.json`, message: 'Templates core plugin의 폴더 설정이 없습니다.' });
    else if (!fs.existsSync(path.resolve(root, templateSettings.folder))) diagnostic(list, { code: 'RDL-OBS-007', category: 'obsidian', severity: 'warning', file: `${settingsLabel}/templates.json`, message: `Templates 폴더가 존재하지 않습니다: ${templateSettings.folder}` });
  }
  const graph = settings['graph.json'] || {};
  if (hasTaggedDocuments && graph.showTags !== true) diagnostic(list, { code: 'RDL-OBS-008', category: 'obsidian', severity: 'warning', file: `${settingsLabel}/graph.json`, message: 'Graph view의 태그 표시가 비활성화되어 있습니다.' });
}

function checkLegacyWorkspace(start, options, scope) {
  const startedAt = Date.now();
  const root = findWorkspaceRoot(start);
  const manifest = readWorkspaceManifest(root);
  const documentsRoot = scope ? scope.root : path.resolve(root, yamlNestedValue(manifest.source, 'documents', 'root') || 'docs');
  const canonicalTaskPath = scope ? (scope.tasks || workspaceLayout(root).tasks) : path.resolve(root, yamlNestedValue(manifest.source, 'tasks', 'path') || 'tasks.json');
  const projectionValue = yamlNestedValue(manifest.source, 'tasks', 'projection');
  const projectionPath = projectionValue ? path.resolve(root, projectionValue) : null;
  const taskPath = scope ? canonicalTaskPath : projectionPath && fs.existsSync(projectionPath) ? projectionPath : canonicalTaskPath;
  const diagnostics = [];
  const vaultDocuments = (scope ? listMarkdownFiles(scope.root) : listVaultMarkdownFiles(root)).map((file) => inspectMarkdown(file, root));
  const vaultByPath = new Map(vaultDocuments.map((doc) => [path.resolve(doc.file), doc]));
  const documents = listMarkdownFiles(documentsRoot)
    .filter((file) => !scope || path.resolve(file) !== path.resolve(scope.charter))
    .map((file) => vaultByPath.get(path.resolve(file)) || inspectMarkdown(file, root));
  const registry = new Map();
  const fileRegistry = new Map();
  const canonicalDocuments = [];
  // 자산은 문서 뿌리 아래가 아니라 문서 디렉터리 아래에 있다. 프로젝트 범위에서
  // documentsRoot는 프로젝트 뿌리라서 여기에 그대로 쓰면 자산 디렉터리를 못 찾고,
  // 못 찾으면 진단이 조용히 아무것도 말하지 않는다.
  const assets = readAssets((scope && scope.documents) || documentsRoot, root);
  // 어느 자산이 실제로 쓰이는지는 문서를 다 훑어야 안다. 훑으면서 모아 두고
  // 마지막에 한 번 판정한다 — 문서마다 판정하면 아직 안 본 문서가 참조하는
  // 자산을 고아라고 말하게 된다.
  const referencedAssets = new Set();

  for (const vaultDoc of vaultDocuments) {
    if (fileRegistry.has(vaultDoc.fileStem)) diagnostic(diagnostics, { code: 'RDL-DOC-010', category: 'link', file: vaultDoc.relativeFile, target: vaultDoc.fileStem, message: `Obsidian에서 모호한 중복 파일명입니다: ${vaultDoc.fileStem}` });
    else fileRegistry.set(vaultDoc.fileStem, vaultDoc);
  }

  // 읽기는 여기서 끝났다. 아래 판정은 값만 본다 — 파일 이름도 값으로 넘긴다.
  const delegates = {
    boundary: (meta) => validateBoundaryMetadata(meta),
    implementation: (doc) => validateImplementationDocument(doc, options)
  };
  for (const doc of documents) {
    const artifactId = checkDocumentMetadata(diagnostics, doc, path.basename(doc.file), delegates);
    if (!doc.frontmatter) continue;
    doc.id = artifactId;
    canonicalDocuments.push(doc);
    const aliases = Array.isArray(doc.frontmatter.data.aliases) ? doc.frontmatter.data.aliases : [];
    if (artifactId) {
      for (const alias of [artifactId].concat(aliases)) {
        if (registry.has(alias) && registry.get(alias) !== doc) diagnostic(diagnostics, { code: 'RDL-DOC-009', file: doc.relativeFile, artifactId, target: alias, message: `중복 ID 또는 alias입니다: ${alias}` });
        else registry.set(alias, doc);
      }
    }
  }

  const projectDoc = scope ? vaultByPath.get(path.resolve(scope.charter)) : canonicalDocuments.find((doc) => doc.id && doc.id.startsWith('PRJ-'));
  if (scope && projectDoc && projectDoc.frontmatter) projectDoc.id = projectDoc.frontmatter.data.id;
  const memberIds = new Set(projectDoc ? Array.from(projectDoc.blocks).filter((id) => id.startsWith('MEMBER-')) : []);
  const stakeholderIds = new Set(projectDoc ? Array.from(projectDoc.blocks).filter((id) => id.startsWith('STAKEHOLDER-')) : []);
  if (!projectDoc) diagnostic(diagnostics, { code: 'RDL-META-001', message: 'PRJ 문서를 찾지 못했습니다.' });
  checkProjectGovernance(diagnostics, projectDoc);
  // 같은 식별자를 가진 문서가 둘이면 조인이 갈린다. 확률은 낮지만 조용한 손상
  // 대신 두 문서를 모두 지목한다 — 짧은 식별자를 쓰는 대가는 이 진단으로 치른다.
  for (const duplicate of duplicateUids(canonicalDocuments.filter((doc) => doc.id).map((doc) => ({ id: doc.id, uid: doc.frontmatter.data.uid })))) {
    for (const document of canonicalDocuments.filter((doc) => duplicate.ids.includes(doc.id))) {
      diagnostic(diagnostics, { code: 'RDL-DOC-016', file: document.relativeFile, artifactId: document.id, target: duplicate.uid, message: `문서 고유 식별자가 중복됩니다: ${duplicate.uid} (${duplicate.ids.join(', ')})` });
    }
  }

  for (const doc of canonicalDocuments) {
    const meta = doc.frontmatter.data;
    for (const value of Array.isArray(meta.related) ? meta.related : []) checkReference(diagnostics, fileRegistry, registry, doc, value, { category: 'link', artifactId: doc.id });
    for (const field of ['owner', 'reviewers', 'stakeholders']) {
      const values = Array.isArray(meta[field]) ? meta[field] : meta[field] ? [meta[field]] : [];
      for (const value of values) {
        checkReference(diagnostics, fileRegistry, registry, doc, value, { category: 'metadata', artifactId: doc.id });
        const target = wikiTarget(value);
        if (target && target.anchor && target.anchor.startsWith('^')) {
          const block = target.anchor.slice(1);
          const expected = field === 'stakeholders' ? 'STAKEHOLDER-' : 'MEMBER-';
          if (!block.startsWith(expected)) diagnostic(diagnostics, { code: 'RDL-META-002', category: 'metadata', file: doc.relativeFile, line: lineOf(doc.source, value), artifactId: doc.id, target: block, message: `${field}는 ${expected} block을 참조해야 합니다.` });
        }
      }
    }
    // 이스케이프된 링크는 링크가 아니다. 그리고 아무도 그것을 손으로 적지 않는다.
    //
    // Markdown을 AST로 읽고 다시 쓰는 도구는 `[[`를 링크로 오해될 수 있는 글자로
    // 보고 `\[\[`로 이스케이프한다. 그 순간 링크는 깨지는 것이 아니라 없는 것이 되고,
    // 링크 규칙은 없는 것을 검사하지 않는다. 실측에서 정본 문서의 본문 링크가 그렇게
    // 사라졌는데 검사는 오류 0으로 통과했다.
    //
    // 그래서 사라진 링크가 아니라 그 흔적을 센다. 흔적은 남는다.
    for (const match of maskCode(doc.body).matchAll(/\\\[\\\[([^\]]+)\]\]/g)) {
      const line = doc.bodyStartLine + doc.body.slice(0, match.index).split(/\r?\n/).length - 1;
      diagnostic(diagnostics, {
        code: 'RDL-LINK-007', category: 'link', severity: options.strict ? 'error' : 'warning',
        file: doc.relativeFile, line, artifactId: doc.id, target: match[1],
        message: `이스케이프된 Wiki link가 있습니다: \\[\\[${match[1]}]]. 편집 도구가 대괄호를 이스케이프하면 링크가 끊긴 것이 아니라 없는 것이 되어 다른 검사가 보지 못합니다.`
      });
    }
    // `!`가 앞에 붙으면 embed다. Obsidian에서 `[[REQ-001]]`은 문서를 가리키고
    // `![[diagram.png]]`는 자산을 끼워 넣는다. 둘을 같은 규칙으로 보면 이미지를
    // 넣는 순간 "해결되지 않은 문서 참조"가 되어 정본에 그림을 못 넣는다.
    for (const match of maskCode(doc.body).matchAll(/(!?)\[\[([^\]]+)\]\]/g)) {
      const raw = `[[${unescapePipe(match[2])}]]`;
      const target = wikiTarget(raw);
      if (!target || target.id === 'tasks.json') continue;
      const line = doc.bodyStartLine + doc.body.slice(0, match.index).split(/\r?\n/).length - 1;
      if (match[1] === '!' && isAssetPath(target.id)) {
        referencedAssets.add(target.id);
        checkAssetReference(diagnostics, { assets, target: target.id, sourceDoc: doc, artifactId: doc.id, line, strict: options.strict });
        continue;
      }
      const targetDoc = fileRegistry.get(target.id) || null;
      if (!targetDoc) {
        const aliasDoc = resolveArtifact(registry, target.id);
        diagnostic(diagnostics, { code: aliasDoc ? 'RDL-LINK-006' : 'RDL-LINK-004', category: 'link', severity: options.strict ? 'error' : 'warning', file: doc.relativeFile, line, artifactId: doc.id, target: target.id, message: aliasDoc ? `본문 Wiki link는 실제 파일명을 대상으로 해야 합니다: [[${aliasDoc.fileStem}|${target.id}]]` : `본문에 해결되지 않은 Wiki link가 있습니다: ${target.id}` });
      }
      else if (target.anchor) {
        const exists = target.anchor.startsWith('^') ? targetDoc.blocks.has(target.anchor.slice(1)) : targetDoc.headings.has(headingKey(target.anchor));
        if (!exists) diagnostic(diagnostics, { code: 'RDL-LINK-005', category: 'link', severity: options.strict ? 'error' : 'warning', file: doc.relativeFile, line: doc.bodyStartLine + doc.body.slice(0, match.index).split(/\r?\n/).length - 1, artifactId: doc.id, target: `${target.id}#${target.anchor}`, message: `본문에 해결되지 않은 section link가 있습니다: ${target.id}#${target.anchor}` });
      }
    }
    const relatedIds = (Array.isArray(meta.related) ? meta.related : []).map(wikiTarget).filter(Boolean).map((target) => fileRegistry.get(target.id)).filter(Boolean).map((targetDoc) => targetDoc.id.slice(0, 3));
    const requirements = { SCR: ['REQ'], MOD: ['REQ', 'ARC'], IFC: ['REQ', 'ARC'], TST: ['REQ'], RUN: ['ARC', 'REQ'] };
    const code = doc.id ? doc.id.slice(0, 3) : '';
    if (LEGACY_DOCUMENT_CODES.has(code)) diagnostic(diagnostics, {
      code: 'RDL-DOC-010',
      category: 'metadata',
      severity: options.strict && LEGACY_DOCUMENT_CODES.get(code).blocking ? 'error' : 'warning',
      file: doc.relativeFile,
      artifactId: doc.id,
      message: `${code} 문서 유형은 더 이상 사용하지 않습니다. ${LEGACY_DOCUMENT_CODES.get(code).hint}`
    });
    if (requirements[code] && !requirements[code].some((required) => relatedIds.includes(required))) diagnostic(diagnostics, { code: 'RDL-META-003', category: 'metadata', file: doc.relativeFile, artifactId: doc.id, message: `${code} 문서는 ${requirements[code].join(' 또는 ')} 관계가 필요합니다.` });
    for (const issue of validateDocumentDiagram(code, doc.source, doc.id)) diagnostic(diagnostics, {
      code: issue.code,
      category: 'diagram',
      severity: 'warning',
      file: doc.relativeFile,
      artifactId: doc.id,
      target: issue.target || null,
      message: issue.message
    });
    for (const issue of validateTestDocument(code, doc.source, doc.id, options)) diagnostic(diagnostics, {
      code: issue.code,
      category: 'test',
      severity: issue.severity,
      file: doc.relativeFile,
      artifactId: doc.id,
      target: issue.target || null,
      message: issue.message
    });
  }

  const implementation = validateImplementationTrace(canonicalDocuments.filter((doc) => doc.id && ID_PATTERN.test(doc.id)).map((doc) => ({
    id: doc.id,
    type: doc.id.slice(0, 3),
    file: doc.file,
    source: doc.source
  })), options);
  for (const issue of implementation.issues) diagnostic(diagnostics, {
    code: issue.code,
    category: 'implementation',
    severity: issue.severity,
    file: null,
    artifactId: issue.artifactId || null,
    target: issue.target || null,
    message: issue.message
  });

  const canonicalPaths = new Set(canonicalDocuments.map((doc) => path.resolve(doc.file)));
  for (const doc of vaultDocuments) {
    if (canonicalPaths.has(path.resolve(doc.file))) continue;
    const artifactId = doc.frontmatter && typeof doc.frontmatter.data.id === 'string' ? doc.frontmatter.data.id : null;
    if (isIndexArtifact(doc.frontmatter && doc.frontmatter.data.title, doc.file)) diagnostic(diagnostics, {
      code: 'RDL-IMPL-010',
      category: 'implementation',
      file: doc.relativeFile,
      artifactId,
      message: '별도 인덱스·목록·추적표 문서는 만들지 않습니다. 직접 링크와 rdl contract trace를 사용하세요.'
    });
    if (path.basename(doc.file).toLowerCase() === 'design.md') diagnostic(diagnostics, {
      code: 'RDL-DOC-011',
      category: 'metadata',
      severity: 'warning',
      file: doc.relativeFile,
      artifactId,
      message: 'DESIGN.md는 Rundol 정본이 아닙니다. 내용을 REQ, SCR, ARC, ADR 또는 연결된 태스크로 이전하세요. 필요한 유형이 사용 안 함이면 계약에서 상태를 먼저 바꾸세요.'
    });
    // 정본 경로와 같은 규칙을 쓴다. 여기서만 embed를 문서 참조로 보면 같은 문서가
    // 어느 경로로 검사되었는지에 따라 다른 답을 받는다.
    for (const match of maskCode(doc.body).matchAll(/(!?)\[\[([^\]]+)\]\]/g)) {
      const raw = `[[${unescapePipe(match[2])}]]`;
      const target = wikiTarget(raw);
      if (!target || target.id === 'tasks.json') continue;
      const line = doc.bodyStartLine + doc.body.slice(0, match.index).split(/\r?\n/).length - 1;
      if (match[1] === '!' && isAssetPath(target.id)) {
        referencedAssets.add(target.id);
        checkAssetReference(diagnostics, { assets, target: target.id, sourceDoc: doc, artifactId, line, strict: options.strict });
        continue;
      }
      const targetDoc = fileRegistry.get(target.id) || null;
      if (!targetDoc) {
        const aliasDoc = resolveArtifact(registry, target.id);
        diagnostic(diagnostics, { code: aliasDoc ? 'RDL-LINK-006' : 'RDL-LINK-004', category: 'link', severity: options.strict ? 'error' : 'warning', file: doc.relativeFile, line, artifactId, target: target.id, message: aliasDoc ? `Vault Wiki link는 실제 파일명을 대상으로 해야 합니다: [[${aliasDoc.fileStem}|${target.id}]]` : `Vault에 해결되지 않은 Wiki link가 있습니다: ${target.id}` });
      } else if (target.anchor) {
        const exists = target.anchor.startsWith('^') ? targetDoc.blocks.has(target.anchor.slice(1)) : targetDoc.headings.has(headingKey(target.anchor));
        if (!exists) diagnostic(diagnostics, { code: 'RDL-LINK-005', category: 'link', severity: options.strict ? 'error' : 'warning', file: doc.relativeFile, line: doc.bodyStartLine + doc.body.slice(0, match.index).split(/\r?\n/).length - 1, artifactId, target: `${target.id}#${target.anchor}`, message: `Vault에 해결되지 않은 section link가 있습니다: ${target.id}#${target.anchor}` });
      }
    }
  }

  // 문서를 다 훑은 뒤에 판정한다. 문서마다 판정하면 아직 안 본 문서가 참조하는
  // 자산을 고아라고 말하게 된다.
  checkAssetInventory(diagnostics, { assets, referenced: referencedAssets });

  const taskCount = checkTasks(diagnostics, root, taskPath, registry, memberIds, stakeholderIds, scope && scope.key, options && options.firings);
  if (!scope) checkObsidian(diagnostics, root, canonicalDocuments.some((doc) => Array.isArray(doc.frontmatter.data.tags) && doc.frontmatter.data.tags.length > 0));
  diagnostics.sort((a, b) => (a.file || '').localeCompare(b.file || '') || a.line - b.line || a.code.localeCompare(b.code));
  return {
    schemaVersion: 1,
    root,
    diagnostics,
    summary: {
      documents: canonicalDocuments.length,
      tasks: taskCount,
      errors: diagnostics.filter((item) => item.severity === 'error').length,
      warnings: diagnostics.filter((item) => item.severity === 'warning').length,
      durationMs: Date.now() - startedAt
    }
  };
}

function checkProjectCharter(diagnostics, root, project) {
  // 읽기는 이 한 줄이고 나머지는 값 판정이다.
  checkCharterMetadata(diagnostics, inspectMarkdown(project.charter, root), project.key);
}

// 파일 단위 검사가 이미 보고하는 코드. fold가 같은 것을 다시 세지 않게 한다.
const SHARD_LEVEL_LEDGER_CODES = new Set(['RDL-DEC-014', 'RDL-DLG-014', 'RDL-APPROVE-014']);

// 새 원장의 교차 이벤트 진단(상충하는 답변, 취소 대상 불일치, 모호한 위임 등)은
// 파일 단위 검사로는 보이지 않는다 — fold를 거쳐야 나온다. 검사 결과에 합치지
// 않으면 그 진단은 그것을 부르는 명령을 아는 사람에게만 보인다.
// 다이제스트는 체크섬이지 서명이 아니다. 기존 행을 고치고 다시 계산하면 파일
// 안에는 변형 하나만 남아 상충 검출이 성립하지 않는다. 파일이 덧붙여지기만
// 했는지는 이 저장소 밖의 기준점 — Git 이력 — 으로만 판정할 수 있다.
function checkLedgerIntegrity(diagnostics, layout) {
  if (layout.schemaVersion < 6) return;
  let report;
  try { report = require('./ledger-integrity').appendOnlyReport(layout.root); }
  catch (error) {
    diagnostic(diagnostics, { code: 'RDL-LEDGER-002', category: 'workspace', message: `원장 무결성을 확인할 수 없습니다: ${error.message}` });
    return;
  }
  // 확인하지 못한 것과 확인해서 문제가 없는 것은 다르다. 증명할 수 없는 상태를
  // 깨끗함으로 보고하면, 검사를 통과했다는 말이 아무것도 뜻하지 않게 된다.
  if (!report.checked && report.reason) {
    diagnostic(diagnostics, { code: 'RDL-LEDGER-002', category: 'workspace', message: `원장 무결성을 확인할 수 없습니다: ${report.reason}` });
  }
  for (const violation of report.violations) {
    diagnostic(diagnostics, { code: 'RDL-LEDGER-003', category: 'workspace', file: violation.file, line: 1, message: `append-only 위반: ${violation.message}` });
  }
}

function checkLedgerFolds(diagnostics, layout, projectKey) {
  if (layout.schemaVersion < 6) return;
  const eventsRoot = path.join(layout.root, 'projects', 'workspace', 'events');
  if (!fs.existsSync(eventsRoot)) return;
  const projects = (layout.projects || []).filter((project) => !projectKey || project.key === projectKey);
  const now = Date.now();
  // 검사가 인가를 끈 채 접으면 위조된 승인·위임을 정상으로 보고한다. 검사는
  // 가장 마지막으로 남는 안전망이므로 여기서 끄면 아무 데서도 걸리지 않는다.
  const cache = new Map();
  const authorityFor = (key) => {
    if (!cache.has(key)) cache.set(key, require('./authority').authorityContext(layout.root, key, { now }));
    return cache.get(key);
  };
  for (const project of projects) {
    const folds = [
      () => require('./decision').foldDecisions(require('./decision').readDecisionEvents(eventsRoot, project.key), authorityFor(project.key)),
      () => require('./delegation').foldDelegations(require('./delegation').readDelegationEvents(eventsRoot, project.key), { now, authority: authorityFor(project.key) }),
      () => require('./approval').foldApprovals(require('./approval').readApprovalEvents(eventsRoot, project.key), { authority: authorityFor(project.key) })
    ];
    for (const fold of folds) {
      let result;
      try { result = fold(); } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-LEDGER-001', category: 'workspace', project: project.key, message: `원장을 접을 수 없습니다: ${error.message}` });
        continue;
      }
      for (const item of result.diagnostics || []) {
        // 파일 단위 검사가 이미 스키마·봉투 손상을 같은 코드로 보고한다. fold에서
        // 다시 세면 이벤트 하나가 두 건으로 집계되어 "몇 건이 잘못됐는가"를
        // 오독하게 만든다. fold는 교차 이벤트 진단만 더한다.
        if (SHARD_LEVEL_LEDGER_CODES.has(item.code)) continue;
        diagnostic(diagnostics, { code: item.code, category: 'workspace', severity: item.severity, project: project.key, target: item.eventId || null, message: item.message });
      }
    }
  }
}

function checkWorkspaceStore(diagnostics, layout) {
  if (layout.schemaVersion < 6) return;
  const workspaceRoot = path.join(layout.root, 'projects', 'workspace');
  const clientsRoot = path.join(workspaceRoot, 'clients');
  const eventsRoot = path.join(workspaceRoot, 'events');
  // 프로젝트별 활성 멤버. 승인 권한은 자격의 유형만이 아니라 그 자격이 이 프로젝트에
  // 속하는지에도 달려 있다. 프로젝트마다 한 번만 읽는다.
  const memberCache = new Map();
  const activeProjectMembers = (currentLayout, projectKey) => {
    if (!memberCache.has(projectKey)) {
      let active = new Set();
      try {
        active = new Set(require('./collaboration').readCollaboration(currentLayout.root, projectKey).members
          .filter((member) => member.fields['상태'] === 'active').map((member) => member.id));
      } catch (_) { active = new Set(); }
      memberCache.set(projectKey, active);
    }
    return memberCache.get(projectKey);
  };
  const clients = new Map();
  if (fs.existsSync(clientsRoot)) for (const entry of fs.readdirSync(clientsRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^client-([a-z0-9]+(?:-[a-z0-9]+)*)\.yaml$/u.exec(entry.name);
    const file = path.join(clientsRoot, entry.name);
    if (!match) {
      diagnostic(diagnostics, { code: 'RDL-CLIENT-001', category: 'workspace', file: relative(layout.root, file), message: 'Client 파일명은 client-<client-id>.yaml 형식이어야 합니다.' });
      continue;
    }
    const source = fs.readFileSync(file, 'utf8');
    const id = workspaceApi.yamlValue(source, 'id');
    const type = workspaceApi.yamlValue(source, 'type');
    const owner = workspaceApi.yamlValue(source, 'owner');
    const status = workspaceApi.yamlValue(source, 'status');
    if (id !== match[1]) diagnostic(diagnostics, { code: 'RDL-CLIENT-002', category: 'workspace', file: relative(layout.root, file), message: 'Client 파일명과 id가 일치하지 않습니다.' });
    if (!['device', 'agent', 'service', 'human'].includes(type)) diagnostic(diagnostics, { code: 'RDL-CLIENT-003', category: 'workspace', file: relative(layout.root, file), message: `지원하지 않는 Client type입니다: ${type || '(없음)'}` });
    if (!/^MEMBER-\d{3}$/u.test(owner || '')) diagnostic(diagnostics, { code: 'RDL-CLIENT-004', category: 'workspace', file: relative(layout.root, file), message: 'Client owner는 MEMBER-ID여야 합니다.' });
    if (!['active', 'disabled', 'retired'].includes(status)) diagnostic(diagnostics, { code: 'RDL-CLIENT-005', category: 'workspace', file: relative(layout.root, file), message: `지원하지 않는 Client status입니다: ${status || '(없음)'}` });
    clients.set(id, { owner, status, type });
  }
  // 프로젝트 키와 Client ID가 둘 다 하이픈을 담을 수 있고 파일명은 하이픈으로 잇는다.
  // 겹치는 짝은 완전히 같은 샤드 파일명을 만들어 두 짝의 이벤트가 한 파일에 섞인다.
  // 파일을 보고는 구분할 수 없으므로 — 이름이 같기 때문이다 — 짝의 목록에서 찾는다.
  {
    const pairs = [];
    for (const project of layout.projects || []) for (const clientId of clients.keys()) pairs.push({ project: project.key, clientId });
    const collision = require('./event-store').shardPrefixCollision(pairs);
    if (collision) diagnostic(diagnostics, {
      code: 'RDL-EVENT-010', category: 'workspace', file: null,
      message: `샤드 파일명이 겹치는 프로젝트·Client 짝이 있습니다: ${collision.first.project}+${collision.first.clientId}와 ${collision.second.project}+${collision.second.clientId}가 모두 ${collision.key}를 만듭니다. 한쪽의 하이픈 경계를 바꾸세요.`
    });
  }
  if (fs.existsSync(eventsRoot)) for (const entry of fs.readdirSync(eventsRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(eventsRoot, entry.name);
    if (!/^lease-[a-z0-9-]+-\d{6}\.jsonl$/u.test(entry.name)) {
      diagnostic(diagnostics, { code: 'RDL-LEASE-001', category: 'workspace', file: relative(layout.root, file), message: '임대 파일명이 표준 패턴과 다릅니다.' });
      continue;
    }
    for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (!clients.has(event.clientId)) diagnostic(diagnostics, { code: 'RDL-LEASE-002', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `등록되지 않은 Client를 참조합니다: ${event.clientId || '(없음)'}` });
        if (!entry.name.startsWith(`lease-${event.projectId || 'workspace'}-${event.clientId}-`)) diagnostic(diagnostics, { code: 'RDL-LEASE-003', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: '임대 이벤트 범위 또는 Client가 파일명과 일치하지 않습니다.' });
      } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-LEASE-004', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `JSONL 이벤트를 파싱할 수 없습니다: ${error.message}` });
      }
    }
  }
  // events/run/ 서브디렉터리는 run 원장 샤드다. 알려진 kind만 검사하고, 그 밖의
  // 서브디렉터리는 미래의 이벤트 종류이므로 진단하지 않는다 — 구버전이 신버전의
  // 데이터를 오진하지 않게 하는 것과 같은 규칙을 이 버전도 미래에 대해 지킨다.
  const runRoot = path.join(eventsRoot, 'run');
  if (fs.existsSync(runRoot)) for (const entry of fs.readdirSync(runRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(runRoot, entry.name);
    if (!/^run-[a-z0-9-]+-RUN-[A-F0-9]{20}-\d{6}\.jsonl$/u.test(entry.name)) {
      diagnostic(diagnostics, { code: 'RDL-RUN-001', category: 'workspace', file: relative(layout.root, file), message: '런 이벤트 파일명이 표준 패턴과 다릅니다.' });
      continue;
    }
    for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (!clients.has(event.clientId)) diagnostic(diagnostics, { code: 'RDL-RUN-002', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `등록되지 않은 Client를 참조합니다: ${event.clientId || '(없음)'}` });
        if (!entry.name.startsWith(`run-${event.projectId}-${event.clientId}-${event.runId}-`)) diagnostic(diagnostics, { code: 'RDL-RUN-003', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: '런 이벤트의 프로젝트, Client 또는 runId가 파일명과 일치하지 않습니다.' });
        // sync 전이의 신원 인가: 순수 fold는 레지스트리를 못 보므로, 레지스트리를
        // 가진 검사 계층이 인가 매트릭스(sync 실행자 = 활성 agent/service)를 확인한다.
        if (event.type === 'run.synced' || (event.type === 'run.halted' && ['sync-failed', 'merge-conflict'].includes(event.reason))) {
          const client = clients.get(event.clientId);
          if (!client || client.status !== 'active' || !['agent', 'service'].includes(client.type)) {
            diagnostic(diagnostics, { code: 'RDL-RUN-005', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `sync 전이의 clientId가 활성 agent/service Client가 아닙니다: ${event.clientId || '(없음)'}` });
          }
        }
        // 사람 승인의 신원 인가. sync 전이(RDL-RUN-005)와 같은 자리이고 같은 이유다 —
        // 순수 fold는 레지스트리를 못 보므로 형태만 제한하고, 레지스트리를 가진 이
        // 계층이 "그 clientId가 정말 human 유형 활성 Client인가"를 답한다.
        //
        // 소유 멤버까지 본다. human 자격은 어느 프로젝트에나 등록될 수 있으므로,
        // 유형과 상태만 맞으면 옆 프로젝트의 검토자가 이 프로젝트를 승인하게 된다.
        if (event.type === 'run.forced' && event.basis === 'human-approval') {
          const client = clients.get(event.clientId);
          const member = client && event.projectId ? activeProjectMembers(layout, event.projectId).has(client.owner) : false;
          if (!client || client.status !== 'active' || client.type !== 'human' || !member) {
            diagnostic(diagnostics, { code: 'RDL-RUN-031', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `사람 승인의 clientId가 이 프로젝트의 활성 human Client가 아닙니다: ${event.clientId || '(없음)'}(${client ? `${client.type}, owner ${client.owner}` : '미등록'})` });
          }
        }
        // 사후 변조. 이미 기록된 이벤트의 값만 바꿔치기하면 승인은 자기가 본 적 없는
        // 상태를 승인한 것이 된다. canonicalDigest가 그것을 덮는지 여기서 확인한다 —
        // 접기는 런을 읽을 때만 알아차리고, 감사에서는 읽기 전에 물어야 한다.
        if (event.canonicalDigest !== undefined) {
          try {
            if (normalizeRunEvent && createRunEnvelope(event).canonicalDigest !== event.canonicalDigest) throw new Error('canonicalDigest가 canonical projection과 일치하지 않습니다.');
          } catch (digestError) {
            diagnostic(diagnostics, { code: 'RDL-RUN-033', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `런 이벤트의 canonical 봉투가 유효하지 않습니다: ${digestError.message}` });
          }
        }
      } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-RUN-004', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `JSONL 이벤트를 파싱할 수 없습니다: ${error.message}` });
      }
    }
  }
  // 판정이 지목한 커밋이 이 저장소에서 풀리는가. 풀리지 않으면 그 판정은 여기서
  // 증거가 아니다 — 무엇을 보고 내린 판정인지 확인할 방법이 없기 때문이다.
  //
  // 쓰기 경로로는 막을 수 없다. 다른 클라이언트의 verdict 샤드는 git 병합으로
  // 들어오고, 그 클라이언트의 프로젝트 커밋이 함께 오지 않을 수 있다. 그래서
  // 이것은 기록할 때가 아니라 읽을 때 판정한다.
  const resolvable = new Map();
  const revisionResolves = (projectId, revision) => {
    const key = `${projectId} ${revision}`;
    if (!resolvable.has(key)) {
      const root = path.join(layout.root, 'projects', projectId);
      resolvable.set(key, fs.existsSync(path.join(root, '.git')) || fs.existsSync(root)
        ? runGit(['cat-file', '-e', `${revision}^{commit}`], { cwd: root, allowFailure: true }).status === 0
        : true);
    }
    return resolvable.get(key);
  };
  const verdictRoot = path.join(eventsRoot, 'verdict');
  if (fs.existsSync(verdictRoot)) for (const entry of fs.readdirSync(verdictRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(verdictRoot, entry.name);
    if (!/^verdict-[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]+(?:-[a-z0-9]+)*-\d{6}\.jsonl$/u.test(entry.name)) {
      diagnostic(diagnostics, { code: 'RDL-VERDICT-010', category: 'workspace', file: relative(layout.root, file), message: '검증 verdict 이벤트 파일명이 표준 패턴과 다릅니다.' });
      continue;
    }
    for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-VERDICT-011', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `JSONL verdict 이벤트를 파싱할 수 없습니다: ${error.message}` });
        continue;
      }
      if (!clients.has(event.clientId)) diagnostic(diagnostics, { code: 'RDL-VERDICT-012', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `등록되지 않은 Client를 참조합니다: ${event.clientId || '(없음)'}` });
      if (!entry.name.startsWith(`verdict-${event.projectId}-${event.clientId}-`)) diagnostic(diagnostics, { code: 'RDL-VERDICT-013', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: 'verdict 이벤트의 프로젝트 또는 Client가 파일명과 일치하지 않습니다.' });
      try {
        normalizeVerdictEvent(event);
        const expected = verdictEnvelope(event).canonicalDigest;
        if (!/^[a-f0-9]{64}$/u.test(event.canonicalDigest || '') || event.canonicalDigest !== expected) throw new Error('canonicalDigest가 canonical verdict projection과 일치하지 않습니다.');
      } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-VERDICT-014', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `verdict schema/envelope가 유효하지 않습니다: ${error.message}` });
      }
      if (event.projectId && event.reviewedRevision && !revisionResolves(event.projectId, event.reviewedRevision)) {
        diagnostic(diagnostics, { code: 'RDL-VERDICT-015', category: 'workspace', severity: 'warning', file: relative(layout.root, file), line: index + 1, message: `판정이 지목한 리비전을 이 저장소에서 풀 수 없습니다. 판정을 내린 클라이언트가 아직 커밋을 공유하지 않았거나 이력에서 사라진 것이며, 그때까지 이 판정은 여기서 증거가 아닙니다: ${event.reviewedRevision}` });
      }
    }
  }
  const decisionRoot = path.join(eventsRoot, 'decision');
  if (fs.existsSync(decisionRoot)) for (const entry of fs.readdirSync(decisionRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(decisionRoot, entry.name);
    if (!/^decision-[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]+(?:-[a-z0-9]+)*-\d{6}\.jsonl$/u.test(entry.name)) {
      diagnostic(diagnostics, { code: 'RDL-DEC-010', category: 'workspace', file: relative(layout.root, file), message: '결정 이벤트 파일명이 표준 패턴과 다릅니다.' });
      continue;
    }
    for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-DEC-011', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `JSONL 결정 이벤트를 파싱할 수 없습니다: ${error.message}` });
        continue;
      }
      if (!clients.has(event.clientId)) diagnostic(diagnostics, { code: 'RDL-DEC-012', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `등록되지 않은 Client를 참조합니다: ${event.clientId || '(없음)'}` });
      if (!entry.name.startsWith(`decision-${event.projectId}-${event.clientId}-`)) diagnostic(diagnostics, { code: 'RDL-DEC-013', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: '결정 이벤트의 프로젝트 또는 Client가 파일명과 일치하지 않습니다.' });
      try {
        const normalized = normalizeDecisionEvent(event);
        const expected = decisionEnvelope(normalized).canonicalDigest;
        if (!/^[a-f0-9]{64}$/u.test(event.canonicalDigest || '') || event.canonicalDigest !== expected) throw new Error('canonicalDigest가 canonical projection과 일치하지 않습니다.');
      } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-DEC-014', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `결정 schema/envelope가 유효하지 않습니다: ${error.message}` });
      }
    }
  }
  const approvalRoot = path.join(eventsRoot, 'approval');
  if (fs.existsSync(approvalRoot)) for (const entry of fs.readdirSync(approvalRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(approvalRoot, entry.name);
    if (!/^approval-[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]+(?:-[a-z0-9]+)*-\d{6}\.jsonl$/u.test(entry.name)) {
      diagnostic(diagnostics, { code: 'RDL-APPROVE-010', category: 'workspace', file: relative(layout.root, file), message: '승인 이벤트 파일명이 표준 패턴과 다릅니다.' });
      continue;
    }
    for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-APPROVE-011', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `JSONL 승인 이벤트를 파싱할 수 없습니다: ${error.message}` });
        continue;
      }
      if (!clients.has(event.clientId)) diagnostic(diagnostics, { code: 'RDL-APPROVE-012', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `등록되지 않은 Client를 참조합니다: ${event.clientId || '(없음)'}` });
      if (!entry.name.startsWith(`approval-${event.projectId}-${event.clientId}-`)) diagnostic(diagnostics, { code: 'RDL-APPROVE-013', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: '승인 이벤트의 프로젝트 또는 Client가 파일명과 일치하지 않습니다.' });
      try {
        const normalized = normalizeApprovalEvent(event);
        const expected = approvalEnvelope(normalized).canonicalDigest;
        if (!/^[a-f0-9]{64}$/u.test(event.canonicalDigest || '') || event.canonicalDigest !== expected) throw new Error('canonicalDigest가 canonical projection과 일치하지 않습니다.');
      } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-APPROVE-014', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `승인 schema/envelope가 유효하지 않습니다: ${error.message}` });
      }
    }
  }
  const delegationRoot = path.join(eventsRoot, 'delegation');
  if (fs.existsSync(delegationRoot)) for (const entry of fs.readdirSync(delegationRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(delegationRoot, entry.name);
    if (!/^delegation-[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]+(?:-[a-z0-9]+)*-\d{6}\.jsonl$/u.test(entry.name)) {
      diagnostic(diagnostics, { code: 'RDL-DLG-010', category: 'workspace', file: relative(layout.root, file), message: '위임 이벤트 파일명이 표준 패턴과 다릅니다.' });
      continue;
    }
    for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-DLG-011', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `JSONL 위임 이벤트를 파싱할 수 없습니다: ${error.message}` });
        continue;
      }
      if (!clients.has(event.clientId)) diagnostic(diagnostics, { code: 'RDL-DLG-012', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `등록되지 않은 Client를 참조합니다: ${event.clientId || '(없음)'}` });
      if (!entry.name.startsWith(`delegation-${event.projectId}-${event.clientId}-`)) diagnostic(diagnostics, { code: 'RDL-DLG-013', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: '위임 이벤트의 프로젝트 또는 Client가 파일명과 일치하지 않습니다.' });
      // 수임 Client도 등록된 주체여야 한다. 권한을 받는 쪽이 레지스트리에 없으면
      // 그 위임은 누구에게 준 것인지 알 수 없다.
      if (event.type === 'delegation.granted' && !clients.has(event.delegateClientId)) {
        diagnostic(diagnostics, { code: 'RDL-DLG-012', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `등록되지 않은 수임 Client입니다: ${event.delegateClientId || '(없음)'}` });
      }
      try {
        const normalized = normalizeDelegationEvent(event);
        const expected = delegationEnvelope(normalized).canonicalDigest;
        if (!/^[a-f0-9]{64}$/u.test(event.canonicalDigest || '') || event.canonicalDigest !== expected) throw new Error('canonicalDigest가 canonical projection과 일치하지 않습니다.');
      } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-DLG-014', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `위임 schema/envelope가 유효하지 않습니다: ${error.message}` });
      }
    }
  }
  const driverRoot = path.join(eventsRoot, 'driver');
  if (fs.existsSync(driverRoot)) for (const entry of fs.readdirSync(driverRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(driverRoot, entry.name);
    if (!/^driver-[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]+(?:-[a-z0-9]+)*-RUN-[A-F0-9]{20}-\d{6}\.jsonl$/u.test(entry.name)) {
      diagnostic(diagnostics, { code: 'RDL-DRIVER-010', category: 'workspace', file: relative(layout.root, file), message: 'driver event shard filename is invalid.' });
      continue;
    }
    for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-DRIVER-011', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `driver JSONL is invalid: ${error.message}` });
        continue;
      }
      if (!clients.has(event.clientId)) diagnostic(diagnostics, { code: 'RDL-DRIVER-012', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `driver event references an unknown client: ${event.clientId || '(missing)'}` });
      if (!entry.name.startsWith(`driver-${event.projectId}-${event.clientId}-${event.runId}-`)) diagnostic(diagnostics, { code: 'RDL-DRIVER-013', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: 'driver event project/client/run identity differs from its filename.' });
      try {
        const normalized = normalizeDriverEvent(event);
        const expected = driverEnvelope(normalized).canonicalDigest;
        if (!/^[a-f0-9]{64}$/u.test(event.canonicalDigest || '') || event.canonicalDigest !== expected) throw new Error('canonicalDigest differs from the canonical driver projection');
      } catch (error) {
        diagnostic(diagnostics, { code: 'RDL-DRIVER-014', category: 'workspace', file: relative(layout.root, file), line: index + 1, message: `driver schema/envelope is invalid: ${error.message}` });
      }
    }
  }
}

function checkCompositeViews(diagnostics, layout, project) {
  const documents = prepareCompositeDocuments(projectArtifacts(project));
  for (const issue of compositeIssues(documents)) diagnostic(diagnostics, {
    code: issue.code, category: 'diagram', severity: 'warning', file: null, project: project.key, target: issue.target,
    message: issue.message
  });
  for (const view of compositeDrift(project.root, documents)) diagnostic(diagnostics, {
    code: 'RDL-COMPOSE-003', category: 'diagram', severity: 'warning', file: relative(layout.root, view.file), project: project.key, target: view.name,
    message: `${view.title}가 현재 정본과 다릅니다. rdl contract diagram --project ${project.key} --write로 다시 생성하세요.`
  });
}

// 저장 게이트는 Rundol의 저장을 지나는 작업에만 걸린다. Git을 직접 써서 만든 커밋은
// 그 게이트를 지나지 않으므로 결박을 요구할 방법이 없다. 그 한계를 없앨 수는 없지만
// 감출 이유도 없다 — 사후 가시성은 검사가 맡는다.
//
// 창은 최근 커밋으로 한정한다. 전체 이력을 걷는 검사는 프로젝트가 자랄수록 느려지고,
// 오래된 커밋은 어차피 되돌릴 수 없어 알려도 할 일이 없다. 병합은 일이 아니므로 세지
// 않는다. 진단은 커밋마다가 아니라 한 건으로 모은다 — 올리자마자 옛 커밋 수십 건이
// 경고로 쏟아지면, 그 경고는 읽히지 않고 꺼진다.
const TASK_BINDING_WINDOW = 50;

function checkTaskBinding(diagnostics, layout, project, tally) {
  if (!project.ref || !project.root) return;
  // 트레일러를 읽는 규칙은 한 곳에 있다. 검사와 조회가 각자 파싱하면 두 곳이 같은
  // 커밋을 다르게 읽는 날이 오고, 결박은 무엇이 사실인지를 다투지 않아야 값을 갖는다.
  let commits;
  try { commits = readCommitBindings(layout.root, project.ref, { limit: TASK_BINDING_WINDOW }); }
  catch (error) {
    // 조회하지 못한 것과 위반이 없는 것은 다른 값이다. 조용히 돌아가면 이 검사가
    // 한 번도 돈 적이 없는 저장소가 결박 위반 없음과 같은 얼굴을 한다.
    if (tally) tally.unchecked.push(project.key);
    diagnostic(diagnostics, {
      code: 'RDL-TASK-038', category: 'task', severity: 'warning', file: null, project: project.key,
      message: `태스크 결박을 확인하지 못했습니다. ${error.message}`
    });
    return;
  }
  if (!commits.length) return;
  // trailer가 있다는 것과 그것이 가리키는 태스크가 있다는 것은 다른 사실이다. 줄만
  // 세면 Git으로 직접 만든 커밋에 아무 문자열이나 적어 이 검사를 지날 수 있고, 그러면
  // 이 검사가 세는 것은 결박이 아니라 그 줄을 적을 줄 아는 사람의 수다.
  // 옛 식별자도 아는 이름이다. 이관은 태스크를 옮긴 것이지 과거를 지운 것이 아니므로,
  // 이관 전 커밋의 trailer가 가리키는 옛 ID는 끊긴 결박이 아니다. previousIds를 보지
  // 않으면 이관을 돌린 사람에게 자기 이력 전체가 위반으로 보인다.
  let known = null;
  try {
    const store = readTaskStore(project.tasks).tasks || {};
    known = new Set(Object.keys(store));
    for (const task of Object.values(store)) for (const previous of Array.isArray(task.previousIds) ? task.previousIds : []) known.add(previous);
  } catch (_) { known = null; }
  const short = (item) => item.commit.slice(0, 12);
  const unbound = commits.filter((item) => item.binding === 'unbound').map(short);
  const excused = commits.filter((item) => item.binding === 'excused').map(short);
  // 태스크 저장소를 읽지 못했으면 판정하지 않는다. 읽지 못한 것을 근거로 없는
  // 태스크라고 말하면 저장소 문제 하나가 모든 커밋을 위반으로 만든다.
  const dangling = known ? commits.filter((item) => item.taskId && !known.has(item.taskId)).map((item) => `${short(item)}→${item.taskId}`) : [];
  const sample = (list) => list.slice(0, 5).join(', ') + (list.length > 5 ? ` 외 ${list.length - 5}건` : '');
  if (tally) {
    tally.scanned += commits.length;
    tally.bound += commits.length - unbound.length - excused.length;
    tally.unbound += unbound.length;
    tally.excused += excused.length;
    tally.dangling += dangling.length;
  }
  if (unbound.length) diagnostic(diagnostics, {
    code: 'RDL-TASK-034', category: 'task', severity: 'warning', file: null, project: project.key,
    message: `최근 커밋 ${TASK_BINDING_WINDOW}건 중 ${unbound.length}건이 태스크 결박을 지나지 않았습니다: ${sample(unbound)}`
  });
  if (excused.length) diagnostic(diagnostics, {
    code: 'RDL-TASK-035', category: 'task', severity: 'warning', file: null, project: project.key,
    message: `최근 커밋 ${TASK_BINDING_WINDOW}건 중 ${excused.length}건이 태스크 없이 저장됐습니다: ${sample(excused)}`
  });
  if (dangling.length) diagnostic(diagnostics, {
    code: 'RDL-TASK-039', category: 'task', severity: 'warning', file: null, project: project.key,
    message: `커밋 ${dangling.length}건이 이 프로젝트에 없는 태스크를 가리킵니다: ${sample(dangling)}`
  });
}

// 코드 브랜치의 결박. 프로젝트 ref가 아니므로 프로젝트 순회 밖에서 한 번만 센다.
//
// 이 줄이 없으면 지표가 rdl save가 지키는 절반만 재고, 문이 없는 절반은 계측 밖에
// 남는다. 그 상태에서는 결박이 무너져도 검사가 초록으로 답하므로 고장이 신호를
// 만들지 못한다 — 통제가 약해지는 것보다 계측이 눈감는 쪽이 늦게 발견된다.
//
// 세기만 하고 막지는 않는다. 코드 커밋은 rdl save를 지나지 않으므로 여기에는 막을
// 자리가 없고, 막을 수 없는 자리에서 오류를 내면 검사 전체가 꺼진다.
function checkCodeBinding(diagnostics, layout, projects, tally) {
  // Workspace 루트가 Git 최상위가 아니면 여기서 보이는 이력은 이 Workspace의 것이
  // 아니다. 검사 픽스처처럼 다른 저장소 안에 놓인 Workspace가 바깥 저장소의 커밋을
  // 자기 결박으로 보고하고, 그 저장소의 태스크를 모르니 전부 끊긴 결박으로 세게 된다.
  const top = runGit(['rev-parse', '--show-toplevel'], { cwd: layout.root, allowFailure: true });
  if (top.status !== 0 || !top.stdout) return;
  if (path.resolve(top.stdout.trim()).toLowerCase() !== path.resolve(layout.root).toLowerCase()) return;
  const branch = currentBranch(layout.root);
  // 루트에 rundol 전용 브랜치가 있는 것은 결박이 아니라 경계 위반이고 RDL-BRANCH-005가 답한다.
  if (!branch || branch.startsWith('rundol/')) return;
  let commits;
  try { commits = readCommitBindings(layout.root, branch, { limit: TASK_BINDING_WINDOW }); }
  catch (error) {
    tally.code = { branch, scanned: 0, unchecked: true };
    diagnostic(diagnostics, {
      code: 'RDL-TASK-038', category: 'task', severity: 'warning', file: null, project: null,
      message: `코드 브랜치 ${branch}의 태스크 결박을 확인하지 못했습니다. ${error.message}`
    });
    return;
  }
  if (!commits.length) return;
  // 아는 태스크는 모든 프로젝트의 합집합이다. 코드 브랜치는 한 프로젝트에 속하지
  // 않으므로 한 프로젝트의 목록으로 판정하면 다른 프로젝트의 태스크가 끊긴 결박이 된다.
  let known = new Set();
  for (const project of projects) {
    try {
      const store = readTaskStore(project.tasks).tasks || {};
      for (const id of Object.keys(store)) known.add(id);
      for (const task of Object.values(store)) for (const previous of Array.isArray(task.previousIds) ? task.previousIds : []) known.add(previous);
    } catch (_) { known = null; break; }
  }
  const short = (item) => item.commit.slice(0, 12);
  const sample = (list) => list.slice(0, 5).map(short).join(', ') + (list.length > 5 ? ` 외 ${list.length - 5}건` : '');
  const unbound = commits.filter((item) => item.binding === 'unbound');
  const excused = commits.filter((item) => item.binding === 'excused');
  const dangling = known ? commits.filter((item) => item.taskId && !known.has(item.taskId)) : [];
  tally.code = {
    branch,
    scanned: commits.length,
    bound: commits.length - unbound.length - excused.length,
    unbound: unbound.length,
    excused: excused.length,
    dangling: dangling.length
  };
  if (unbound.length) diagnostic(diagnostics, {
    code: 'RDL-TASK-041', category: 'task', severity: 'warning', file: null, project: null,
    message: `코드 브랜치 ${branch}의 최근 커밋 ${commits.length}건 중 ${unbound.length}건이 태스크 결박을 지나지 않았습니다: ${sample(unbound)}`
  });
  if (dangling.length) diagnostic(diagnostics, {
    code: 'RDL-TASK-039', category: 'task', severity: 'warning', file: null, project: null,
    message: `코드 브랜치 커밋 ${dangling.length}건이 등록되지 않은 태스크를 가리킵니다: ${sample(dangling)}`
  });
}

function checkDocumentProfile(diagnostics, layout, project, settings) {
  if (!project.charter || !fs.existsSync(project.charter)) return;
  const source = fs.readFileSync(project.charter, 'utf8');
  // 어떤 프로필 이름이 유효한지는 board.json 상속이 정한다. 그 목록을 넘기지 않으면
  // 팀이 만든 프리셋을 쓰는 프로젝트가 RDL-PROFILE-001로 오진되어 save와 sync가 막힌다.
  // contract check는 통과하는데 check --strict만 실패하는 상태였다.
  const presets = resolveProfilePresets(loadBoardPresentation(layout.root, project.key));
  const validation = validateDocumentProfile(source, presets);
  if (!validation.present) return;
  for (const message of validation.errors) diagnostic(diagnostics, {
    code: 'RDL-PROFILE-001', category: 'profile', file: relative(layout.root, project.charter), project: project.key, message
  });
  if (validation.errors.length) return;
  if (validation.profile.schemaVersion === 2) {
    if (settings.skipProfilePolicy) return;
    const artifacts = projectArtifacts(project);
    const evaluation = evaluateDocumentContract(validation.profile, artifacts);
    // 흡수 진단(006·007·010·011)은 없앴다. 제목 문자열만 보고 내용을 보지 않아 빈 제목
    // 여섯 줄로도 통과했고, 나중에 그 유형을 켜면 옮기라고 알려주는 경로도 없었다.
    checkContractViolations(diagnostics, evaluation, {
      file: relative(layout.root, project.charter), project: project.key, strict: settings.strict
    });
    // 예전 계약이 갖고 있던 값은 지금 아무 데서도 읽지 않는다. 지우지 않고 남겨 두되,
    // 남아 있다는 사실과 옮길 자리는 알려야 한다. 모르면 영영 그대로 남는다.
    const leftoverSections = Object.entries(validation.profile.omissions || {}).filter(([, item]) => !item.notApplicable);
    if (leftoverSections.length) diagnostic(diagnostics, {
      code: 'RDL-PROFILE-012', category: 'profile', severity: 'warning',
      file: relative(layout.root, project.charter), project: project.key,
      message: `예전 흡수 설정이 남아 있습니다: ${leftoverSections.map(([type]) => type).join(', ')}. rdl contract migrate로 프리셋 하부 요소로 옮기세요.`
    });
    if (Object.keys(validation.profile.rules || {}).length) diagnostic(diagnostics, {
      code: 'RDL-PROFILE-013', category: 'profile', severity: 'warning',
      file: relative(layout.root, project.charter), project: project.key,
      message: `예전 작성 순서 설정이 남아 있습니다: ${Object.keys(validation.profile.rules).join(', ')}. 지금은 읽지 않으므로 rdl contract migrate로 정리하세요.`
    });
    return;
  }
  diagnostic(diagnostics, {
    code: 'RDL-PROFILE-008', category: 'profile', severity: 'warning', file: relative(layout.root, project.charter), project: project.key,
    message: 'documentProfile schemaVersion 1은 호환 읽기만 지원합니다. project profile 명령으로 schemaVersion 2로 마이그레이션하세요.'
  });
  if (settings.skipProfilePolicy) return;
  const present = new Set();
  const roots = [project.documents, path.join(project.root, 'inbox')];
  for (const root of roots) for (const file of listMarkdownFiles(root)) {
    const inspected = inspectMarkdown(file, layout.root);
    const id = inspected.frontmatter && inspected.frontmatter.data.id;
    const match = /^([A-Z]{3})-\d{3,}$/u.exec(typeof id === 'string' ? id : '');
    if (match) present.add(match[1]);
  }
  const policy = validation.profile.policy;
  for (const type of policy.required) if (!present.has(type)) diagnostic(diagnostics, {
    code: 'RDL-PROFILE-002', category: 'profile', severity: settings.strict ? 'error' : 'warning',
    file: relative(layout.root, project.charter), project: project.key, target: type,
    message: `필수 문서 유형이 없습니다: ${type}`
  });
  for (const type of policy.recommended) if (!present.has(type)) diagnostic(diagnostics, {
    code: 'RDL-PROFILE-003', category: 'profile', severity: 'warning', file: relative(layout.root, project.charter),
    project: project.key, target: type, message: `권장 문서 유형이 없습니다: ${type}`
  });
  for (const type of policy.disabled) if (present.has(type)) diagnostic(diagnostics, {
    code: 'RDL-PROFILE-004', category: 'profile', severity: 'warning', file: relative(layout.root, project.charter),
    project: project.key, target: type, message: `비활성화된 문서 유형이 존재합니다: ${type}`
  });
}

function checkWorkspace(start, options) {
  const settings = options || {};
  const layout = workspaceLayout(start);
  if (layout.schemaVersion < 2) return checkLegacyWorkspace(start, settings, null);
  const startedAt = Date.now();
  // 판정이 무엇을 봤는지는 판정을 도는 자리에서만 알 수 있으므로 그릇을 여기서 만들어
  // 내려보낸다. 걸린 것만 되짚으면 걸리지 않은 규칙과 아예 안 불린 규칙이 같아지고,
  // 그 둘은 정반대의 뜻이다.
  const firings = [];
  const allProjects = listProjects(layout);
  const projects = settings.project ? allProjects.filter((project) => project.key === settings.project) : allProjects;
  const diagnostics = [];
  checkWorkspaceStore(diagnostics, layout);
  checkLedgerFolds(diagnostics, layout, settings.project);
  checkLedgerIntegrity(diagnostics, layout);
  if (settings.project && projects.length === 0) diagnostic(diagnostics, { code: 'RDL-PROJECT-006', category: 'governance', target: settings.project, message: `프로젝트를 찾지 못했습니다: ${settings.project}` });
  if (!settings.project && allProjects.length === 0) diagnostic(diagnostics, { code: 'RDL-PROJECT-007', category: 'governance', file: layout.mountRelative, message: 'project.md가 있는 프로젝트를 찾지 못했습니다.' });
  let documents = 0;
  let tasks = 0;
  // 우회는 막지 않는 통제다. 막지 않는 통제가 값을 가지려면 얼마나 쓰였는지 셀 수
  // 있어야 하고, 세려면 보여야 한다 — 진단 목록에만 있으면 경고 수십 개 사이에 묻힌다.
  const taskBinding = { scanned: 0, bound: 0, unbound: 0, excused: 0, dangling: 0, unchecked: [] };
  // 면제는 막지 않는 통제다. 막지 않는 통제가 값을 가지려면 얼마나 쓰였는지 셀 수
  // 있어야 하고, 세려면 보여야 한다 — 결박의 우회를 세는 것과 같은 이유다.
  const exemptions = [];
  for (const project of projects) {
    checkProjectCharter(diagnostics, layout.root, project);
    checkDocumentProfile(diagnostics, layout, project, settings);
    checkCompositeViews(diagnostics, layout, project);
    checkTaskBinding(diagnostics, layout, project, taskBinding);
    const result = checkLegacyWorkspace(layout.root, Object.assign({}, settings, { firings }), project);
    for (const item of result.diagnostics) diagnostics.push(Object.assign({ project: project.key }, item));
    documents += result.summary.documents + 1;
    tasks += result.summary.tasks;
  }
  checkCodeBinding(diagnostics, layout, projects, taskBinding);
  const taskSources = layout.schemaVersion >= 3 ? projects.map((project) => ({ project: project.key, file: project.tasks })) : [{ project: null, file: layout.tasks }];
  const projectKeys = new Set(allProjects.map((project) => project.key));
  for (const source of taskSources) {
    if (!source.file || !fs.existsSync(source.file)) {
      diagnostic(diagnostics, { code: 'RDL-TASK-001', category: 'task', file: source.file ? relative(layout.root, source.file) : null, project: source.project, message: 'Workspace tasks.json을 찾지 못했습니다.' });
      continue;
    }
    try {
      const parsed = readTaskStore(source.file);
      for (const [taskId, task] of Object.entries(parsed.tasks || {})) {
        const exemptedGates = exemptionGates(task && task.exemption);
        if (exemptedGates.length) exemptions.push({ project: source.project, taskId, gates: exemptedGates, decidedBy: task.exemption.decidedBy || null, reason: task.exemption.reason || null });
        if (!task.project || !projectKeys.has(task.project) || (source.project && task.project !== source.project)) diagnostic(diagnostics, { code: 'RDL-TASK-022', category: 'task', file: relative(layout.root, source.file), project: source.project, artifactId: taskId, target: task.project || null, message: `태스크의 project가 저장 브랜치의 프로젝트와 일치하지 않습니다: ${task.project || '(없음)'}` });
      }
    } catch (error) {
      diagnostic(diagnostics, { code: 'RDL-TASK-002', category: 'task', file: relative(layout.root, source.file), project: source.project, message: `태스크 저장소를 파싱할 수 없습니다: ${error.message}` });
    }
  }
  for (const project of projects) checkObsidian(diagnostics, project.root, documents > 0);
  diagnostics.sort((a, b) => (a.file || '').localeCompare(b.file || '') || (a.line || 0) - (b.line || 0) || a.code.localeCompare(b.code));
  const result = {
    schemaVersion: layout.schemaVersion,
    root: layout.root,
    projects: projects.map((project) => project.key),
    diagnostics,
    summary: {
      projects: projects.length,
      documents,
      tasks,
      taskBinding,
      exemptions,
      errors: diagnostics.filter((item) => item.severity === 'error').length,
      warnings: diagnostics.filter((item) => item.severity === 'warning').length,
      durationMs: Date.now() - startedAt
    }
  };
  // 판정이 끝난 뒤에 그 결과만 넘긴다. 무엇을 어떻게 적을지는 계측이 정한다 —
  // 여기서 정하면 발화 지점마다 계측이 흩어지고, 흩어진 계측은 지점이 늘 때 빠진다.
  // 빠졌다는 사실은 아무 신호도 내지 않으며, 그것이 이 계측이 생긴 이유다.
  require('./rule-telemetry').recordCheck(start, result, firings, settings);
  return result;
}

module.exports = {
  checkWorkspace,
  // 발화 이력이 "선언된 규칙 전부"를 알아야 한 번도 안 불린 규칙을 셀 수 있다. 유형
  // 정의를 읽는 규칙은 이미 여기 있으므로 다시 구현하지 않고 내보낸다.
  resolveItemTypes,
  listMarkdownFiles,
  findWorkspaceRoot,
  readWorkspaceManifest,
  yamlNestedValue
};
