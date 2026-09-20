'use strict';

// 클라이언트 훅 설정에 런돌 구간을 **병합한다.** 덮어쓰지 않는다.
//
// 스킬 지시문은 모델이 건너뛸 수 있어 결정론적 트리거가 못 된다. 하네스가 직접
// 실행하는 훅만이 "따로 부르는 것"을 "부수효과"로 바꾼다(docs/HOOKS.md). 그래서
// 세션 시작 훅이 대기 런을 컨텍스트에 넣고, 그 훅은 `rdl hook session-start`를
// 부르기만 한다 — 판정은 전부 rdl이 한다. 클라이언트마다 다른 훅 형식을 얇게
// 유지하는 유일한 방법이고, 판정을 훅 쪽에 두면 클로드용과 코덱스용이 언젠가
// 다르게 답한다.
//
// ── 이것은 남의 설정 파일을 고치는 일이다 ────────────────────────────────
//
// 그래서 규율이 셋이다.
//
//   표시. 런돌이 넣은 것에는 전부 표가 붙는다(MARKER). 표가 없는 것은 사용자의
//   것이며 읽지도 옮기지도 지우지도 않는다. 표가 있어야 무엇을 되돌릴지 물을 수
//   있고, 물을 수 없는 변경은 되돌릴 수 없는 변경이다.
//
//   보존. 파싱한 JSON을 다시 쓰되 우리 구간 밖의 값은 하나도 건드리지 않는다.
//   다른 이벤트, 같은 이벤트의 다른 항목, 최상위의 다른 열쇠가 전부 그대로 남는다.
//
//   드러냄. 읽지 못하거나 모양이 다르면 **던진다.** 조용히 덮어쓰지 않고 조용히
//   건너뛰지도 않는다. 건너뛰면 사람은 훅이 설치된 줄 알고, 설치되지 않은 훅은
//   없는 훅이며, 없는 훅은 아무 신호 없이 꺼진 통제와 구분되지 않는다.

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 런돌이 넣었다는 표. 항목 객체 안에 값으로 들어간다.
 *
 * 별도 장부 파일을 두지 않는 이유는 장부가 설정과 갈리기 때문이다. 사람이 항목을
 * 손으로 지우면 장부는 여전히 "넣었다"고 말하고, 그 뒤로 제거 경로는 없는 것을
 * 지우려 한다. 표가 항목 안에 있으면 설정 파일 자체가 유일한 사실이다.
 */
const MARKER = 'rundolManaged';

/** 구간 식별자. 넣는 자리가 늘어나면 자리마다 다른 값을 갖고, 제거는 값으로 고른다. */
const SESSION_START_REGION = 'rundol/session-start';

/** 병합하는 이벤트. 세션 시작 하나다 — 조회만 하는 자리이고 막지 않는다. */
const INSTALL_EVENT = 'SessionStart';

/**
 * 병합 대상. 스킬 설치가 보는 클라이언트 홈과 같은 환경 변수를 읽는다 — 두 설치가
 * 다른 홈을 보면 스킬은 있고 훅은 없는 설치가 조용히 생긴다.
 *
 * Copilot이 빠진 이유는 훅 계약이 없기 때문이다. 스킬은 파일을 놓는 일이라 형식이
 * 필요 없지만 훅은 형식이 있어야 하고, 없는 형식을 지어내면 그 파일은 아무도 읽지
 * 않는다.
 */
function hookTargets(environment) {
  const env = environment || process.env;
  const home = os.homedir();
  return [
    {
      client: 'claude',
      label: 'Claude Code',
      file: path.join(path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')), 'settings.json')
    },
    {
      client: 'codex',
      label: 'Codex',
      file: path.join(path.resolve(env.CODEX_HOME || path.join(home, '.codex')), 'hooks.json')
    }
  ];
}

/**
 * 넣을 항목. 훅은 트리거만 담는다.
 *
 * `command`와 `args`를 나눈 형식을 쓴다. 셸을 거치지 않고 직접 spawn하므로
 * 따옴표·`$`·백틱이 든 경로가 셸 파서에 닿지 않는다(docs/HOOKS.md).
 */
function sessionStartEntry(settings) {
  const entry = { [MARKER]: SESSION_START_REGION };
  // matcher는 Claude Code의 문법이다. Codex의 SessionStart에는 matcher가 없고,
  // 없는 자리에 넣으면 그 항목은 조용히 무시되거나 설정이 거부된다.
  if (settings.client === 'claude') entry.matcher = 'startup|resume';
  entry.hooks = [{
    type: 'command',
    command: settings.node,
    // 훅은 트리거만 담는다. 이 배열에 판정이 들어가는 날 클로드용과 코덱스용이
    // 갈리기 시작하고, 갈린 뒤에는 어느 쪽이 정본인지 물을 자리가 없다.
    args: [settings.cli, 'hook', 'session-start', '--client', settings.client],
    timeout: 30
  }];
  return entry;
}

function managed(entry) {
  return Boolean(entry && typeof entry === 'object' && typeof entry[MARKER] === 'string');
}

/**
 * 사용자가 직접 놓은 런돌 훅인가. 표가 없는데 `rdl hook`을 부르는 항목이 그것이다.
 *
 * 이런 항목은 보존하고 우리 것을 넣지 않는다. 넣으면 세션마다 훅이 두 번 돌고,
 * 그러면 같은 컨텍스트가 두 벌 주입된다. `rdl skill install`이 표 없는 스킬
 * 디렉터리를 사용자 소유로 보고 보존하는 것과 같은 판단이다.
 */
function invokesRundolHook(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  for (const hook of hooks) {
    if (!hook || typeof hook !== 'object') continue;
    const parts = [hook.command].concat(Array.isArray(hook.args) ? hook.args : []).filter((item) => typeof item === 'string');
    const joined = parts.join(' ');
    if (/rdl(?:\.js)?['"]?\s+hook\b/u.test(joined)) return true;
  }
  return false;
}

// 읽기는 두 가지를 가른다 — 파일이 없는 것과 파일을 읽을 수 없는 것. 없는 것은
// 정상이고 만들면 되지만, 읽을 수 없는 것은 그 자리에 **사람의 설정이 있는데 우리가
// 이해하지 못한다**는 뜻이다. 그때 새 내용으로 쓰면 그 설정은 사라진다.
function readConfiguration(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { exists: false, text: null, document: {} };
    throw new Error(`훅 설정을 읽지 못했습니다: ${file} (${error.code || error.message})`);
  }
  if (!text.trim()) return { exists: true, text, document: {} };
  let document;
  try { document = JSON.parse(text); }
  catch (error) {
    throw new Error(`훅 설정이 JSON이 아닙니다: ${file} — ${error.message}. 이 파일은 건드리지 않았습니다. 고친 뒤 다시 설치하세요.`);
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`훅 설정의 최상위가 객체가 아닙니다: ${file}. 이 파일은 건드리지 않았습니다.`);
  }
  return { exists: true, text, document };
}

function hooksSection(document, file) {
  if (!Object.prototype.hasOwnProperty.call(document, 'hooks')) return null;
  const section = document.hooks;
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    throw new Error(`훅 설정의 hooks가 객체가 아닙니다: ${file}. 이 파일은 건드리지 않았습니다.`);
  }
  return section;
}

function eventList(section, file) {
  if (!section || !Object.prototype.hasOwnProperty.call(section, INSTALL_EVENT)) return null;
  const list = section[INSTALL_EVENT];
  if (!Array.isArray(list)) {
    throw new Error(`훅 설정의 hooks.${INSTALL_EVENT}가 배열이 아닙니다: ${file}. 이 파일은 건드리지 않았습니다.`);
  }
  return list;
}

// 줄바꿈과 마지막 줄은 원본을 따른다. 형식만 바꾼 차분이 사람의 diff를 덮으면,
// 무엇이 실제로 달라졌는지 보려고 연 화면에서 그것이 보이지 않는다.
function serialize(document, original) {
  const eol = original && original.includes('\r\n') ? '\r\n' : '\n';
  const body = JSON.stringify(document, null, 2).replace(/\n/gu, eol);
  const trailing = original === null || original === undefined || /\r?\n$/u.test(original) ? eol : '';
  return `${body}${trailing}`;
}

// 임시 파일에 쓰고 바꿔 끼운다. 남의 설정 파일을 여는 도중에 죽으면 그 파일은
// 잘린 채로 남고, 잘린 설정은 그 클라이언트를 통째로 못 쓰게 만든다.
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.rundol-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch (_) { /* 임시 파일 정리 실패는 원인이 아니다 */ }
    throw new Error(`훅 설정을 쓰지 못했습니다: ${file} (${error.code || error.message})`);
  }
}

/**
 * 한 대상에 병합한다. 우리 구간만 지우고 다시 넣으며 나머지는 순서까지 그대로 둔다.
 *
 * 다시 넣기 전에 지우는 이유는 멱등이다. 두 번 설치하면 항목이 둘이 되고, 둘이
 * 되면 컨텍스트가 두 벌 주입되며, 사람은 그것을 훅의 결함으로 읽는다.
 */
function mergeTarget(target, settings) {
  const { exists, text, document } = readConfiguration(target.file);
  const section = hooksSection(document, target.file);
  const list = eventList(section, target.file);

  // 표 없는 런돌 훅은 사용자의 것이다. 보존하고 우리 것을 넣지 않는다.
  const userWritten = (list || []).filter((entry) => !managed(entry) && invokesRundolHook(entry));
  if (userWritten.length) {
    return { client: target.client, label: target.label, file: target.file, status: 'preserved', regions: (list || []).filter(managed).length,
      reason: '사용자가 직접 쓴 rdl 훅이 있어 그대로 두었습니다. 런돌 구간을 넣으면 세션마다 훅이 두 번 돕니다.' };
  }

  const kept = (list || []).filter((entry) => !(managed(entry) && entry[MARKER] === SESSION_START_REGION));
  const next = kept.concat([sessionStartEntry({ client: target.client, node: settings.node, cli: settings.cli })]);

  const nextDocument = Object.assign({}, document);
  nextDocument.hooks = Object.assign({}, section || {});
  nextDocument.hooks[INSTALL_EVENT] = next;
  const serialized = serialize(nextDocument, exists ? text : null);
  if (exists && serialized === text) {
    return { client: target.client, label: target.label, file: target.file, status: 'unchanged', regions: 1 };
  }
  writeAtomic(target.file, serialized);
  return { client: target.client, label: target.label, file: target.file, status: exists ? 'merged' : 'created', regions: 1 };
}

/**
 * 한 대상에서 런돌 구간만 뺀다. 비어 버린 그릇은 우리가 만든 것만 치운다.
 *
 * 사람이 원래 `"hooks": {}`를 적어 두었다면 그 빈 객체는 사람의 것이다. 우리가
 * 만든 자리와 사람이 만든 자리를 가르는 값이 그 자리에 무엇이 남았는가다 — 우리
 * 항목을 뺀 뒤 배열이 비면 그 배열은 우리가 만든 것이고, 비지 않으면 사람의 것이다.
 */
function removeTarget(target) {
  const { exists, text, document } = readConfiguration(target.file);
  if (!exists) return { client: target.client, label: target.label, file: target.file, status: 'absent', removed: 0 };
  const section = hooksSection(document, target.file);
  const list = eventList(section, target.file);
  const removed = (list || []).filter(managed).length;
  if (!removed) return { client: target.client, label: target.label, file: target.file, status: 'absent', removed: 0 };

  const kept = list.filter((entry) => !managed(entry));
  const nextDocument = Object.assign({}, document);
  const nextSection = Object.assign({}, section);
  if (kept.length) nextSection[INSTALL_EVENT] = kept;
  else delete nextSection[INSTALL_EVENT];
  if (Object.keys(nextSection).length) nextDocument.hooks = nextSection;
  else delete nextDocument.hooks;

  // 아무것도 남지 않았으면 파일째 치운다. 빈 객체 하나는 설정이 아니라 우리가
  // 지나간 자국이고, 자국을 남기면 "되돌렸다"가 참이 아니게 된다. 남은 열쇠가
  // 하나라도 있으면 그것은 사람의 것이므로 파일을 지우지 않는다.
  if (!Object.keys(nextDocument).length) {
    fs.rmSync(target.file, { force: true });
    return { client: target.client, label: target.label, file: target.file, status: 'removed', removed, deleted: true };
  }

  const serialized = serialize(nextDocument, text);
  writeAtomic(target.file, serialized);
  return { client: target.client, label: target.label, file: target.file, status: 'removed', removed, deleted: false };
}

function statusTarget(target) {
  let read;
  try { read = readConfiguration(target.file); }
  catch (error) {
    return { client: target.client, label: target.label, file: target.file, status: 'unreadable', regions: [], userEntries: null, reason: error.message };
  }
  if (!read.exists) return { client: target.client, label: target.label, file: target.file, status: 'absent', regions: [], userEntries: 0 };
  let list;
  try { list = eventList(hooksSection(read.document, target.file), target.file); }
  catch (error) {
    return { client: target.client, label: target.label, file: target.file, status: 'unreadable', regions: [], userEntries: null, reason: error.message };
  }
  const entries = list || [];
  const regions = entries.filter(managed).map((entry) => entry[MARKER]);
  return {
    client: target.client, label: target.label, file: target.file,
    status: regions.length ? 'installed' : 'absent',
    regions,
    // 사용자의 것이 몇 건인지 함께 말한다. "런돌 구간만 지운다"는 약속은 남는
    // 것이 몇 건인지 말할 수 있을 때만 확인할 수 있다.
    userEntries: entries.length - regions.length
  };
}

function resolveSettings(options) {
  const input = options || {};
  return {
    node: input.node || process.execPath,
    cli: input.cli || path.resolve(__dirname, '..', 'bin', 'rdl.js'),
    targets: input.targets || hookTargets(input.env)
  };
}

// 실패한 대상도 결과에 실린다. 던져서 첫 실패에서 멈추면 둘째 클라이언트는 시도조차
// 되지 않고, 그러면 "무엇이 설치됐고 무엇이 안 됐나"에 답할 수 없다. 부르는 쪽이
// failed를 보고 시끄럽게 끝내는 것이 이 함수의 계약이다.
function runTargets(targets, action) {
  const results = [];
  for (const target of targets) {
    try { results.push(action(target)); }
    catch (error) {
      results.push({ client: target.client, label: target.label, file: target.file, status: 'failed', reason: error.message });
    }
  }
  return results;
}

function installHooks(options) {
  const settings = resolveSettings(options);
  return { event: INSTALL_EVENT, region: SESSION_START_REGION, targets: runTargets(settings.targets, (target) => mergeTarget(target, settings)) };
}

function removeHooks(options) {
  const settings = resolveSettings(options);
  return { event: INSTALL_EVENT, region: SESSION_START_REGION, targets: runTargets(settings.targets, removeTarget) };
}

function hookInstallStatus(options) {
  const settings = resolveSettings(options);
  return { event: INSTALL_EVENT, region: SESSION_START_REGION, targets: runTargets(settings.targets, statusTarget) };
}

module.exports = {
  installHooks, removeHooks, hookInstallStatus, hookTargets, sessionStartEntry,
  MARKER, SESSION_START_REGION, INSTALL_EVENT
};
