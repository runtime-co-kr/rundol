'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { profileGoals, remoteFacts, assertRemoteDecided, setupQuestions, resolveProfileDecision } = require('../src/setup');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-setup-'));
const home = path.join(temporary, 'runtime');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rdl(args, cwd) {
  return spawnSync(process.execPath, [cli].concat(args), { cwd: repository, encoding: 'utf8', env: Object.assign({}, process.env, { RUNDOL_HOME: home }) });
}

function workspace(name) {
  const root = path.join(temporary, name);
  fs.mkdirSync(root, { recursive: true });
  git(['init', '-b', 'main'], root);
  git(['config', 'user.name', 'Rundol Test'], root);
  git(['config', 'user.email', 'rundol@example.test'], root);
  fs.writeFileSync(path.join(root, 'README.md'), '# setup\n', 'utf8');
  git(['add', 'README.md'], root);
  git(['commit', '-m', 'initial'], root);
  return root;
}

try {
  // 문서 목표는 이름이 아니라 목적과 "무엇을 쓰게 되는가"로 제시된다.
  const goals = profileGoals();
  assert.strictEqual(goals.length, 5);
  const service = goals.find((choice) => choice.id === 'service');
  assert(service.goal.length > 0 && service.summary.length > 0, '목표와 설명이 있어야 합니다.');
  assert(service.required.includes('API'), '요구 유형은 정책에서 파생되어야 합니다.');
  assert.deepStrictEqual(goals.find((choice) => choice.id === 'assured').recommended, [], '정책이 그대로 반영되어야 합니다.');

  // 프로필은 판단이므로 선언하거나 기본값을 명시적으로 수용해야 한다.
  assert.strictEqual(resolveProfileDecision({ profile: 'lean' }).source, 'declared');
  assert.strictEqual(resolveProfileDecision({ defaults: true }).source, 'accepted-default');
  assert.throws(() => resolveProfileDecision({}), /문서 목표를 결정해야 합니다/u);
  assert.throws(() => resolveProfileDecision({ profile: 'unknown' }), /지원하지 않는 문서 프로필/u);

  // 원격이 없으면 로컬 전용으로 확정된다 — 없는 것도 수집 결과다.
  const localOnly = workspace('local-only');
  const localFacts = remoteFacts(localOnly);
  assert.strictEqual(localFacts.source, 'local-only');
  assert.strictEqual(localFacts.decided, true);
  assert.strictEqual(localFacts.primaryBranch, 'main');

  // 원격이 있고 관례적 기본 브랜치에 있으면 추론해 기록한다.
  const withRemote = workspace('with-remote');
  const bare = path.join(temporary, 'origin.git');
  git(['init', '--bare', '--initial-branch=main', bare], temporary);
  git(['remote', 'add', 'origin', bare], withRemote);
  git(['push', '-u', 'origin', 'main'], withRemote);
  const remoteFactsMain = remoteFacts(withRemote);
  assert.strictEqual(remoteFactsMain.remote, 'origin');
  assert.strictEqual(remoteFactsMain.primaryBranch, 'main');
  assert(['remote-head', 'inferred'].includes(remoteFactsMain.source));
  assert.strictEqual(remoteFactsMain.decided, true);

  // 원격은 있는데 기본 브랜치를 추론할 수 없으면 조용한 기본값 대신 멈춘다 —
  // 기능 브랜치를 기본으로 삼으면 push 경계가 엉뚱한 브랜치를 보호한다.
  git(['checkout', '-b', 'feature/setup'], withRemote);
  const ambiguous = remoteFacts(withRemote);
  if (ambiguous.source === 'unresolved') {
    assert.strictEqual(ambiguous.decided, false);
    assert.throws(() => assertRemoteDecided(ambiguous), /기본 브랜치를 확정할 수 없습니다/u);
    assert.strictEqual(assertRemoteDecided(ambiguous, 'main').source, 'declared');
    const questions = setupQuestions(withRemote);
    assert.strictEqual(questions.questions.length, 2, '확정되지 않은 기본 브랜치는 질문으로 남아야 합니다.');
    assert.strictEqual(questions.questions[1].id, 'primary-branch');
  }
  git(['checkout', 'main'], withRemote);

  // 질문셋은 대화형이 아닌 경로에서도 사람에게 전달할 수 있어야 한다.
  const questionSet = setupQuestions(localOnly);
  assert.strictEqual(questionSet.questions[0].id, 'document-goal');
  assert.strictEqual(questionSet.questions[0].options.length, 5);
  assert(questionSet.questions[0].recommendation.because.length > 0, '권고 근거가 필요합니다.');

  // CLI: 목표를 결정하지 않은 비대화형 생성은 조용한 기본값 대신 실패한다.
  const undecided = workspace('undecided');
  const refused = rdl(['init', 'crm', '--name', 'CRM', '--root', undecided, '--json']);
  assert.strictEqual(refused.status, 2, refused.stdout + refused.stderr);
  assert(refused.stderr.includes('문서 목표를 결정해야 합니다'), refused.stderr);
  assert(!fs.existsSync(path.join(undecided, 'projects', 'crm')), '결정 없이 프로젝트가 만들어지면 안 됩니다.');

  const questionsCli = JSON.parse(rdl(['init', '--questions', '--root', undecided, '--json']).stdout);
  assert.strictEqual(questionsCli.questions[0].id, 'document-goal');
  assert(!fs.existsSync(path.join(undecided, 'projects', 'crm')), '질문 조회가 프로젝트를 만들면 안 됩니다.');

  const accepted = JSON.parse(rdl(['init', 'crm', '--name', 'CRM', '--defaults', '--root', undecided, '--json']).stdout);
  assert.strictEqual(accepted.profile, 'service');
  assert.strictEqual(accepted.profileSource, 'accepted-default', '기본값 수용은 결과에 남아야 합니다.');
  assert.strictEqual(accepted.remote.source, 'local-only');

  const declared = workspace('declared');
  const chosen = JSON.parse(rdl(['init', 'crm', '--name', 'CRM', '--profile', 'lean', '--root', declared, '--json']).stdout);
  assert.strictEqual(chosen.profile, 'lean');
  assert.strictEqual(chosen.profileSource, 'declared');

  process.stdout.write('setup tests passed\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
