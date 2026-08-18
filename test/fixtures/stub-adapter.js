'use strict';

// 종단 경로를 증명하기 위한 스텁 어댑터. 모델을 부르지 않는다 — 배선이 도는지와
// 렌즈가 판별하는지는 다른 물음이고, 전자는 스텁으로 증명된다. 스텁으로 경로가
// 돌지 않으면 실제 어댑터를 붙여도 돌지 않는다.
//
// 어댑터 규약: instruction.json과 context.json을 읽고 result.json을 쓴다.
//   author 모드  {claims, artifactIds}
//   verify 모드  {verdict, findings}

const fs = require('fs');
const path = require('path');

const [instructionFile, contextFile, resultFile] = process.argv.slice(2);
if (!instructionFile || !contextFile || !resultFile) {
  process.stderr.write('스텁 어댑터에는 instruction·context·result 경로가 필요합니다.\n');
  process.exit(2);
}

const instruction = JSON.parse(fs.readFileSync(instructionFile, 'utf8'));
const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));

// 이 스텁의 행동은 파일로 정한다. 환경 변수로는 정할 수 없다 — 하네스는 자식에게
// 닫힌 allowlist만 넘기므로 RUNDOL_STUB_* 는 여기까지 오지 않는다.
//
// 경로는 cwd 기준으로 찾을 수도 없다. 저작은 격리 worktree에서 도는데 .rundol/은
// gitignore 대상이라 그 트리에 없기 때문이다. 대신 하네스가 절대 경로로 넘겨 준
// context.json에서 거슬러 올라가 찾는다 — 그것은 언제나 본 트리의 .rundol 아래에 있다.
//
// 이 두 번의 실수는 같은 종류다. 시험이 무엇을 시켰는지 확인하지 않으면, 스텁은
// 조용히 기본값으로 돌고 시험은 자기가 아무것도 시키지 않은 줄 모른 채 통과한다.
function findControl(from) {
  let current = path.resolve(from);
  for (let depth = 0; depth < 12; depth += 1) {
    if (path.basename(current) === '.rundol') {
      const candidate = path.join(current, 'stub-control.json');
      if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return {};
}
const control = findControl(path.dirname(contextFile));

// 모드는 지시문이 정한다. context에는 lensId가 검증일 때만 있다.
const mode = instruction.allowedMode === 'verify' || context.lensId ? 'verify' : 'author';

if (mode === 'author') {
  // 대상 밖에 쓰는 저작자. 하네스가 이것을 막는지 보기 위한 것이고, 막지 못하면
  // 문서 한 편을 쓰라는 권한이 프로젝트 전체 쓰기가 된다.
  if (control.stray) fs.writeFileSync(control.stray, '스텁이 대상 밖에 쓴 파일\n', 'utf8');
  // 저작 스텝은 대상 문서를 실제로 고친다. 고치지 않으면 이 경로가 무엇을
  // 증명하는지 알 수 없다 — 검증이 깨끗한 worktree를 요구하는지도 여기서 드러난다.
  const target = context.target;
  if (target && fs.existsSync(target)) {
    const before = fs.readFileSync(target, 'utf8');
    if (!before.includes('스텁 어댑터가 덧붙인 줄')) {
      fs.writeFileSync(target, `${before.replace(/\s*$/u, '')}\n\n스텁 어댑터가 덧붙인 줄\n`, 'utf8');
    }
  }
  const artifactIds = control.artifactId ? [control.artifactId] : [];
  fs.writeFileSync(resultFile, `${JSON.stringify({ claims: ['스텁 저작'], artifactIds })}\n`, 'utf8');
  process.exit(0);
}

// 검증 판정은 환경으로 정한다. 렌즈 판별력은 실제 어댑터가 붙은 뒤 잴 것이고,
// 여기서는 통과와 반박 양쪽 경로가 도는지만 본다.
const verdict = control.verdict || 'pass';
fs.writeFileSync(resultFile, `${JSON.stringify({ verdict, findings: [] })}\n`, 'utf8');
process.exit(0);
