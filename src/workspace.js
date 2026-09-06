'use strict';

const fs = require('fs');
const path = require('path');
const { runtimeHome, runtimeWorkspace } = require('./runtime');
const { gitRoot } = require('./git');

// runtimeWorkspace가 가리킬 수 있는 manifest는 $RUNDOL_HOME/workspaces/<id>/workspace.yaml
// 하나의 모양뿐이고 <id>는 언제나 sha256 앞 16자리다.
const RUNTIME_WORKSPACE_ID = /^[a-f0-9]{16}$/u;

// 런타임 manifest가 하나라도 있는지 먼저 본다. 없으면 id를 계산할 이유가 없다.
//
// id를 알려면 저장소 신원을 물어야 하고 그것은 git 프로세스 둘이다 —
// rev-parse --show-toplevel과 remote get-url. 그런데 workspaces/ 아래에
// workspace.yaml이 하나도 없으면 어떤 저장소를 물어도 답은 null이다. 계산해 봐야
// 없는 파일을 가리킨다.
//
// 이 확인이 없으면 findWorkspaceRoot가 위로 거슬러 오르며 못 찾은 층마다 그 왕복을
// 한다. 깊이만큼 곱해져서, 실측으로 워크스페이스 루트에서 6ms인 workspaceLayout이
// 프로젝트 worktree 안에서 2.0초, 문서 경로에서 4.2초였다(git 프로세스 각각 0·5·13개).
// Windows에서 프로세스 생성이 비싼 탓이 크다 — 이 저장소의 시험 러너가 워커를 넷으로
// 묶는 이유와 같다. 훅만의 문제가 아니라 하위 디렉터리에서 친 모든 rdl이 문다.
//
// 답은 한 글자도 달라지지 않는다. 없는 파일을 찾으러 가지 않을 뿐이고, 있으면
// 예전 그대로 층마다 물어본다. "두 후보 파일이 다 실패한 뒤에만 런타임을 본다"로
// 순서를 바꾸지 않은 이유가 여기 있다 — 런타임 manifest는 저장소마다 하나라 탐색의
// 모든 층에서 같은 답을 내고, 그래서 지금 코드는 런타임으로 찾히는 저장소에서
// 시작 디렉터리를 루트로 돌려준다. 순서를 바꾸면 두 가지가 다 있는 저장소에서
// 돌려주는 루트가 달라진다. 여기서 고치는 것은 비용이지 답이 아니다.
function anyRuntimeManifest() {
  const directory = path.join(runtimeHome(), 'workspaces');
  let entries;
  try { entries = fs.readdirSync(directory); } catch (_) { return false; }
  return entries.some((entry) => RUNTIME_WORKSPACE_ID.test(entry) && fs.existsSync(path.join(directory, entry, 'workspace.yaml')));
}

function manifestPath(root) {
  const workspace = path.join(root, 'projects', 'workspace', 'workspace.yaml');
  if (fs.existsSync(workspace)) return workspace;
  const legacy = path.join(root, '.rundol', 'workspace.yaml');
  if (fs.existsSync(legacy)) return legacy;
  if (!anyRuntimeManifest()) return null;
  try {
    const runtime = runtimeWorkspace(root);
    return fs.existsSync(runtime.manifest) ? runtime.manifest : null;
  } catch (_) {
    return null;
  }
}

function findWorkspaceRoot(start) {
  let current = path.resolve(start || process.cwd());
  if (fs.existsSync(current) && fs.statSync(current).isFile()) current = path.dirname(current);
  while (true) {
    if (manifestPath(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      try {
        const repository = path.resolve(gitRoot(start || process.cwd()));
        if (manifestPath(repository)) return repository;
      } catch (_) {}
      throw new Error(`${start}에 연결된 Rundol Workspace를 찾지 못했습니다. 먼저 rdl attach를 실행하세요.`);
    }
    current = parent;
  }
}

function readWorkspaceManifest(root) {
  const file = manifestPath(root);
  if (!file) throw new Error(`${root}에서 연결된 Rundol Workspace를 찾지 못했습니다. 먼저 rdl attach를 실행하세요.`);
  return { file, source: fs.readFileSync(file, 'utf8') };
}

function yamlNestedValue(source, section, key) {
  const sectionMatch = new RegExp(`(?:^|\\n)${section}:\\s*\\n([\\s\\S]*?)(?=\\n[^ \\n][^\\n]*:|$)`).exec(source);
  if (!sectionMatch) return null;
  const keyMatch = new RegExp(`^\\s{2}${key}:\\s*(.+)$`, 'm').exec(sectionMatch[1]);
  return keyMatch ? keyMatch[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

function yamlValue(source, key) {
  const match = new RegExp(`^${key}:\\s*([^#\\r\\n]+)`, 'm').exec(source);
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

function safeRelative(value, label) {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || path.isAbsolute(normalized) || normalized.split('/').includes('..')) throw new Error(`${label}은 Workspace 내부 상대 경로여야 합니다: ${value}`);
  return normalized;
}

function listProjects(layout) {
  if (layout.schemaVersion >= 3) {
    const directory = layout.projectsDirectory || path.resolve(layout.root, layout.projectsRelative || '.rundol/projects');
    if (!fs.existsSync(directory)) return [];
    const projects = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
      .map((entry) => {
        const file = path.join(directory, entry.name);
        const source = fs.readFileSync(file, 'utf8');
        const expected = layout.schemaVersion >= 6 ? /^project-(.+)\.yaml$/u.exec(entry.name) : null;
        const key = yamlValue(source, 'key') || (expected ? expected[1] : entry.name.slice(0, -5));
        const mountRelative = safeRelative(yamlValue(source, 'mount') || `${layout.mountRelative}/${key}`, 'project.mount');
        const ref = yamlValue(source, 'ref') || `refs/heads/rundol/${key}`;
        if (!ref.startsWith('refs/heads/')) throw new Error(`project.ref는 로컬 브랜치 ref여야 합니다: ${ref}`);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) || key === 'workspace') throw new Error(`잘못되었거나 예약된 프로젝트 키입니다: ${key}`);
        const expectedName = layout.schemaVersion >= 6 ? `project-${key}.yaml` : `${key}.yaml`;
        if (entry.name !== expectedName) throw new Error(`프로젝트 등록 파일명은 ${expectedName}이어야 합니다: ${entry.name}`);
        if (mountRelative !== `${layout.mountRelative}/${key}`) throw new Error(`프로젝트 mount는 ${layout.mountRelative}/${key}여야 합니다: ${mountRelative}`);
        if (ref !== `refs/heads/rundol/${key}`) throw new Error(`프로젝트 ref는 refs/heads/rundol/${key}여야 합니다: ${ref}`);
        const root = path.resolve(layout.root, mountRelative);
        const taskStorage = yamlNestedValue(source, 'tasks', 'storage') || 'single';
        if (!['single', 'sharded'].includes(taskStorage)) throw new Error(`지원하지 않는 task storage입니다: ${taskStorage}`);
        const taskRelative = safeRelative(yamlNestedValue(source, 'tasks', 'path') || (taskStorage === 'sharded' ? 'tasks' : 'tasks.json'), 'project.tasks.path');
        return {
          key,
          name: yamlValue(source, 'name') || key,
          manifest: file,
          mountRelative,
          root,
          charter: path.join(root, 'project.md'),
          documents: path.join(root, 'docs'),
          taskStorage,
          taskRelative,
          tasks: path.join(root, taskRelative),
          taskProjection: path.join(root, '.rundol', 'state', 'tasks.json'),
          ref,
          branch: ref.slice('refs/heads/'.length)
        };
      })
      .sort((left, right) => left.key.localeCompare(right.key));
    const keys = new Set();
    for (const project of projects) {
      if (keys.has(project.key)) throw new Error(`중복 프로젝트 키입니다: ${project.key}`);
      keys.add(project.key);
    }
    return projects;
  }
  if (!fs.existsSync(layout.mount)) return [];
  return fs.readdirSync(layout.mount, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && fs.existsSync(path.join(layout.mount, entry.name, 'project.md')))
    .map((entry) => ({
      key: entry.name,
      root: path.join(layout.mount, entry.name),
      charter: path.join(layout.mount, entry.name, 'project.md'),
      documents: path.join(layout.mount, entry.name, 'docs')
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function workspaceLayout(start) {
  const root = findWorkspaceRoot(start);
  const manifest = readWorkspaceManifest(root);
  const schemaVersion = Number.parseInt(yamlValue(manifest.source, 'schemaVersion') || '1', 10) || 1;
  if (schemaVersion >= 3) {
    const mountRelative = safeRelative(yamlValue(manifest.source, 'mount') || 'projects', 'mount');
    const projectsRelative = schemaVersion >= 6 ? 'projects/workspace/projects' : safeRelative(yamlNestedValue(manifest.source, 'projects', 'path') || '.rundol/projects', 'projects.path');
    const runtime = schemaVersion >= 6 || manifest.file.includes(`${path.sep}.rundol${path.sep}`) ? null : runtimeWorkspace(root);
    const projectsDirectory = schemaVersion >= 6 ? path.join(root, 'projects', 'workspace', 'projects') : (runtime ? path.join(runtime.settings, 'projects') : path.resolve(root, projectsRelative));
    const layout = { schemaVersion, root, manifest, mountRelative, mount: path.resolve(root, mountRelative), projectsRelative, projectsDirectory, runtime, tasks: null };
    layout.projects = listProjects(layout);
    return layout;
  }
  if (schemaVersion >= 2) {
    const mountRelative = safeRelative(yamlValue(manifest.source, 'mount') || 'projects', 'mount');
    const mount = path.resolve(root, mountRelative);
    const ref = yamlNestedValue(manifest.source, 'git', 'ref') || 'refs/heads/rundol/workspace';
    if (!ref.startsWith('refs/heads/')) throw new Error(`git.ref는 로컬 브랜치 ref여야 합니다: ${ref}`);
    const layout = { schemaVersion, root, manifest, mountRelative, mount, ref, branch: ref.slice('refs/heads/'.length), tasks: path.join(mount, 'tasks.json') };
    layout.projects = listProjects(layout);
    return layout;
  }
  const documentsRelative = safeRelative(yamlNestedValue(manifest.source, 'documents', 'root') || 'docs', 'documents.root');
  const taskRelative = safeRelative(yamlNestedValue(manifest.source, 'tasks', 'path') || 'tasks.json', 'tasks.path');
  const projectionValue = yamlNestedValue(manifest.source, 'tasks', 'projection');
  const ref = yamlNestedValue(manifest.source, 'tasks', 'ref') || 'refs/heads/rundol/workspace';
  return {
    schemaVersion,
    root,
    manifest,
    mountRelative: '.rundol/worktrees/workspace',
    mount: path.join(root, '.rundol', 'worktrees', 'workspace'),
    ref,
    branch: ref.replace(/^refs\/heads\//, ''),
    tasks: path.resolve(root, taskRelative),
    projection: projectionValue ? path.resolve(root, projectionValue) : null,
    projects: [{ key: yamlValue(manifest.source, 'id') || 'default', root, charter: null, documents: path.resolve(root, documentsRelative) }]
  };
}

function selectProject(layout, key, required) {
  const projects = listProjects(layout);
  if (key) {
    const selected = projects.find((project) => project.key === key);
    if (!selected) throw new Error(`프로젝트를 찾지 못했습니다: ${key}`);
    return selected;
  }
  if (projects.length === 1) return projects[0];
  if (required || projects.length > 1) {
    const available = projects.map((project) => project.key).join(', ');
    throw new Error(`--project <프로젝트키>가 필요합니다.${available ? ` 사용 가능: ${available}` : ''}`);
  }
  return null;
}

module.exports = { manifestPath, findWorkspaceRoot, readWorkspaceManifest, yamlNestedValue, yamlValue, workspaceLayout, listProjects, selectProject, safeRelative };
