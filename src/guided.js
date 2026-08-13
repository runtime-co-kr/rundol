'use strict';

const readline = require('readline');

const PROFILE_ALIASES = new Map([
  ['1', 'lean'], ['lean', 'lean'],
  ['2', 'product'], ['product', 'product'],
  ['3', 'service'], ['service', 'service'],
  ['4', 'platform'], ['platform', 'platform'],
  ['5', 'assured'], ['assured', 'assured']
]);

function recommendProfile(answers) {
  const values = answers || {};
  if (values.regulated || values.assurance === 'high') return 'assured';
  if (values.kind === 'platform' || values.reusable) return 'platform';
  if (values.kind === 'service' || values.operations) return 'service';
  if (values.kind === 'product' || values.userInterface) return 'product';
  return 'lean';
}

function ask(interface_, question) {
  return new Promise((resolve) => interface_.question(question, (answer) => resolve(answer.trim())));
}

function yes(value) {
  return /^(?:y|yes|true|1|예|네)$/iu.test(String(value || '').trim());
}

async function selectProject(projects, streams) {
  const input = streams && streams.input ? streams.input : process.stdin;
  const output = streams && streams.output ? streams.output : process.stdout;
  if (!input.isTTY || !output.isTTY) throw new Error('프로젝트 선택은 대화형 터미널에서만 사용할 수 있습니다.');
  const interface_ = streams && streams.ask ? null : readline.createInterface({ input, output });
  const askValue = streams && streams.ask ? streams.ask : (question) => ask(interface_, question);
  try {
    output.write(projects.map((project, index) => `${index + 1}) ${project}`).join('\n') + '\n');
    const answer = String(await askValue('연결할 프로젝트 번호 또는 키: ')).trim();
    const index = Number.parseInt(answer, 10);
    const selected = Number.isInteger(index) && String(index) === answer ? projects[index - 1] : answer;
    if (!projects.includes(selected)) throw new Error(`선택할 수 없는 프로젝트입니다: ${answer}`);
    return selected;
  } finally {
    if (interface_) interface_.close();
  }
}

async function guidedProjectInput(seed, streams) {
  const input = streams && streams.input ? streams.input : process.stdin;
  const output = streams && streams.output ? streams.output : process.stdout;
  if (!input.isTTY || !output.isTTY) throw new Error('--guided는 대화형 터미널에서만 사용할 수 있습니다. 자동화에서는 --profile을 지정하세요.');
  const interface_ = streams && streams.ask ? null : readline.createInterface({ input, output });
  const askValue = streams && streams.ask ? streams.ask : (question) => ask(interface_, question);
  try {
    const key = seed.key || String(await askValue('프로젝트 키(영문 소문자/숫자/하이픈): ')).trim();
    const name = seed.name || String(await askValue('프로젝트 이름: ')).trim();
    let recommended = 'lean';
    const traits = Array.isArray(seed.traits) ? seed.traits.slice() : [];
    const reasons = [];
    if (!seed.profile) {
      const kind = (String(await askValue('성격(product/service/platform/other) [other]: ')).trim() || 'other').toLowerCase();
      const ui = yes(await askValue('사용자 화면과 상호작용이 핵심인가요? [y/N]: '));
      const data = yes(await askValue('데이터 모델·저장소 설계가 핵심인가요? [y/N]: '));
      const api = yes(await askValue('외부 또는 내부 API 계약이 필요한가요? [y/N]: '));
      const component = yes(await askValue('재사용 컴포넌트·플랫폼 성격이 있나요? [y/N]: '));
      const operations = yes(await askValue('상시 운영·장애 대응이 필요한가요? [y/N]: '));
      const regulated = yes(await askValue('규제·감사·고보증 증적이 필요한가요? [y/N]: '));
      const terminology = yes(await askValue('공통 용어집이 중요한 도메인인가요? [y/N]: '));
      if (ui) traits.push('ui');
      if (data) traits.push('data');
      if (api) traits.push('api');
      if (component) traits.push('component');
      if (operations) traits.push('operations');
      if (regulated) traits.push('security-regulation');
      if (terminology) traits.push('terminology');
      for (const trait of traits) reasons.push(`${trait} 응답을 문서 정책 신호로 반영`);
      const reusable = component || kind === 'platform';
      recommended = recommendProfile({ kind, operations, reusable, regulated });
      output.write(`권장 프로필: ${recommended}\n`);
      for (const reason of reasons) output.write(`- ${reason}\n`);
    }
    output.write('문서 프로필: 1) lean  2) product  3) service  4) platform  5) assured\n');
    const rawProfile = seed.profile || String(await askValue(`프로필 번호 또는 이름 [${recommended}]: `)).trim();
    const profile = PROFILE_ALIASES.get((rawProfile || recommended).toLowerCase());
    if (!profile) throw new Error(`지원하지 않는 문서 프로필입니다: ${rawProfile}`);
    return { key, name, profile, traits, reasons };
  } finally {
    if (interface_) interface_.close();
  }
}

module.exports = { recommendProfile, selectProject, guidedProjectInput };
