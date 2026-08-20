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

// 사람 표면과 고급 표면은 다른 대상을 위한 목록이다. 실행 식별자·임대·어댑터가
// 드러나는 명령군은 사람 표면에서 내렸고, 내린 것이 실제로 내려갔는지와 여전히
// 발견 가능한지를 함께 확인한다. 은닉이 삭제로 번지면 기존 자동화가 조용히 깨진다.
const advancedResult = spawnSync(process.execPath, [cli, 'advanced'], { cwd: root, encoding: 'utf8' });
assert.strictEqual(advancedResult.status, 0, advancedResult.stderr);
const advanced = advancedResult.stdout.replace(/\r\n/g, '\n');
const advancedUsage = /Usage:\n([\s\S]*?)\n\nOptions:/.exec(advanced);
assert(advancedUsage, 'rdl advanced Usage 블록을 찾지 못했습니다.');
const advancedDocumented = /<!-- rdl-advanced:start -->\n```text\n([\s\S]*?)\n```\n<!-- rdl-advanced:end -->/.exec(document);
assert(advancedDocumented, 'docs/CLI.md 고급 명령 동기화 블록을 찾지 못했습니다.');

for (const hidden of ['rdl run ', 'rdl adapter ', 'rdl verify ', 'rdl decision ', 'rdl delegation ', 'rdl client ', 'rdl action ', 'rdl debug ', 'rdl workset ']) {
  assert(!help.includes(`  ${hidden}`), `사람 표면에 내부 개념 명령이 남았습니다: ${hidden.trim()}`);
  assert(advanced.includes(`  ${hidden}`), `고급 표면에서 사라졌습니다: ${hidden.trim()}`);
}
assert(advanced.includes('rdl run drive --run <RUN-ID> --project <key> --client-id <id> [--scheduled]'));
assert(advanced.includes('rdl run operation resolve --run <RUN-ID> --project <key> --operation <operation-id>'));

// 에이전트 발견 표면은 둘을 합쳐 받는다. 사람에게 숨기는 것과 에이전트에게 숨기는
// 것은 다른 판단이며, 여기서 숨기면 에이전트가 다시 소스를 뒤진다.
const catalogResult = spawnSync(process.execPath, [cli, 'help', '--json'], { cwd: root, encoding: 'utf8' });
assert.strictEqual(catalogResult.status, 0, catalogResult.stderr);
const catalog = JSON.parse(catalogResult.stdout);
assert(catalog.commands.some((item) => /^rdl run /.test(item.synopsis)), 'help --json에 고급 명령이 빠졌습니다.');
assert(catalog.commands.some((item) => /^rdl adapter /.test(item.synopsis)), 'help --json에 고급 명령이 빠졌습니다.');

// 폐기한 명령은 두 표면 어디에도 없어야 한다. 다만 부르면 왜 없어졌는지 알려야
// 한다 — 조용히 "알 수 없는 명령"으로 끝나면 사람은 오타를 의심하지 손을 뗄 근거를
// 찾지 못한다.
assert(!help.includes('rdl lease '), '폐기한 명령이 사람 표면에 남았습니다.');
assert(!advanced.includes('rdl lease '), '폐기한 명령이 고급 표면에 남았습니다.');
const retired = spawnSync(process.execPath, [cli, 'lease', 'list'], { cwd: root, encoding: 'utf8' });
assert.notStrictEqual(retired.status, 0, '폐기한 명령이 성공하면 안 됩니다.');
assert(retired.stderr.includes('ADR-015'), '폐기 안내가 근거 문서를 가리켜야 합니다.');

assert.strictEqual(normalize(advancedDocumented[1]), normalize(advancedUsage[1]), 'docs/CLI.md 고급 명령 요약이 rdl advanced와 다릅니다.');
const namedWatchRemote = spawnSync(process.execPath, [cli, 'watch', '--project', 'sample', '--remote', 'origin', '--once'], { cwd: root, encoding: 'utf8' });
assert.strictEqual(namedWatchRemote.status, 2, 'watch --remote must be an exact boolean surface, not a remote-name option');
assert(namedWatchRemote.stderr.includes('origin'));

assert.strictEqual(normalize(documentedMatch[1]), normalize(usageMatch[1]), 'docs/CLI.md 명령 요약이 rdl --help와 다릅니다.');
for (const stale of ['Workspace v2', 'projects/tasks.json', 'refs/heads/rundol/workspace', '.rundol/pending/merge-conflicts.json', '.rundol/index/<project>']) {
  assert(!document.includes(stale), `docs/CLI.md에 이전 구조 표현이 남았습니다: ${stale}`);
}
assert(document.includes('projects/<project-key>/.rundol/state/pending/merge-conflicts.json'));
process.stdout.write('CLI document tests passed\n');
