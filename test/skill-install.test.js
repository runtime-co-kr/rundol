'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-skill-'));
const codexHome = path.join(temporary, 'codex');
const claudeHome = path.join(temporary, 'claude');
const copilotHome = path.join(temporary, 'copilot');
const installer = path.join(root, 'scripts', 'install-global-skill.js');
const environment = Object.assign({}, process.env, {
  CODEX_HOME: codexHome,
  CLAUDE_CONFIG_DIR: claudeHome,
  RUNDOL_COPILOT_HOME: copilotHome
});

try {
  const result = spawnSync(process.execPath, [installer, '--force'], {
    cwd: root,
    encoding: 'utf8',
    env: environment,
    windowsHide: true
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const skillRoot = path.join(codexHome, 'skills', 'rundol-project-governance');
  assert(fs.existsSync(path.join(skillRoot, 'SKILL.md')));
  assert(fs.existsSync(path.join(skillRoot, 'references', 'governance-contract.md')));
  assert(fs.existsSync(path.join(skillRoot, 'references', 'client-compatibility.md')));
  assert(fs.existsSync(path.join(skillRoot, '.rundol-managed.json')));
  const claudeSkill = path.join(claudeHome, 'skills', 'rundol-project-governance');
  const copilotSkill = path.join(copilotHome, 'skills', 'rundol-project-governance');
  for (const clientSkill of [claudeSkill, copilotSkill]) {
    assert(fs.existsSync(path.join(clientSkill, 'SKILL.md')));
    assert(fs.existsSync(path.join(clientSkill, 'references', 'governance-contract.md')));
    assert(fs.existsSync(path.join(clientSkill, '.rundol-managed.json')));
  }

  fs.unlinkSync(path.join(claudeSkill, '.rundol-managed.json'));
  fs.writeFileSync(path.join(claudeSkill, 'SKILL.md'), 'user managed\n', 'utf8');

  const second = spawnSync(process.execPath, [installer, '--force'], {
    cwd: root,
    encoding: 'utf8',
    env: environment,
    windowsHide: true
  });
  assert.strictEqual(second.status, 0, second.stderr || second.stdout);
  assert.strictEqual(fs.readFileSync(path.join(claudeSkill, 'SKILL.md'), 'utf8'), 'user managed\n');
  assert(second.stderr.includes('Existing unmanaged Claude Code skill was preserved'));
  process.stdout.write('skill install tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
