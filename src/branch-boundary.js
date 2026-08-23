'use strict';

const fs = require('fs');
const path = require('path');
const { runGit, gitRoot } = require('./git');
const { workspaceLayout } = require('./workspace');

const HOOK_MARKER = '# RUNDOL-MANAGED-BRANCH-BOUNDARY v1';
const USER_HOOK_NAME = 'pre-push.rundol-user';

function normalized(value) {
  const resolved = path.resolve(value);
  const canonical = fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved;
  return canonical.replace(/[\\/]+$/u, '').toLowerCase();
}

function samePath(left, right) {
  return normalized(left) === normalized(right);
}

function currentBranch(root) {
  const symbolic = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, allowFailure: true });
  if (symbolic.status === 0 && symbolic.stdout) return symbolic.stdout;
  const fallback = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, allowFailure: true });
  return fallback.status === 0 && fallback.stdout && fallback.stdout !== 'HEAD' ? fallback.stdout : null;
}

function primaryBranch(root, remote) {
  const remoteName = remote || 'origin';
  const symbolic = runGit(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remoteName}/HEAD`], { cwd: root, allowFailure: true });
  if (symbolic.status === 0 && symbolic.stdout.startsWith(`${remoteName}/`)) return symbolic.stdout.slice(remoteName.length + 1);
  return currentBranch(root);
}

function worktrees(root) {
  const output = runGit(['worktree', 'list', '--porcelain'], { cwd: root }).stdout;
  if (!output) return [];
  return output.split(/\r?\n\r?\n/u).filter(Boolean).map((block) => {
    const lines = block.split(/\r?\n/u);
    const worktree = lines.find((line) => line.startsWith('worktree '));
    const branch = lines.find((line) => line.startsWith('branch '));
    return {
      path: worktree ? path.resolve(worktree.slice(9).trim()) : null,
      branch: branch ? branch.slice('branch refs/heads/'.length).trim() : null,
      detached: lines.includes('detached')
    };
  });
}

function hookPath(root) {
  const resolved = runGit(['rev-parse', '--git-path', 'hooks/pre-push'], { cwd: root }).stdout;
  return path.isAbsolute(resolved) ? resolved : path.resolve(root, resolved);
}

function hookStatus(root) {
  const file = hookPath(root);
  if (!fs.existsSync(file)) return { file, status: 'missing', managed: false, preserved: false };
  const source = fs.readFileSync(file, 'utf8');
  return {
    file,
    status: source.includes(HOOK_MARKER) ? 'installed' : 'unmanaged',
    managed: source.includes(HOOK_MARKER),
    preserved: fs.existsSync(path.join(path.dirname(file), USER_HOOK_NAME))
  };
}

function expectedRoles(root, projectKey, remote) {
  const layout = workspaceLayout(root);
  const codeBranch = currentBranch(layout.root);
  const defaultBranch = primaryBranch(layout.root, remote);
  return [{ role: 'code', project: null, branch: codeBranch, defaultBranch, worktree: layout.root }]
    .concat(layout.schemaVersion >= 6 ? [{ role: 'workspace', project: null, branch: 'rundol/workspace', worktree: path.join(layout.root, 'projects', 'workspace') }] : [])
    .concat(layout.projects.filter((project) => !projectKey || project.key === projectKey).map((project) => ({ role: 'project', project: project.key, branch: project.branch, worktree: project.root })));
}

function branchBoundaryStatus(start, options) {
  const root = workspaceLayout(start || process.cwd()).root;
  const actual = worktrees(root);
  const roles = expectedRoles(root, options && options.project, options && options.remote);
  const violations = [];
  if (roles[0] && /^rundol\//u.test(roles[0].branch || '')) violations.push({ code: 'RDL-BRANCH-005', role: 'code', actualBranch: roles[0].branch, message: '저장소 루트에는 Rundol 전용 브랜치를 체크아웃할 수 없습니다.' });
  for (const role of roles) {
    if (!role.branch) {
      violations.push({ code: 'RDL-BRANCH-001', role: role.role, project: role.project, message: '브랜치 이름을 식별할 수 없습니다.' });
      continue;
    }
    const match = actual.find((item) => item.path && samePath(item.path, role.worktree));
    if (!match) {
      violations.push({ code: 'RDL-BRANCH-002', role: role.role, project: role.project, expectedBranch: role.branch, expectedWorktree: role.worktree, message: '필수 worktree가 연결되지 않았습니다.' });
    } else if (match.branch !== role.branch) {
      violations.push({ code: 'RDL-BRANCH-003', role: role.role, project: role.project, expectedBranch: role.branch, actualBranch: match.branch, worktree: role.worktree, message: 'worktree가 잘못된 브랜치에 연결되어 있습니다.' });
    }
  }
  const hook = hookStatus(root);
  // 커밋 경계도 함께 답한다. 미는 자리만 보면 담는 자리가 열려 있어도 초록이 된다.
  const commitHooks = require('./commit-boundary').commitBoundaryStatus(root);
  for (const item of commitHooks.filter((entry) => !entry.managed)) {
    violations.push({ code: 'RDL-BRANCH-006', role: 'commit', message: item.status === 'missing' ? `Rundol ${item.name} 경계가 설치되지 않았습니다.` : `관리되지 않는 ${item.name} hook이 경계 설치를 막고 있습니다.`, hook: item.file });
  }
  if (!hook.managed) violations.push({ code: 'RDL-BRANCH-004', role: 'push', message: hook.status === 'missing' ? 'Rundol pre-push 경계가 설치되지 않았습니다.' : '관리되지 않는 pre-push hook이 경계 설치를 막고 있습니다.', hook: hook.file });
  return { root, valid: violations.length === 0, primaryBranch: roles[0] && roles[0].defaultBranch, currentCodeBranch: roles[0] && roles[0].branch, pushDefault: runGit(['config', '--local', '--get', 'push.default'], { cwd: root, allowFailure: true }).stdout || null, hook, commitHooks, roles, worktrees: actual, violations };
}

function validatePushLines(source, options) {
  const settings = options || {};
  const violations = [];
  const lines = String(source || '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const fields = line.split(/\s+/u);
    if (fields.length < 4) {
      violations.push({ code: 'RDL-PUSH-001', line, message: 'Git pre-push 입력 형식을 해석할 수 없습니다.' });
      continue;
    }
    const [localRef, localSha, remoteRef] = fields;
    const deletion = localRef === '(delete)' || /^0+$/u.test(localSha);
    if (deletion && settings.allowDelete !== true) {
      violations.push({ code: 'RDL-PUSH-002', localRef, remoteRef, message: '브랜치 삭제 push는 기본적으로 차단됩니다.' });
      continue;
    }
    if (!deletion && localRef !== remoteRef) {
      violations.push({ code: 'RDL-PUSH-003', localRef, remoteRef, message: '로컬 ref와 원격 ref가 다른 교차 push는 허용되지 않습니다.' });
    }
  }
  return { valid: violations.length === 0, violations };
}

function renderHook() {
  return `#!/bin/sh
set -eu
${HOOK_MARKER}
hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
input_file="${'${TMPDIR:-/tmp}'}/rundol-pre-push-$$"
trap 'rm -f "$input_file"' EXIT HUP INT TERM
cat > "$input_file"
user_hook="$hook_dir/${USER_HOOK_NAME}"
if [ -x "$user_hook" ]; then
  "$user_hook" "$@" < "$input_file"
fi
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -n "${'${local_ref:-}'}" ] || continue
  if [ "$local_ref" = "(delete)" ] || printf '%s' "$local_sha" | grep -Eq '^0+$'; then
    if [ "${'${RUNDOL_ALLOW_DELETE:-0}'}" != "1" ]; then
      echo "rdl: branch deletion push blocked: $remote_ref" >&2
      exit 1
    fi
    continue
  fi
  if [ "$local_ref" != "$remote_ref" ]; then
    echo "rdl: cross-branch push blocked: $local_ref -> $remote_ref" >&2
    echo "rdl: use the matching worktree and 'rdl sync' for Rundol branches." >&2
    exit 1
  fi
done < "$input_file"
`;
}

function installHook(root) {
  const file = hookPath(root);
  const directory = path.dirname(file);
  const userHook = path.join(directory, USER_HOOK_NAME);
  fs.mkdirSync(directory, { recursive: true });
  let preserved = false;
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, 'utf8');
    if (!current.includes(HOOK_MARKER)) {
      if (fs.existsSync(userHook)) throw new Error(`기존 pre-push hook과 Rundol 보존본이 함께 존재합니다. 수동 병합이 필요합니다: ${file}`);
      fs.renameSync(file, userHook);
      preserved = true;
    }
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, renderHook(), 'utf8');
  fs.chmodSync(temporary, 0o755);
  fs.renameSync(temporary, file);
  return { file, status: 'installed', managed: true, preserved: preserved || fs.existsSync(userHook), userHook: fs.existsSync(userHook) ? userHook : null };
}

function configurePush(root, remote, roles) {
  runGit(['config', '--local', 'push.default', 'simple'], { cwd: root });
  const remotes = runGit(['remote'], { cwd: root }).stdout.split(/\r?\n/u).filter(Boolean);
  if (!remotes.includes(remote)) return;
  for (const role of roles.filter((item) => item.role !== 'code')) {
    runGit(['config', '--local', `branch.${role.branch}.remote`, remote], { cwd: root });
    runGit(['config', '--local', `branch.${role.branch}.merge`, `refs/heads/${role.branch}`], { cwd: root });
  }
}

function installBranchBoundary(start, options) {
  const settings = options || {};
  const root = workspaceLayout(start || process.cwd()).root;
  const roles = expectedRoles(root, settings.project, settings.remote);
  const hook = installHook(root);
  configurePush(root, settings.remote || 'origin', roles);
  return Object.assign(branchBoundaryStatus(root, settings), { hook });
}

function assertWorktreeBoundary(input) {
  const root = path.resolve(gitRoot(input.root));
  const actualRoot = path.resolve(gitRoot(input.worktree));
  const branch = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: input.worktree, allowFailure: true }).stdout || null;
  if (!samePath(actualRoot, input.worktree)) throw new Error(`Rundol ${input.role || '작업'} worktree 경계 위반: ${input.worktree}`);
  if (branch !== input.branch) throw new Error(`Rundol ${input.role || '작업'} 브랜치 경계 위반: ${branch || '(detached)'} != ${input.branch}`);
  if (input.canonical !== false) {
    const expected = input.role === 'workspace' ? path.join(root, 'projects', 'workspace') : input.role === 'project' ? path.join(root, 'projects', input.project) : root;
    if (!samePath(input.worktree, expected)) throw new Error(`Rundol ${input.role || '작업'} 경로 경계 위반: ${input.worktree} != ${expected}`);
  }
  // 미는 경계만 세우고 담는 경계를 두면 반쪽이다. 두 훅은 같은 결정의 두 자리이므로
  // 함께 선다 — 하나만 서 있는 상태를 사람이 알아채기를 기대하지 않는다.
  const commit = require('./commit-boundary').installCommitBoundary(root);
  return { commitHooks: commit, root, role: input.role, project: input.project || null, branch, worktree: actualRoot };
}

module.exports = { HOOK_MARKER, USER_HOOK_NAME, currentBranch, primaryBranch, worktrees, hookStatus, branchBoundaryStatus, validatePushLines, installBranchBoundary, assertWorktreeBoundary };
