'use strict';

const fs = require('fs');
const path = require('path');
const { workspaceLayout, selectProject } = require('./workspace');
const { planMigration } = require('./document-migration');

function candidate(kind, file, reason) {
  return { kind, file, reason };
}

function auditStructure(start, options) {
  const layout = workspaceLayout(start);
  const selected = options && options.project ? [selectProject(layout, options.project, true)] : layout.projects;
  const candidates = [];
  if (layout.runtime) {
    const legacyObsidian = path.join(layout.runtime.settings, 'obsidian');
    if (fs.existsSync(legacyObsidian)) candidates.push(candidate('legacy-settings', legacyObsidian, 'Obsidian 설정은 프로젝트 Vault의 .obsidian이 소유합니다.'));
  }
  for (const project of selected) {
    const migration = planMigration(project.root);
    if (migration.moves.length || migration.rewrites.length || migration.conflicts.length) {
      candidates.push(candidate('legacy-document-migration', project.root, `${migration.moves.length}개 이동, ${migration.rewrites.length}개 링크 수정, ${migration.conflicts.length}개 충돌을 검토해야 합니다.`));
    }
    for (const directory of ['assets', 'inbox', 'templates']) {
      const target = path.join(project.root, directory);
      if (fs.existsSync(target) && fs.readdirSync(target).length === 1 && fs.existsSync(path.join(target, '.gitkeep'))) {
        candidates.push(candidate('placeholder-directory', target, '기능을 사용하지 않는 빈 선택 디렉터리입니다.'));
      }
    }
    for (const directory of ['docs', 'tasks']) {
      const marker = path.join(project.root, directory, '.gitkeep');
      if (fs.existsSync(marker) && fs.readdirSync(path.dirname(marker)).some((name) => name !== '.gitkeep')) {
        candidates.push(candidate('redundant-gitkeep', marker, '실제 파일이 있어 빈 디렉터리 마커가 불필요합니다.'));
      }
    }
    if (!fs.existsSync(path.join(project.root, '.obsidian'))) candidates.push(candidate('missing-vault-settings', path.join(project.root, '.obsidian'), '프로젝트별 Obsidian Vault 설정이 없습니다.'));
  }
  return { root: layout.root, projects: selected.map((item) => item.key), candidates, clean: candidates.length === 0 };
}

function cleanupStructure(start, options) {
  const audit = auditStructure(start, options);
  const apply = options && options.apply === true;
  const removed = [];
  if (apply) {
    for (const item of audit.candidates) {
      if (item.kind === 'missing-vault-settings' || item.kind === 'legacy-document-migration') continue;
      if (item.kind === 'redundant-gitkeep') fs.unlinkSync(item.file);
      else fs.rmSync(item.file, { recursive: true, force: true });
      removed.push(item.file);
    }
  }
  return Object.assign({}, audit, { dryRun: !apply, removed });
}

module.exports = { auditStructure, cleanupStructure };
