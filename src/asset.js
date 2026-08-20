'use strict';

// 자산 넣기. 큰 그림을 사람이 매번 줄여서 넣으라고 하면 아무도 그 기능을 안 쓴다.
//
// 정본을 자동으로 고치지 않는다는 원칙은 여기서도 유효하다. 이 모듈이 손대는 것은
// 저장소 밖에서 가져오는 파일이며, 이미 정본에 들어간 자산을 뒤에서 바꾸지 않는다.
// 넣는 순간이 사람이 그 그림을 정하는 순간이므로, 그때 줄이는 것은 변조가 아니라
// 들여오기의 일부다.

const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject, readWorkspaceManifest, yamlNestedValue } = require('./workspace');

const { shrinkImage, ShrinkError, DEFAULT_MAX_EDGE } = require('./image-shrink');
const { imageSize, isAssetPath } = require('./image-header');
const { MAX_ASSET_BYTES } = require('./check-rules');

/** 자산은 문서 뿌리 아래 한 곳에 모인다. 흩어지면 어느 것이 쓰이는지 셀 수 없다. */
const ASSETS_DIRECTORY = 'assets';

// 프로젝트 등록이 이미 문서 뿌리를 들고 있다. 여기서 매니페스트를 다시 읽어
// 계산하면 그 계산이 등록과 갈릴 수 있고, 갈리면 자산이 검사가 보지 않는 곳에
// 쌓인다.
function documentsRoot(layout, project) {
  if (project && project.documents) return project.documents;
  const manifest = readWorkspaceManifest(layout.root);
  const relative = yamlNestedValue(manifest.source, 'documents', 'root') || 'docs';
  return path.resolve(layout.root, relative);
}

// 파일명은 값이지 장식이 아니다. 공백과 대문자와 한글이 섞이면 Obsidian embed와
// URL 인코딩에서 갈리고, 그 차이는 사람이 눈으로 못 본다.
function canonicalName(value, extension) {
  const base = String(value || '')
    .normalize('NFC')
    .replace(/\.[^.]+$/u, '')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return `${base || 'asset'}${extension}`;
}

function uniqueName(directory, name) {
  if (!fs.existsSync(path.join(directory, name))) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!fs.existsSync(path.join(directory, candidate))) return candidate;
  }
  throw new Error(`같은 이름의 자산이 너무 많습니다: ${name}`);
}

const EXTENSION_BY_FORMAT = { png: '.png', jpeg: '.jpg', gif: '.gif', webp: '.webp', svg: '.svg' };

/**
 * 저장소 밖의 이미지를 프로젝트 자산으로 들여온다.
 *
 * 긴 변이 한계를 넘으면 줄인다. 줄이지 못하는 형식이면 왜 못 줄이는지와 어떻게
 * 하면 되는지를 알리고 아무것도 쓰지 않는다 — 반쯤 들여온 상태를 남기면 다음에
 * 다시 넣을 때 이름이 하나 늘어난다.
 */
function addAsset(start, source, options) {
  const settings = options || {};
  const layout = workspaceLayout(start);
  const project = selectProject(layout, settings.project, true);
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`파일을 찾지 못했습니다: ${source}`);
  if (!isAssetPath(resolved)) throw new Error('자산으로 넣을 수 있는 것은 png, jpg, jpeg, gif, webp, svg입니다.');

  const original = fs.readFileSync(resolved);
  const maxEdge = settings.maxEdge === undefined || settings.maxEdge === null
    ? DEFAULT_MAX_EDGE
    : Number.parseInt(settings.maxEdge, 10);
  if (!Number.isSafeInteger(maxEdge) || maxEdge < 1) throw new Error('--max-edge는 1 이상의 정수여야 합니다.');

  const shrunk = shrinkImage(original, { maxEdge });
  const extension = EXTENSION_BY_FORMAT[shrunk.format] || path.extname(resolved).toLowerCase();
  const directory = path.join(documentsRoot(layout, project), ASSETS_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const name = uniqueName(directory, canonicalName(settings.as || path.basename(resolved), extension));
  fs.writeFileSync(path.join(directory, name), shrunk.buffer);

  const measured = imageSize(shrunk.buffer) || {};
  // 차원을 줄여도 용량이 준다는 보장은 없다. 사진 같은 PNG는 화소마다 값이 달라
  // deflate가 잡을 반복이 없고, 그런 그림은 줄인 뒤에도 크다. 형식을 말없이
  // 바꾸지는 않는다 — 손실 변환은 사람이 정할 일이다. 대신 그 사실을 말한다.
  const hint = shrunk.buffer.length > MAX_ASSET_BYTES && shrunk.format === 'png'
    ? `줄인 뒤에도 ${Math.round(shrunk.buffer.length / 1024)}KB입니다. 투명한 곳이 없는 사진이라면 JPEG로 저장해 넣는 편이 훨씬 작습니다.`
    : (shrunk.buffer.length > MAX_ASSET_BYTES
      ? `줄인 뒤에도 ${Math.round(shrunk.buffer.length / 1024)}KB로 한계 ${Math.round(MAX_ASSET_BYTES / 1024)}KB를 넘습니다. --max-edge를 더 낮추세요.`
      : null);
  return {
    changed: true,
    project: project.key,
    file: path.join(directory, name),
    name,
    ...(hint ? { hint } : {}),
    // 붙여 넣을 수 있는 형태로 돌려준다. 사람이 경로를 손으로 옮겨 적으면
    // 대소문자와 확장자에서 틀리고, 그 오타는 검사에서야 드러난다.
    embed: `![[${name}]]`,
    format: shrunk.format,
    width: measured.width || shrunk.width || null,
    height: measured.height || shrunk.height || null,
    bytes: shrunk.buffer.length,
    resized: shrunk.changed,
    from: { width: shrunk.from.width, height: shrunk.from.height, bytes: original.length }
  };
}

/** 자산 목록과 그 규격. 무엇이 얼마나 자리를 차지하는지 세지 않으면 규율이 안 선다. */
function listAssets(start, options) {
  const settings = options || {};
  const layout = workspaceLayout(start);
  const project = selectProject(layout, settings.project, true);
  const directory = path.join(documentsRoot(layout, project), ASSETS_DIRECTORY);
  const assets = [];
  if (fs.existsSync(directory)) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile()) continue;
      const file = path.join(directory, entry.name);
      const bytes = fs.statSync(file).size;
      const handle = fs.openSync(file, 'r');
      let head;
      try {
        head = Buffer.alloc(Math.min(4096, bytes));
        fs.readSync(handle, head, 0, head.length, 0);
      } finally { fs.closeSync(handle); }
      const size = imageSize(head) || {};
      assets.push({ name: entry.name, bytes, format: size.format || null, width: size.width || null, height: size.height || null });
    }
  }
  return {
    project: project.key,
    directory,
    assets,
    count: assets.length,
    bytes: assets.reduce((total, item) => total + item.bytes, 0)
  };
}

module.exports = { ASSETS_DIRECTORY, addAsset, listAssets, canonicalName, ShrinkError };
