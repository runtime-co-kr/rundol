'use strict';

// 원장의 append-only 강제.
//
// canonicalDigest는 서명이 아니라 누구나 다시 계산할 수 있는 체크섬이다. 기존
// 행의 값을 고치고 다이제스트를 새로 계산하면 파일 안에는 변형 하나만 남고,
// "같은 eventId에 다른 다이제스트"라는 상충 검출은 두 사본이 함께 있을 때만
// 작동하므로 아무것도 잡지 못한다.
//
// 그래서 파일 자체가 덧붙여지기만 했는지를 확인해야 하고, 그 판정에는 이 저장소
// 밖의 기준점이 필요하다. Rundol에는 Git이 있다 — 다만 Git은 불변 anchor가
// 아니다. amend·rebase·강제 push로 이력 자체를 다시 쓸 수 있고, 파일을 지우거나
// 이름을 바꾸면 "현재 존재하는 샤드"만 훑는 검사는 아무것도 보지 못한다.
//
// ── 이 검사가 보장하는 것과 보장하지 않는 것 ─────────────────────────
//
//   보장한다   현재 도달 가능한 이력에 이전 상태가 남아 있는 한, 기존 행의
//              수정·삭제·샤드 파일의 삭제·이름 변경이 드러난다.
//   보장 못 한다  이력 자체를 다시 쓴 경우(amend·rebase·force push). 그것을
//              막으려면 서명이나 외부 anchor가 필요하고, 이 모듈이 아니라
//              event-store의 계약이 정할 일이다.
//
// 증명할 수 없는 상태를 깨끗함으로 보고하지 않는다. Git 조회가 실패하거나
// 기준점이 없으면 그 사실 자체를 진단으로 낸다 — 확인하지 못한 것과 확인해서
// 문제가 없는 것은 다르다.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// 체크섬 재계산 문제는 이 세 원장만의 것이 아니다. 같은 방식으로 기록되는
// 실행 원장 전체를 함께 본다.
const LEDGERS = ['decision', 'delegation', 'approval', 'run', 'verdict', 'driver'];
const FLAT_LEDGERS = ['lease'];

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

// 줄 단위로 접두사인지 본다. 바이트 비교로는 마지막 줄의 개행 유무 같은 차이가
// 위반으로 잡힌다.
function lines(text) {
  return String(text || '').split(/\r?\n/u).filter((line) => line.length > 0);
}

function isPrefix(earlier, later) {
  if (earlier.length > later.length) return false;
  for (let index = 0; index < earlier.length; index += 1) {
    if (earlier[index] !== later[index]) return false;
  }
  return true;
}

function isLedgerShard(relative) {
  if (!relative.endsWith('.jsonl')) return false;
  const segments = relative.split('/');
  const name = segments[segments.length - 1];
  if (segments.length >= 2 && LEDGERS.includes(segments[segments.length - 2])) return true;
  return FLAT_LEDGERS.some((ledger) => name.startsWith(`${ledger}-`));
}

// 이력에 한 번이라도 등장한 샤드를 모두 모은다. 현재 존재하는 파일만 훑으면
// 삭제와 이름 변경이 통째로 빠진다 — 지우면 위반이 사라지는 검사는 검사가 아니다.
function historicalShards(root, eventsRelative) {
  const listed = git(root, ['log', '--pretty=format:', '--name-only', '--diff-filter=AMD', '--', eventsRelative]);
  if (listed.status !== 0) return null;
  const found = new Set();
  for (const line of lines(listed.stdout)) {
    const relative = line.trim();
    if (relative && isLedgerShard(relative)) found.add(relative);
  }
  return Array.from(found).sort();
}

function readAt(root, commit, relative) {
  const shown = git(root, ['show', `${commit}:${relative}`]);
  return shown.status === 0 ? lines(shown.stdout) : null;
}

// 한 샤드의 Git 이력을 훑어 각 시점이 다음 시점의 접두사인지 본다. 마지막으로
// 커밋된 내용은 작업 트리의 접두사여야 한다.
function shardViolations(root, relativeOrAbsolute) {
  const relative = path.isAbsolute(relativeOrAbsolute)
    ? path.relative(root, relativeOrAbsolute).replace(/\\/gu, '/')
    : relativeOrAbsolute;
  const history = git(root, ['log', '--format=%H', '--reverse', '--', relative]);
  if (history.status !== 0) return [];
  const commits = lines(history.stdout);
  const violations = [];
  let previous = null;
  let previousCommit = null;
  for (const commit of commits) {
    const current = readAt(root, commit, relative);
    if (current === null) {
      // 이력에 있던 샤드가 이 커밋에서 사라졌다. 삭제와 이름 변경이 여기로 온다.
      if (previous) {
        violations.push({
          file: relative,
          commit,
          message: `커밋 ${commit.slice(0, 8)}에서 원장 샤드가 삭제되거나 이름이 바뀌었습니다 (이전 ${previous.length}줄).`
        });
      }
      previous = null;
      previousCommit = null;
      continue;
    }
    if (previous && !isPrefix(previous, current)) {
      violations.push({
        file: relative,
        commit,
        message: `커밋 ${commit.slice(0, 8)}에서 기존 이벤트 줄이 바뀌거나 지워졌습니다 (이전 ${previousCommit.slice(0, 8)}: ${previous.length}줄 → ${current.length}줄).`
      });
    }
    previous = current;
    previousCommit = commit;
  }
  if (previous) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) {
      violations.push({
        file: relative,
        commit: null,
        message: `커밋된 원장 샤드가 작업 트리에서 사라졌습니다 (커밋 ${previousCommit.slice(0, 8)}: ${previous.length}줄).`
      });
    } else if (!isPrefix(previous, lines(fs.readFileSync(absolute, 'utf8')))) {
      violations.push({
        file: relative,
        commit: null,
        message: `작업 트리에서 커밋된 이벤트 줄이 바뀌거나 지워졌습니다 (커밋 ${previousCommit.slice(0, 8)}: ${previous.length}줄).`
      });
    }
  }
  return violations;
}

// 공유 원장은 Workspace worktree에 있다. 그 worktree의 Git 이력이 기준점이다.
//
// 확인할 수 없는 경우를 조용히 통과시키지 않는다. 반환값은 위반과 "확인 불가"를
// 함께 담고, 호출자가 둘을 다른 진단으로 낸다.
function appendOnlyReport(root) {
  // 디렉터리가 없다고 먼저 돌아서면 안 된다. 원장을 통째로 지우는 것이 가장 큰
  // 위반인데, 지운 자리를 보고 "볼 것이 없다"고 판정하면 그 위반만 무사통과한다.
  // 무엇이 있었는지는 파일 시스템이 아니라 Git 이력이 안다.
  const workspaceRoot = path.join(root, 'projects', 'workspace');
  // 공유 worktree가 아예 없으면 원장의 과거를 확인할 방법이 없다. 확인하지 못한
  // 것을 조용히 넘기면 검사 통과가 아무것도 뜻하지 않는다.
  if (!fs.existsSync(workspaceRoot)) {
    return { checked: false, reason: '공유 원장 worktree가 없어 append-only를 확인할 수 없습니다.', violations: [], shards: [] };
  }
  const inside = git(workspaceRoot, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0) {
    return { checked: false, reason: '공유 원장이 Git 작업 트리 안에 없어 append-only를 확인할 수 없습니다.', violations: [], shards: [] };
  }
  const head = git(workspaceRoot, ['rev-parse', 'HEAD']);
  if (head.status !== 0) {
    // 커밋이 없으면 비교할 기준점이 없다. 다만 원장이 실제로 있는데 기준점이
    // 없는 것과, 아직 아무것도 없는 것은 다르다 — 전자만 진단한다.
    const eventsRoot = path.join(workspaceRoot, 'events');
    if (!fs.existsSync(eventsRoot)) return { checked: false, reason: null, violations: [], shards: [] };
    return { checked: false, reason: '공유 원장 worktree에 커밋이 없어 비교할 기준점이 없습니다.', violations: [], shards: [] };
  }
  // 얕은 복제는 과거를 가지고 있지 않다. 볼 수 없는 이력을 "위반 없음"으로
  // 읽으면, 잘라낸 구간의 변조가 전부 무사통과한다 — 가장 조용한 실패다.
  const shallow = git(workspaceRoot, ['rev-parse', '--is-shallow-repository']);
  if (shallow.status === 0 && String(shallow.stdout || '').trim() === 'true') {
    return { checked: false, reason: '얕은 복제라 과거 이력을 볼 수 없어 append-only를 확인할 수 없습니다.', violations: [], shards: [] };
  }
  // grafted 커밋이 있으면 그 지점 이전은 잘려 있다. shallow 플래그가 없어도
  // 같은 상태이므로 함께 본다.
  const grafted = git(workspaceRoot, ['log', '--format=%H %D', '-1', '--all']);
  if (grafted.status === 0 && /\bgrafted\b/u.test(grafted.stdout || '')) {
    return { checked: false, reason: '이력이 잘려 있어(grafted) append-only를 확인할 수 없습니다.', violations: [], shards: [] };
  }
  const shards = historicalShards(workspaceRoot, 'events');
  if (shards === null) {
    return { checked: false, reason: 'Git 이력을 조회할 수 없어 append-only를 확인할 수 없습니다.', violations: [], shards: [] };
  }
  const violations = [];
  for (const shard of shards) violations.push(...shardViolations(workspaceRoot, shard));
  return { checked: true, reason: null, violations, shards };
}

function appendOnlyViolations(root) {
  return appendOnlyReport(root).violations;
}

module.exports = { appendOnlyReport, appendOnlyViolations, shardViolations, historicalShards, isLedgerShard, isPrefix, LEDGERS };
