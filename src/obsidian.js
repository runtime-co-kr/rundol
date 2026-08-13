'use strict';

const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const TEMPLATE_ROOT = path.resolve(__dirname, '..', 'docs', 'templates');

function atomicCopy(source, target) {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, target);
}

function initObsidian(start, options) {
  const settings = options || {};
  const layout = workspaceLayout(start);
  const project = layout.schemaVersion >= 3 ? selectProject(layout, settings.project, true) : null;
  const legacySettings = path.join(layout.root, '.rundol', 'settings', 'obsidian');
  const legacySource = path.join(layout.root, '.rundol', 'obsidian');
  const sourceDirectory = project ? (fs.existsSync(legacySettings) ? legacySettings : TEMPLATE_ROOT) : legacySource;
  const targetDirectory = path.join(project ? project.root : layout.root, '.obsidian');
  if (!fs.existsSync(sourceDirectory)) throw new Error(`Obsidian 설정 원본을 찾지 못했습니다: ${sourceDirectory}`);
  fs.mkdirSync(targetDirectory, { recursive: true });
  if (project) for (const directory of ['assets', 'inbox', 'templates']) fs.mkdirSync(path.join(project.root, directory), { recursive: true });
  const copied = [];
  const preserved = [];
  const templateNames = new Map([['OBSIDIAN-APP.template.json', 'app.json'], ['OBSIDIAN-CORE-PLUGINS.template.json', 'core-plugins.json'], ['OBSIDIAN-GRAPH.template.json', 'graph.json'], ['OBSIDIAN-TEMPLATES.template.json', 'templates.json']]);
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const source = path.join(sourceDirectory, entry.name);
    const targetName = templateNames.get(entry.name) || entry.name;
    if (sourceDirectory === TEMPLATE_ROOT && !templateNames.has(entry.name)) continue;
    const target = path.join(targetDirectory, targetName);
    if (fs.existsSync(target) && !settings.force) {
      preserved.push(targetName);
      continue;
    }
    const content = fs.readFileSync(source, 'utf8').replaceAll('<프로젝트키>', project ? project.key : 'project');
    JSON.parse(content);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, target);
    copied.push(targetName);
  }
  return { root: layout.root, project: project ? project.key : null, vault: project ? project.root : layout.root, source: sourceDirectory, target: path.relative(layout.root, targetDirectory).split(path.sep).join('/'), copied, preserved, forced: settings.force === true };
}

module.exports = { initObsidian };
