'use strict';

// 판정 계층의 순수성 불변식. 이 시험이 지키는 것은 코드 취향이 아니라 제품의 전제다.
//
// 사람 워커와 에이전트 워커가 같은 계층이려면 같은 검수 판정을 받아야 하고,
// 같은 판정을 명령줄·보드·워커 어댑터·지속적 통합 네 곳에서 얻으려면 판정 함수가
// 파일을 몰라야 한다. 판정이 파일을 아는 순간 각 표면은 자기 경로로 다시 구현하게
// 되고, 다시 구현한 것들은 조금씩 달라진다.
//
// 직접 require만 보면 충분하지 않다. 겉으로 순수해 보이는 모듈이 작업공간 모듈을
// 타고 파일 시스템에 닿는 경우가 실제로 있었다. 그래서 전이 의존까지 따라간다.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sourceRoot = path.resolve(__dirname, '..', 'src');

// 판정 계층에 있어야 할 모듈. 여기 이름을 올리는 것은 "이 모듈은 값만 보고 답한다"는
// 선언이며, 그 선언을 이 시험이 강제한다.
const PURE_MODULES = ['worker-contract', 'check-rules'];

// 값 판정이 닿으면 안 되는 것들. 파일·프로세스·저장소·작업공간이 그 넷이다.
const FORBIDDEN_BUILTINS = new Set(['fs', 'fs/promises', 'child_process', 'http', 'https', 'net', 'dns']);
const FORBIDDEN_LOCAL = new Set(['git', 'workspace', 'tasks', 'state', 'event-store', 'settings', 'runtime', 'collaboration-store', 'request-journal', 'query-index', 'watch', 'debug']);

const REQUIRE_PATTERN = /require\(\s*'([^']+)'\s*\)/gu;

function readRequires(moduleName) {
  const file = path.join(sourceRoot, `${moduleName}.js`);
  assert(fs.existsSync(file), `순수 모듈로 선언된 파일이 없습니다: ${file}`);
  const source = fs.readFileSync(file, 'utf8');
  const found = [];
  let match = REQUIRE_PATTERN.exec(source);
  while (match) {
    found.push(match[1]);
    match = REQUIRE_PATTERN.exec(source);
  }
  REQUIRE_PATTERN.lastIndex = 0;
  return found;
}

/** 한 모듈에서 출발해 지역 require를 타고 내려가며 닿는 모든 것을 모은다. */
function transitiveClosure(entry) {
  const seen = new Set();
  const reached = [];
  const queue = [{ name: entry, chain: [entry] }];
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current.name)) continue;
    seen.add(current.name);
    for (const specifier of readRequires(current.name)) {
      const local = specifier.startsWith('./');
      const name = local ? specifier.slice(2) : specifier;
      reached.push({ specifier: name, local, chain: current.chain.concat(name) });
      if (local) queue.push({ name, chain: current.chain.concat(name) });
    }
  }
  return reached;
}

for (const moduleName of PURE_MODULES) {
  const reached = transitiveClosure(moduleName);
  for (const item of reached) {
    const forbidden = item.local ? FORBIDDEN_LOCAL.has(item.specifier) : FORBIDDEN_BUILTINS.has(item.specifier);
    assert(
      !forbidden,
      `${moduleName}은 값만으로 판정해야 하는데 ${item.specifier}에 닿습니다. 경로: ${item.chain.join(' -> ')}`
    );
  }
}

// 시험 자체가 무력해지는 경우를 막는다. 금지 목록에 있는 모듈을 넣었을 때 잡히지
// 않으면 위의 통과는 아무것도 증명하지 못한다.
const probe = transitiveClosure('check');
assert(
  probe.some((item) => FORBIDDEN_BUILTINS.has(item.specifier) || FORBIDDEN_LOCAL.has(item.specifier)),
  '금지 의존을 실제로 가진 모듈에서 아무것도 잡히지 않았습니다. 탐지가 동작하지 않습니다.'
);

// 계약을 값으로 못박은 타입 선언이 실제로 있는지 확인한다. 선언이 사라지면 다음
// 사람이 필드를 임의로 늘리게 되고, 그때부터 판정 입력이 표면마다 달라진다.
const typesRoot = path.resolve(__dirname, '..', 'types');
for (const declaration of ['assignment.d.ts', 'report.d.ts']) {
  assert(fs.existsSync(path.join(typesRoot, declaration)), `계약 선언이 없습니다: types/${declaration}`);
}

process.stdout.write('worker contract purity tests passed\n');
