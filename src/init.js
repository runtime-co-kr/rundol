'use strict';

const fs = require('fs');
const path = require('path');
const { workspaceLayout } = require('./workspace');
const { gitRoot } = require('./git');
const { manifestSource, gitExclude } = require('./attach');
const { renderWorkspaceBoardConfig, renderProjectBoardConfig } = require('./board-presentation');

const TEMPLATE_ROOT = path.resolve(__dirname, '..', 'docs', 'templates');
const PROJECT_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_PROJECT_KEYS = new Set(['workspace']);

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, file);
}

function template(name) {
  return fs.readFileSync(path.join(TEMPLATE_ROOT, name), 'utf8');
}

function validateProject(key, name) {
  if (!PROJECT_KEY.test(key || '')) throw new Error(`프로젝트 키는 영문 소문자·숫자·하이픈만 사용할 수 있습니다: ${key || '(없음)'}`);
  if (RESERVED_PROJECT_KEYS.has(key)) throw new Error(`Rundol 예약 프로젝트 키는 사용할 수 없습니다: ${key}`);
  if (!String(name || '').trim()) throw new Error('--name <프로젝트 이름>이 필요합니다.');
}

function renderProject(key, name) {
  return template('PROJECT.template.md')
    .replaceAll('<프로젝트키>', key)
    .replaceAll('<프로젝트 이름>', String(name).trim())
    .replaceAll('[[PRD-001-<제품명>|PRD-001]]', '[[project|project]]')
    .replace(/related:\s*\r?\n(?:\s+-[^\r\n]*\r?\n)+/u, 'related: []\n');
}

function ensureIgnore(root) {
  return gitExclude(root).changed;
}

function writeProject(mount, key, name, schemaVersion) {
  const root = path.join(mount, key);
  if (fs.existsSync(root)) throw new Error(`프로젝트 경로가 이미 존재합니다: ${root}`);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  atomicWrite(path.join(root, 'project.md'), renderProject(key, name));
  atomicWrite(path.join(root, 'board.json'), renderProjectBoardConfig());
  atomicWrite(path.join(root, '.gitignore'), '.rundol/\n.obsidian/\n');
  if (schemaVersion >= 3) fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  const obsidian = path.join(root, '.obsidian');
  fs.mkdirSync(obsidian, { recursive: true });
  atomicWrite(path.join(obsidian, 'app.json'), template('OBSIDIAN-APP.template.json').replaceAll('<프로젝트키>', key));
  atomicWrite(path.join(obsidian, 'core-plugins.json'), template('OBSIDIAN-CORE-PLUGINS.template.json'));
  atomicWrite(path.join(obsidian, 'graph.json'), template('OBSIDIAN-GRAPH.template.json'));
  atomicWrite(path.join(obsidian, 'templates.json'), template('OBSIDIAN-TEMPLATES.template.json').replaceAll('<프로젝트키>', key));
  return root;
}

function writeProjectManifest(root, key, name, projectsRelative) {
  const directory = path.isAbsolute(projectsRelative || '') ? projectsRelative : path.join(root, projectsRelative || '.rundol/projects');
  const file = path.join(directory, `project-${key}.yaml`);
  if (fs.existsSync(file)) throw new Error(`프로젝트 등록 파일이 이미 존재합니다: ${file}`);
  const source = template('PROJECT-MANIFEST.template.yaml')
    .replaceAll('<프로젝트키>', key)
    .replaceAll('<프로젝트 이름>', String(name).trim());
  atomicWrite(file, source);
  return file;
}

function initializeWorkspace(start, key, name) {
  const root = path.resolve(start || process.cwd());
  validateProject(key, name);
  const repositoryRoot = path.resolve(gitRoot(root));
  const canonicalRoot = fs.realpathSync.native(root).toLowerCase();
  const canonicalRepositoryRoot = fs.realpathSync.native(repositoryRoot).toLowerCase();
  if (canonicalRepositoryRoot !== canonicalRoot) {
    throw new Error(`rdl init은 Git 저장소 루트에서 실행해야 합니다: ${repositoryRoot}`);
  }
  const workspaceRoot = path.join(root, 'projects', 'workspace');
  const manifest = path.join(workspaceRoot, 'workspace.yaml');
  if (fs.existsSync(manifest)) throw new Error(`이미 Rundol Workspace입니다: ${root}`);
  fs.mkdirSync(path.join(workspaceRoot, 'clients'), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, 'events'), { recursive: true });
  atomicWrite(manifest, manifestSource());
  atomicWrite(path.join(workspaceRoot, 'board.json'), renderWorkspaceBoardConfig());
  ensureIgnore(root);
  const mount = path.join(root, 'projects');
  fs.mkdirSync(mount, { recursive: true });
  const projectManifest = writeProjectManifest(workspaceRoot, key, name, 'projects');
  const projectRoot = writeProject(mount, key, name, 6);
  return { root, project: key, projectRoot, projectManifest, manifest, mount, workspaceRoot };
}

function addProject(start, key, name) {
  validateProject(key, name);
  const layout = workspaceLayout(start);
  if (layout.schemaVersion < 3) throw new Error('rdl project add는 schemaVersion 3 이상 Workspace에서만 사용할 수 있습니다.');
  const projectManifest = writeProjectManifest(layout.root, key, name, layout.projectsDirectory || layout.projectsRelative);
  try {
    const projectRoot = writeProject(layout.mount, key, name, layout.schemaVersion);
    return { root: layout.root, project: key, projectRoot, projectManifest, mount: layout.mount };
  } catch (error) {
    fs.unlinkSync(projectManifest);
    throw error;
  }
}

module.exports = { initializeWorkspace, addProject, renderProject, ensureIgnore };
