'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findWorkspaceRoot } = require('./workspace');
const { skillSource, skillTargets, SKILL_NAME } = require('./skill');
const { loadHarnessSettings } = require('./harness-settings');
const { probeAdapter } = require('./adapter');
const { loadWorkflows } = require('./workflow-config');
const { TASK_STATES } = require('./vocabulary');

// doctor가 통과라고 하는데 실행이 깨지면 진단이 거짓말이 된다. package.json을 런타임에
// 읽으면 설치 레이아웃마다 상대 경로가 달라 깨지므로 값을 여기 두고, engines와 같은지는
// 테스트가 지킨다. 둘이 어긋나면 배포 전에 잡힌다.
const NODE_FLOOR = 20;

const PACKAGE_ROOT = path.resolve(__dirname, '..');

function run(command, args, options) {
  const result = spawnSync(command, args || [], Object.assign({ encoding: 'utf8', windowsHide: true }, options || {}));
  return {
    status: result.status,
    error: result.error ? result.error.message : null,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim()
  };
}

function major(version) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
  return match ? Number.parseInt(match[1], 10) : null;
}

function atLeast(version, minimum) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version || ''));
  if (!match) return false;
  const current = [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

function sanitize(value) {
  return String(value || '')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1***@')
    .replace(/\b(?:glpat|ghp|github_pat)-?[A-Za-z0-9_-]+\b/gu, '***');
}

function sanitizeAdapterValue(value) {
  const home = os.homedir();
  return sanitize(value).replaceAll(home, '<home>').replace(/[\r\n]+/gu, ' ').slice(0, 300);
}

function executableCandidates(name) {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').concat([''])
    : [''];
  const directories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const result = [];
  for (const directory of directories) {
    for (const extension of extensions) {
      const file = path.join(directory.replace(/^"|"$/g, ''), `${name}${extension.toLowerCase()}`);
      if (fs.existsSync(file)) result.push(path.resolve(file));
      const upper = path.join(directory.replace(/^"|"$/g, ''), `${name}${extension.toUpperCase()}`);
      if (upper !== file && fs.existsSync(upper)) result.push(path.resolve(upper));
    }
  }
  const seen = new Set();
  return result.filter((file) => {
    const key = process.platform === 'win32' ? file.toLowerCase() : file;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function classifyGitFailure(output) {
  const text = String(output || '');
  if (/authentication failed|access denied|could not read username|terminal prompts disabled|401|403|permission denied \(publickey/i.test(text)) return 'authentication';
  if (/http\/2|stream \d+ was reset|curl 56|connection reset|unexpected disconnect/i.test(text)) return 'http-reset';
  if (/could not resolve host|name or service not known|temporary failure in name resolution/i.test(text)) return 'dns';
  if (/certificate|ssl|tls/i.test(text)) return 'tls';
  if (/repository not found|not found|does not appear to be a git repository/i.test(text)) return 'not-found';
  return 'git-remote';
}

function remoteCheck(url) {
  const environment = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' });
  const first = run('git', ['ls-remote', '--heads', url], { env: environment, timeout: 30000 });
  if (first.status === 0) return { id: 'git-remote', status: 'ok', message: 'Git 원격에 접근할 수 있습니다.', url: sanitize(url), transport: 'default' };
  const detail = sanitize(`${first.stderr}\n${first.stdout}\n${first.error || ''}`.trim());
  const kind = classifyGitFailure(detail);
  if (kind === 'http-reset') {
    const fallback = run('git', ['-c', 'http.version=HTTP/1.1', 'ls-remote', '--heads', url], { env: environment, timeout: 30000 });
    if (fallback.status === 0) return { id: 'git-remote', status: 'warn', message: '기본 Git 전송은 reset됐지만 HTTP/1.1 fallback은 성공했습니다.', kind, url: sanitize(url), remediation: '설치 명령에 일시적인 Git http.version=HTTP/1.1 설정을 적용하세요.' };
  }
  const remediation = {
    authentication: 'HTTPS는 PAT/Git Credential Manager, SSH는 등록된 공개키와 접근 권한을 확인하세요.',
    'http-reset': '명령 범위에서 Git http.version=HTTP/1.1을 적용한 뒤 다시 시도하세요.',
    dns: '호스트명, VPN, DNS와 프록시 연결을 확인하세요.',
    tls: '서버 인증서 체인과 사내 CA 설정을 확인하세요. SSL 검증을 끄지 마세요.',
    'not-found': '저장소 URL, namespace와 읽기 권한을 확인하세요.',
    'git-remote': '상세 Git 오류를 확인하고 같은 URL로 git ls-remote를 재현하세요.'
  }[kind];
  return { id: 'git-remote', status: 'error', message: 'Git 원격 접근에 실패했습니다.', kind, url: sanitize(url), detail, remediation };
}

function doctor(start, options) {
  const settings = options || {};
  const checks = [];
  const nodeMajor = major(process.version);
  checks.push({ id: 'node', status: nodeMajor >= NODE_FLOOR ? 'ok' : 'error', message: `Node.js ${process.version}`, required: `>=${NODE_FLOOR}` });

  const npm = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { shell: process.platform === 'win32' });
  const npmOk = npm.status === 0 && atLeast(npm.stdout, [6, 0, 0]);
  checks.push({ id: 'npm', status: npmOk ? 'ok' : 'error', message: npm.status === 0 ? `npm ${npm.stdout}` : 'npm을 실행할 수 없습니다.', required: '>=6', remediation: npmOk ? undefined : 'Node.js 공식 배포판 또는 패키지 관리자로 npm 6 이상을 설치하세요.' });

  const git = run('git', ['--version']);
  const gitOk = git.status === 0 && atLeast(git.stdout, [2, 20, 0]);
  checks.push({ id: 'git', status: gitOk ? 'ok' : 'error', message: git.status === 0 ? git.stdout : 'Git을 실행할 수 없습니다.', required: '>=2.20', remediation: gitOk ? undefined : 'Git 2.20 이상을 설치하고 새 터미널에서 PATH를 다시 확인하세요.' });

  const requiredFiles = ['package.json', 'bin/rdl.js', 'src/check.js', 'src/workspace.js', 'src/skill.js', 'src/doctor.js', `skills/${SKILL_NAME}/SKILL.md`];
  const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(PACKAGE_ROOT, file)));
  checks.push({ id: 'package', status: missing.length ? 'error' : 'ok', message: missing.length ? `패키지 필수 파일이 없습니다: ${missing.join(', ')}` : `Rundol 패키지 ${PACKAGE_ROOT}`, remediation: missing.length ? '깨진 전역 패키지를 제거하고 clean install 절차로 재설치하세요.' : undefined });

  let packageJson = null;
  try { packageJson = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')); } catch (_) {}
  const postinstall = packageJson && packageJson.scripts && packageJson.scripts.postinstall;
  checks.push({ id: 'postinstall', status: postinstall ? 'error' : 'ok', message: postinstall ? '핵심 설치를 막을 수 있는 postinstall이 선언돼 있습니다.' : '핵심 CLI 설치와 스킬 설치가 분리돼 있습니다.', remediation: postinstall ? 'postinstall을 제거하고 rdl skill install을 명시적으로 실행하세요.' : undefined });

  const commands = executableCandidates('rdl').concat(executableCandidates('rundol'));
  checks.push({ id: 'path', status: commands.length ? 'ok' : 'warn', message: commands.length ? `PATH에서 CLI ${commands.length}개를 찾았습니다.` : '현재 PATH에서 rdl 또는 rundol 실행 파일을 찾지 못했습니다.', commands, remediation: commands.length ? undefined : 'npm prefix -g의 실행 파일 경로를 PATH에 추가하고 터미널을 다시 여세요.' });

  const sourceSkill = path.join(skillSource(), 'SKILL.md');
  const sourceHash = fs.existsSync(sourceSkill) ? fileHash(sourceSkill) : null;
  const skillStates = skillTargets().map((target) => {
    const file = path.join(target.root, SKILL_NAME, 'SKILL.md');
    const marker = path.join(target.root, SKILL_NAME, '.rundol-managed.json');
    if (!fs.existsSync(file)) return { client: target.client, status: 'missing', path: file };
    if (!fs.existsSync(marker)) return { client: target.client, status: 'unmanaged', path: file };
    return { client: target.client, status: sourceHash === fileHash(file) ? 'current' : 'stale', path: file };
  });
  const staleSkills = skillStates.filter((item) => item.status !== 'current');
  checks.push({ id: 'skills', status: staleSkills.length ? 'warn' : 'ok', message: staleSkills.length ? '누락·구버전 또는 사용자 관리 스킬이 있습니다.' : '관리되는 AI 클라이언트 스킬이 최신입니다.', targets: skillStates, remediation: staleSkills.length ? 'rdl skill install을 실행하세요. 사용자 관리 디렉터리를 교체할 때만 --force를 사용하세요.' : undefined });

  let workspace = null;
  try {
    workspace = findWorkspaceRoot(start || process.cwd());
    checks.push({ id: 'workspace', status: 'ok', message: `Rundol Workspace ${workspace}` });
  } catch (error) {
    checks.push({ id: 'workspace', status: 'info', message: '현재 위치는 Rundol Workspace가 아닙니다.' });
  }


  if (workspace) {
    // 흐름 설정과 저장된 상태 어휘가 맞는지 본다. 설정을 고칠 때 나는 이슈라
    // 여기서 잡는다 — 노드를 없애면 그 자리에 서 있던 태스크가 갈 곳을 잃는데,
    // 저장 게이트는 앞으로 들어올 것만 막고 이미 있는 것은 보지 않는다.
    try {
      const config = loadWorkflows(workspace, settings.project || null);
      const ids = Object.keys(config.workflows || {});
      if (!ids.length) {
        checks.push({ id: 'workflows', status: 'info', message: '흐름 설정이 없어 내장 워크플로로 돕니다.', remediation: 'projects/<key>/workflows.json에 노드와 전환을 적으면 그때부터 이 프로젝트의 흐름이 됩니다.' });
      } else {
        const closed = ids.filter((id) => Array.isArray(config.workflows[id].transitions));
        const stranded = [];
        for (const id of ids) {
          const entry = config.workflows[id];
          if (entry.targetKind !== 'task') continue;
          for (const state of TASK_STATES) {
            if (!entry.nodes[state]) stranded.push(`${id}: ${state}`);
          }
        }
        checks.push({ id: 'workflows', status: 'ok', message: `흐름 ${ids.length}개 · 전환을 선언한 것 ${closed.length}개`, workflows: ids, sources: (config.sources || []).map((item) => item.file) });
        if (stranded.length) {
          checks.push({
            id: 'workflow-nodes',
            status: 'warn',
            message: `저장된 상태에 설 노드가 없는 흐름이 있습니다: ${stranded.join(', ')}`,
            stranded,
            remediation: '그 상태의 노드를 workflows.json에 세우거나, 그 상태로 저장된 태스크를 먼저 다른 노드로 옮기세요. 노드가 없는 상태의 태스크는 어느 목록에도 들지 않습니다.'
          });
        } else {
          checks.push({ id: 'workflow-nodes', status: 'ok', message: '저장된 상태 어휘가 모두 흐름의 노드에 섭니다.' });
        }
      }
    } catch (error) {
      checks.push({ id: 'workflows', status: 'error', message: error.message, remediation: '설정 파일의 그 줄을 고치거나 지우세요. 파일이 없으면 내장 흐름으로 돕니다.' });
    }

    try {
      const harness = loadHarnessSettings(workspace, { project: settings.project });
      for (const [name, adapter] of Object.entries(harness.runtimeResolved.adapters).sort(([left], [right]) => left.localeCompare(right))) {
        if (adapter.enabled !== true) {
          checks.push({ id: `adapter:${name}`, status: 'info', message: `Adapter ${name} is disabled.` });
          continue;
        }
        try {
          const probe = probeAdapter(adapter, { cwd: workspace, timeout: settings.adapterProbeTimeout || 5000 });
          const ok = probe.status === 0;
          checks.push({
            id: `adapter:${name}`,
            status: ok ? 'ok' : 'error',
            message: ok ? `Adapter ${name}: ${sanitizeAdapterValue(probe.version || path.basename(probe.executable))}` : `Adapter ${name} --version probe failed.`,
            executable: path.basename(probe.executable),
            remediation: ok ? undefined : `Check the executable and bounded --version behavior for adapter ${name}.`
          });
        } catch (error) {
          checks.push({ id: `adapter:${name}`, status: 'error', message: `Adapter ${name} executable is unavailable.`, detail: sanitizeAdapterValue(error.message), remediation: `Install or correct the configured executable for adapter ${name}.` });
        }
      }
    } catch (error) {
      checks.push({ id: 'harness-settings', status: 'error', message: 'Harness adapter settings are invalid.', detail: sanitizeAdapterValue(error.message), remediation: 'Correct harness.json before running an adapter.' });
    }
  }

  if (settings.gitUrl) checks.push(remoteCheck(settings.gitUrl));
  const summary = {
    ok: checks.filter((item) => item.status === 'ok').length,
    warnings: checks.filter((item) => item.status === 'warn').length,
    errors: checks.filter((item) => item.status === 'error').length,
    info: checks.filter((item) => item.status === 'info').length
  };
  return { version: packageJson ? packageJson.version : null, platform: process.platform, arch: process.arch, home: os.homedir(), packageRoot: PACKAGE_ROOT, checks, summary };
}

module.exports = { doctor, classifyGitFailure, executableCandidates };
