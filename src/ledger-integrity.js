'use strict';

// 원장의 append-only 강제.
//
// canonicalDigest는 서명이 아니라 누구나 다시 계산할 수 있는 체크섬이다. 기존
// 행의 값을 고치고 다이제스트를 새로 계산하면 파일 안에는 변형 하나만 남고,
// "같은 eventId에 다른 다이제스트"라는 상충 검출은 두 사본이 함께 있을 때만
// 작동하므로 아무것도 잡지 못한다. 실제로 취소 뒤의 답변을 취소 전 시각으로
// 다시 써 넣자 진단 없이 채택됐다.
//
// 그래서 파일 자체가 덧붙여지기만 했는지를 확인해야 하고, 그 판정에는 이 저장소
// 밖의 기준점이 필요하다. Rundol에는 이미 그 기준점이 있다 — Git이다. 커밋된
// 내용은 나중에 바꿔도 그 이력이 남으므로, 어떤 시점의 샤드 내용이 다음 시점의
// 접두사인지만 보면 기존 행의 수정과 삭제가 드러난다.
//
// 이 검사는 위조를 막지 못한다. 드러낼 뿐이다. 그것이 append-only 원장에서
// 기대할 수 있는 성질이고, 막으려면 서명이나 외부 anchor가 필요하다 — 그것은
// 이 모듈이 아니라 event-store의 계약이 정할 일이다.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LEDGERS = ['decision', 'delegation', 'approval'];

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

function shardFiles(eventsRoot) {
  const found = [];
  for (const ledger of LEDGERS) {
    const directory = path.join(eventsRoot, ledger);
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      if (name.endsWith('.jsonl')) found.push(path.join(directory, name));
    }
  }
  return found.sort();
}

// 한 샤드의 Git 이력을 훑어 각 시점이 다음 시점의 접두사인지 본다. 마지막으로
// 커밋된 내용은 작업 트리의 접두사여야 한다.
function shardViolations(root, absolute) {
  const relative = path.relative(root, absolute).replace(/\\/gu, '/');
  const history = git(root, ['log', '--format=%H', '--reverse', '--', relative]);
  if (history.status !== 0) return [];
  const commits = lines(history.stdout);
  const violations = [];
  let previous = null;
  let previousCommit = null;
  for (const commit of commits) {
    const shown = git(root, ['show', `${commit}:${relative}`]);
    if (shown.status !== 0) continue;
    const current = lines(shown.stdout);
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
    const working = lines(fs.readFileSync(absolute, 'utf8'));
    if (!isPrefix(previous, working)) {
      violations.push({
        file: relative,
        commit: null,
        message: `작업 트리에서 커밋된 이벤트 줄이 바뀌거나 지워졌습니다 (커밋 ${previousCommit.slice(0, 8)}: ${previous.length}줄 → 현재 ${working.length}줄).`
      });
    }
  }
  return violations;
}

// 공유 원장은 Workspace worktree에 있다. 그 worktree의 Git 이력이 기준점이다.
function appendOnlyViolations(root) {
  const eventsRoot = path.join(root, 'projects', 'workspace', 'events');
  if (!fs.existsSync(eventsRoot)) return [];
  const workspaceRoot = path.join(root, 'projects', 'workspace');
  const inside = git(workspaceRoot, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0) return [];
  const violations = [];
  for (const shard of shardFiles(eventsRoot)) violations.push(...shardViolations(workspaceRoot, shard));
  return violations;
}

module.exports = { appendOnlyViolations, shardViolations, isPrefix, LEDGERS };
