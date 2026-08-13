'use strict';

const assert = require('assert');
const { recommendProfile, selectProject, guidedProjectInput } = require('../src/guided');

assert.strictEqual(recommendProfile({}), 'lean');
assert.strictEqual(recommendProfile({ kind: 'product' }), 'product');
assert.strictEqual(recommendProfile({ operations: true }), 'service');
assert.strictEqual(recommendProfile({ reusable: true }), 'platform');
assert.strictEqual(recommendProfile({ regulated: true }), 'assured');

function streams(answers) {
  const written = [];
  const queue = answers.slice();
  return {
    input: { isTTY: true },
    output: { isTTY: true, write: (value) => written.push(value) },
    ask: async () => queue.shift(),
    written
  };
}

(async () => {
  assert.strictEqual(await selectProject(['alpha', 'beta'], streams(['2'])), 'beta');
  await assert.rejects(() => selectProject(['alpha'], streams(['missing'])), /missing/u);
  await assert.rejects(() => selectProject(['alpha'], { input: { isTTY: false }, output: { isTTY: true } }), /TTY|대화형/u);

  const interview = streams(['demo', 'Demo', 'service', 'n', 'y', 'y', 'n', 'y', 'n', 'y', '']);
  assert.deepStrictEqual(await guidedProjectInput({}, interview), {
    key: 'demo', name: 'Demo', profile: 'service',
    traits: ['data', 'api', 'operations', 'terminology'],
    reasons: ['data 응답을 문서 정책 신호로 반영', 'api 응답을 문서 정책 신호로 반영', 'operations 응답을 문서 정책 신호로 반영', 'terminology 응답을 문서 정책 신호로 반영']
  });
  assert(interview.written.join('').includes('service'));
  await assert.rejects(() => guidedProjectInput({}, { input: { isTTY: false }, output: { isTTY: true } }), /guided|대화형/u);
  process.stdout.write('guided interview tests passed\n');
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
