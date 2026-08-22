'use strict';

// 초기 설정 수집. 아무도 결정하지 않은 값이 프로젝트의 기본이 되는 경로를 막는다.
// 생략은 조용한 기본값이 아니라 명시적 선언이어야 한다 — 그래야 나중에 "왜 이
// 프로필이지?"라는 질문에 답이 있다. REQ-039의 결정 원칙을 셋업에 적용한 것이다.

const path = require('path');
const { runGit } = require('./git');
const { PROFILE_NAMES, DEFAULT_POLICIES } = require('./document-profile');
const { CONVENTIONAL_PRIMARY } = require('./vocabulary');

// 관례적 기본 브랜치(vocabulary.CONVENTIONAL_PRIMARY)는 원격 HEAD가 없을 때
// 현재 브랜치를 기본으로 추론해도 안전한지 판단하는 기준이다 — 기능 브랜치를
// 기본으로 삼으면 push 경계가 엉뚱한 브랜치를 보호하게 된다.

// 프로필은 크기가 아니라 목적으로 고른다. 이름만으로는 무엇을 쓰게 되는지 알 수
// 없어서, 목적과 "무엇을 정본으로 쓰게 되는가"를 함께 제시한다.
const PROFILE_GOALS = Object.freeze({
  lean: { goal: '아이디어 검증', summary: '제품 목표와 요구사항만 정본으로 둡니다. 설계와 검증 문서는 필요할 때 씁니다.' },
  product: { goal: '사용자 대면 제품', summary: '요구사항에 화면 명세를 더해 사용자가 보는 흐름까지 정본으로 둡니다.' },
  service: { goal: '운영하는 서비스', summary: '연동 규격과 운영 절차를 정본으로 요구합니다. 장애 대응과 외부 계약이 있는 서비스에 맞습니다.' },
  platform: { goal: '다른 팀이 쓰는 플랫폼', summary: '구조와 데이터 모델, 연동 규격을 정본으로 요구합니다. 결정 기록을 권장합니다.' },
  assured: { goal: '규제·감사 대응', summary: '정규 문서 유형 전부를 정본으로 요구합니다. 증빙이 필요한 환경에 맞습니다.' }
});

function profileGoals() {
  return PROFILE_NAMES.map((name) => {
    const policy = DEFAULT_POLICIES[name] || { required: [], recommended: [] };
    const goal = PROFILE_GOALS[name] || { goal: name, summary: '' };
    return {
      id: name,
      goal: goal.goal,
      summary: goal.summary,
      // 설명은 정책에서 파생한다. 손으로 적은 목록은 정책이 바뀌면 조용히 낡는다.
      required: policy.required.slice(),
      recommended: policy.recommended.slice()
    };
  });
}

// 원격과 기본 브랜치는 판단이 아니라 정보다. 위임해도 대신 정할 수 없고, 지어내면
// push 경계가 잘못된 브랜치를 보호한다. 읽을 수 있으면 읽어서 기록하고, 읽을 수
// 없으면 조용한 추론 대신 멈춘다.
function remoteFacts(root, remoteName) {
  const remote = remoteName || 'origin';
  const remotes = runGit(['remote'], { cwd: root, allowFailure: true }).stdout.split(/\r?\n/u).filter(Boolean);
  if (!remotes.includes(remote)) {
    const current = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, allowFailure: true }).stdout || null;
    return { remote: null, url: null, primaryBranch: current === 'HEAD' ? null : current, source: 'local-only', decided: true };
  }
  const url = runGit(['remote', 'get-url', remote], { cwd: root, allowFailure: true }).stdout || null;
  const head = runGit(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], { cwd: root, allowFailure: true });
  if (head.status === 0 && head.stdout.startsWith(`${remote}/`)) {
    return { remote, url, primaryBranch: head.stdout.slice(remote.length + 1), source: 'remote-head', decided: true };
  }
  const current = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, allowFailure: true }).stdout || null;
  if (current && current !== 'HEAD' && CONVENTIONAL_PRIMARY.includes(current)) {
    return { remote, url, primaryBranch: current, source: 'inferred', decided: true };
  }
  return { remote, url, primaryBranch: null, source: 'unresolved', decided: false, current: current === 'HEAD' ? null : current };
}

function assertRemoteDecided(facts, override) {
  if (override) return Object.assign({}, facts, { primaryBranch: override, source: 'declared', decided: true });
  if (facts.decided) return facts;
  throw new Error(`기본 브랜치를 확정할 수 없습니다. \`git remote set-head ${facts.remote} -a\`로 원격 HEAD를 설정하거나 --primary-branch <이름>으로 지정하세요.${facts.current ? ` (현재 브랜치 ${facts.current}는 관례적 기본 브랜치가 아니라 추론하지 않습니다.)` : ''}`);
}

// 셋업에서 사람이 결정해야 하는 것을 질문 형태로 돌려준다. 대화형 터미널이
// 아니어도 에이전트가 이 목록을 사람에게 전달하고 답을 플래그로 다시 넣을 수
// 있어야 한다 — 인터뷰를 흉내 내는 대신 질문을 그대로 넘기는 경로다.
function setupQuestions(root, input) {
  const settings = input || {};
  const facts = remoteFacts(root, settings.remote);
  const questions = [{
    id: 'document-goal',
    kind: 'project-setup',
    question: '이 프로젝트의 문서 목표를 무엇으로 할까요?',
    options: profileGoals().map((choice) => ({ id: choice.id, label: `${choice.goal} — ${choice.summary}`, required: choice.required, recommended: choice.recommended })),
    recommendation: { option: 'service', because: '운영을 전제한 기본값입니다. 더 가볍게 시작하려면 lean, 증빙이 필요하면 assured를 고르세요.' },
    answerWith: '--profile <이름> (또는 --defaults로 권고안 수용)'
  }];
  if (!facts.decided) {
    questions.push({
      id: 'primary-branch',
      kind: 'project-setup',
      question: `원격 ${facts.remote}의 기본 브랜치가 무엇입니까?`,
      options: [],
      recommendation: null,
      answerWith: '--primary-branch <이름> (또는 git remote set-head 설정)'
    });
  }
  return { root, remote: facts, questions };
}

// 프로필은 판단이므로 위임과 기본값 수용이 성립한다. 다만 수용은 선언이어야 한다.
function resolveProfileDecision(input) {
  const settings = input || {};
  if (settings.profile) {
    if (!PROFILE_NAMES.includes(settings.profile)) throw new Error(`지원하지 않는 문서 프로필입니다: ${settings.profile}`);
    return { profile: settings.profile, source: 'declared' };
  }
  if (settings.defaults) return { profile: 'service', source: 'accepted-default' };
  throw new Error('문서 목표를 결정해야 합니다: --profile <lean|product|service|platform|assured> 또는 --defaults로 권고안을 수용하세요. 목표별 설명은 `rdl init --questions --json`으로 볼 수 있습니다.');
}

module.exports = { CONVENTIONAL_PRIMARY, PROFILE_GOALS, profileGoals, remoteFacts, assertRemoteDecided, setupQuestions, resolveProfileDecision };
