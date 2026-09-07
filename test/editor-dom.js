'use strict';

// 편집기 시험이 쓰는 브라우저 흉내. 편집기 모듈을 화면 없이 여는 데 필요한 최소치다.
//
// 원래 editor-live.test.js 안에 있었다. 자산 embed 미리보기 시험이 같은 것을 필요로
// 해서 여기로 옮겼다 — 두 벌을 두면 한쪽만 고쳐진 날 두 시험이 서로 다른 브라우저를
// 흉내 내게 되고, 그 차이는 실패했을 때에야 드러난다.

const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const editorDir = path.join(root, 'src', 'board-ui', 'editor');

/** 편집기 모듈 하나를 동적 import로 읽는다. remark가 ESM 전용이라 require로는 못 읽는다. */
function loadEditorModule(name) {
  return import(pathToFileURL(path.join(editorDir, name)).href);
}

// ProseMirror와 그 위의 컴포넌트가 기대하는 브라우저 전역을 세운다. 하나씩 채우면
// 끝이 없어서 window에 있는 것을 통째로 옮기고, Node가 자기 것으로 이미 갖고 있어
// 건너뛰어지는 것만 따로 덮어쓴다.
function installDom(JSDOM) {
  const dom = new JSDOM('<!doctype html><html><body><div id="surface"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://127.0.0.1/'
  });
  const { window } = dom;

  global.window = window;
  global.document = window.document;
  Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true, writable: true });
  global.addEventListener = window.addEventListener.bind(window);
  global.removeEventListener = window.removeEventListener.bind(window);
  global.dispatchEvent = window.dispatchEvent.bind(window);

  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in global) continue;
    try { Object.defineProperty(global, key, { value: window[key], configurable: true, writable: true }); }
    catch (_) { /* 옮기지 못하는 것은 넘긴다 */ }
  }
  // Node가 자기 것으로 갖고 있어 위 루프가 건너뛴 것들. jsdom의 dispatchEvent는
  // 다른 realm의 Event를 거부하므로 이 둘은 반드시 덮어써야 한다.
  for (const key of ['Event', 'CustomEvent', 'EventTarget', 'AbortController', 'AbortSignal']) {
    if (window[key]) Object.defineProperty(global, key, { value: window[key], configurable: true, writable: true });
  }
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  global.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

  // jsdom은 배치를 하지 않아 getClientRects가 아예 없다. 없으면 자리 계산이 던지고,
  // 그러면 이 시험은 가드가 도는 것만 보게 된다 — 정상 경로는 한 번도 안 밟는다.
  // 값이 0이어도 상관없다. 여기서 보는 것은 좌표의 정확함이 아니라 그 길이 끝까지
  // 도는가이므로, 재는 시늉만 있으면 된다.
  const zero = { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };
  const rects = () => Object.assign([Object.assign({}, zero)], { item: (index) => (index === 0 ? Object.assign({}, zero) : null) });
  for (const proto of [window.Element.prototype, window.Range.prototype]) {
    if (!proto.getClientRects) proto.getClientRects = rects;
    if (!proto.getBoundingClientRect) proto.getBoundingClientRect = () => Object.assign({}, zero);
  }
  return window;
}

module.exports = { installDom, loadEditorModule, editorDir, root };
