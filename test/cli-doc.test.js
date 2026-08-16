'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'rdl.js');
const document = fs.readFileSync(path.join(root, 'docs', 'CLI.md'), 'utf8').replace(/\r\n/g, '\n');
const result = spawnSync(process.execPath, [cli, '--help'], { cwd: root, encoding: 'utf8' });
assert.strictEqual(result.status, 0, result.stderr || result.stdout);

const help = result.stdout.replace(/\r\n/g, '\n');
const usageMatch = /Usage:\n([\s\S]*?)\n\nOptions:/.exec(help);
assert(usageMatch, 'rdl --help Usage 블록을 찾지 못했습니다.');
const documentedMatch = /<!-- rdl-help:start -->\n```text\n([\s\S]*?)\n```\n<!-- rdl-help:end -->/.exec(document);
assert(documentedMatch, 'docs/CLI.md 동기화 블록을 찾지 못했습니다.');

function normalize(value) {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
}

assert(help.includes('rdl watch --project <key> [--remote] [--once] [--json]'));
assert(help.includes('rdl sync watch [--interval <seconds>]'), 'sync watch must remain a distinct command');
assert(help.includes('rdl run drive --run <RUN-ID> --project <key> --client-id <id> [--scheduled]'));
assert(help.includes('rdl run operation resolve --run <RUN-ID> --project <key> --operation <operation-id>'));
const namedWatchRemote = spawnSync(process.execPath, [cli, 'watch', '--project', 'sample', '--remote', 'origin', '--once'], { cwd: root, encoding: 'utf8' });
assert.strictEqual(namedWatchRemote.status, 2, 'watch --remote must be an exact boolean surface, not a remote-name option');
assert(namedWatchRemote.stderr.includes('origin'));

assert.strictEqual(normalize(documentedMatch[1]), normalize(usageMatch[1]), 'docs/CLI.md 명령 요약이 rdl --help와 다릅니다.');
for (const stale of ['Workspace v2', 'projects/tasks.json', 'refs/heads/rundol/workspace', '.rundol/pending/merge-conflicts.json', '.rundol/index/<project>']) {
  assert(!document.includes(stale), `docs/CLI.md에 이전 구조 표현이 남았습니다: ${stale}`);
}
assert(document.includes('projects/<project-key>/.rundol/state/pending/merge-conflicts.json'));
process.stdout.write('CLI document tests passed\n');
