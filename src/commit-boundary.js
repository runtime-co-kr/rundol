'use strict';

// 커밋 시점의 경계. pre-push가 밀 때를 지키듯 여기는 담을 때를 지킨다.
//
// 클라이언트 훅과 층이 다른 이유는 구멍의 모양 때문이다. PreToolUse와 Stop은 AI
// 클라이언트 안에서만 돌고 disableAllHooks 한 줄로 꺼진다. 사람이 터미널에서 치는
// 커밋에는 아무것도 걸리지 않으므로, 그 통제에는 사람 모양의 구멍이 남는다. 사람
// 워커와 에이전트 워커가 같은 계층이라면 같은 경계를 지나야 한다.
//
// 두 훅으로 나눈 것은 필요한 값이 다르기 때문이다. 브랜치와 경로는 커밋 메시지 없이
// 판정할 수 있어 pre-commit이 보고, 결박 트레일러는 메시지가 있어야 하므로 commit-msg가
// 본다. 한 훅에 몰면 막힌 이유가 브랜치인지 트레일러인지 사유 한 줄로는 갈리지 않는다.
//
// 우회는 열려 있다. --no-verify가 있고 막을 생각도 없다 — 여기서 하려는 것은 손을
// 묶는 것이 아니라 기본값을 바꾸는 일이다. 지금은 우회가 기본이고 규칙이 예외인데,
// 그 방향을 뒤집으면 규칙을 벗어나는 것이 매번 선택이 된다.

const fs = require('fs');
const path = require('path');
const { runGit } = require('./git');
const { CODE_PATH_PREFIXES, COMMIT_BOUNDARY_HOOKS: HOOKS } = require('./vocabulary');

const MARKER = '# RUNDOL-MANAGED-COMMIT-BOUNDARY v1';

function hookFile(root, name) {
  const resolved = runGit(['rev-parse', '--git-path', `hooks/${name}`], { cwd: root }).stdout;
  return path.isAbsolute(resolved) ? resolved : path.resolve(root, resolved);
}

function userHookFile(root, name) {
  return path.join(path.dirname(hookFile(root, name)), `${name}.rundol-user`);
}

// 셸이 읽을 경로 패턴. 목록은 vocabulary가 소유하므로 훅 본문이 그 사본을 들지 않는다.
function codePattern() {
  return `^(${CODE_PATH_PREFIXES.map((prefix) => prefix.replace(/\/$/u, '')).join('|')})/`;
}

// 기본 코드 브랜치는 origin/HEAD에서 읽는다. 없으면 판정하지 않는다 — 추측해서 막으면
// 그 추측이 틀린 저장소에서 아무 커밋도 할 수 없게 된다.
function renderPreCommit() {
  return `#!/bin/sh
set -eu
${MARKER}
hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
user_hook="$hook_dir/pre-commit.rundol-user"
if [ -x "$user_hook" ]; then "$user_hook" "$@"; fi

branch=$(git symbolic-ref --quiet --short HEAD || echo '')
[ -n "$branch" ] || exit 0
default_ref=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD || echo '')
[ -n "$default_ref" ] || exit 0
default=\${default_ref#*/}
[ "$branch" = "$default" ] || exit 0

if git diff --cached --name-only | grep -Eq '${codePattern()}'; then
  echo "rdl: 제품 코드는 $default에 직접 커밋하지 않습니다." >&2
  echo "rdl: 세션 작업 공간을 열고 그 안에서 커밋하세요." >&2
  echo "rdl:   rdl session start" >&2
  exit 1
fi
exit 0
`;
}

// 결박은 커밋 자신이 답한다. 트레일러가 없으면 나중에 어느 일이었는지가 추측이 된다.
// none과 사유는 통과시킨다 — 우회를 막으면 결박은 요금이 되고, 요금을 무는 통제는
// 우회된다. 사유가 남으면 그것은 우회가 아니라 기록이다.
function renderCommitMsg() {
  return `#!/bin/sh
set -eu
${MARKER}
hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
user_hook="$hook_dir/commit-msg.rundol-user"
if [ -x "$user_hook" ]; then "$user_hook" "$@"; fi

message_file="\$1"
[ -f "$message_file" ] || exit 0

# 병합과 되돌리기, 고쳐담기는 사람이 새로 쓴 일이 아니므로 결박을 묻지 않는다.
head_line=$(head -n 1 "$message_file")
case "$head_line" in
  "Merge "*|"Revert "*|"fixup!"*|"squash!"*) exit 0 ;;
esac

git diff --cached --name-only | grep -Eq '${codePattern()}' || exit 0

# && 로 쓰면 set -e가 grep 실패에서 바로 끝내 아래 안내가 나오지 않는다. 막는 것보다
# 다음에 무엇을 할지 말하는 것이 이 훅이 하는 일의 절반이다.
if grep -Eq '^Rundol-Task:[[:space:]]*[^[:space:]]' "$message_file"; then exit 0; fi

echo "rdl: 제품 코드 커밋은 어느 태스크의 일인지 밝혀야 합니다." >&2
echo "rdl:   git commit --trailer 'Rundol-Task: <TASK-ID>'" >&2
echo "rdl:   또는 --trailer 'Rundol-Task: none' --trailer 'Rundol-Task-Reason: <사유>'" >&2
exit 1
`;
}

const RENDER = { 'pre-commit': renderPreCommit, 'commit-msg': renderCommitMsg };

function statusOf(root, name) {
  const file = hookFile(root, name);
  if (!fs.existsSync(file)) return { name, file, status: 'missing', managed: false, preserved: false };
  const source = fs.readFileSync(file, 'utf8');
  return {
    name,
    file,
    status: source.includes(MARKER) ? 'installed' : 'unmanaged',
    managed: source.includes(MARKER),
    preserved: fs.existsSync(userHookFile(root, name))
  };
}

/** 두 훅의 설치 상태. 하나만 서 있으면 경계는 반쪽이므로 각각 답한다. */
function commitBoundaryStatus(root) {
  return HOOKS.map((name) => statusOf(root, name));
}

// 기존 훅은 잃지 않는다. 사용자가 걸어 둔 것을 지우고 우리 것을 놓으면, 경계를 세우는
// 일이 남의 통제를 없애는 일이 된다. 보존본을 먼저 실행하므로 순서도 지킨다.
function installOne(root, name) {
  const file = hookFile(root, name);
  const preservedFile = userHookFile(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let preserved = false;
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, 'utf8');
    if (!current.includes(MARKER)) {
      if (fs.existsSync(preservedFile)) throw new Error(`기존 ${name} hook과 Rundol 보존본이 함께 존재합니다. 수동 병합이 필요합니다: ${file}`);
      fs.renameSync(file, preservedFile);
      preserved = true;
    }
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, RENDER[name](), 'utf8');
  fs.chmodSync(temporary, 0o755);
  fs.renameSync(temporary, file);
  return { name, file, status: 'installed', managed: true, preserved: preserved || fs.existsSync(preservedFile), userHook: fs.existsSync(preservedFile) ? preservedFile : null };
}

function installCommitBoundary(root) {
  return HOOKS.map((name) => installOne(root, name));
}

module.exports = { MARKER, HOOKS, commitBoundaryStatus, installCommitBoundary, hookFile, userHookFile };
