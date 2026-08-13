'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILL_NAME = 'rundol-project-governance';

function skillSource() {
  return path.resolve(__dirname, '..', 'skills', SKILL_NAME);
}

function skillTargets() {
  return [
    { client: 'Codex', root: path.join(path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')), 'skills') },
    { client: 'Claude Code', root: path.join(path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')), 'skills') },
    { client: 'GitHub Copilot', root: path.join(path.resolve(process.env.RUNDOL_COPILOT_HOME || path.join(os.homedir(), '.copilot')), 'skills') }
  ];
}

function copyDirectory(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const sourcePath = path.join(from, entry.name);
    const targetPath = path.join(to, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, targetPath);
    else fs.copyFileSync(sourcePath, targetPath);
  }
}

// 클라이언트별 개인 skills 폴더에 거버넌스 스킬을 설치한다.
// 관리 마커가 없는 기존 디렉터리는 사용자 소유로 보고 보존한다.
function installSkill(options) {
  const settings = options || {};
  const source = skillSource();
  if (!fs.existsSync(source)) throw new Error(`Rundol skill source not found: ${source}`);

  const results = [];
  const installed = new Set();
  for (const item of skillTargets()) {
    const skillsRoot = path.resolve(item.root);
    const target = path.join(skillsRoot, SKILL_NAME);
    const marker = path.join(target, '.rundol-managed.json');
    const canonicalTarget = path.resolve(target).toLowerCase();
    if (installed.has(canonicalTarget)) continue;
    installed.add(canonicalTarget);
    if (path.dirname(target) !== skillsRoot || path.basename(target) !== SKILL_NAME) throw new Error(`Unsafe Rundol skill target for ${item.client}.`);
    if (fs.existsSync(target) && !fs.existsSync(marker) && !settings.force) {
      results.push({ client: item.client, target, status: 'preserved' });
      continue;
    }
    fs.rmSync(target, { recursive: true, force: true });
    copyDirectory(source, target);
    fs.writeFileSync(marker, `${JSON.stringify({ managedBy: 'rundol', client: item.client, skill: SKILL_NAME }, null, 2)}\n`, 'utf8');
    results.push({ client: item.client, target, status: 'installed' });
  }
  return { skill: SKILL_NAME, source, targets: results };
}

module.exports = { installSkill, skillSource, skillTargets, SKILL_NAME };
