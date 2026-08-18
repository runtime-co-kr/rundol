'use strict';

// 종단 경로를 증명하기 위한 스텁 어댑터. 모델을 부르지 않는다 — 배선이 도는지와
// 렌즈가 판별하는지는 다른 물음이고, 전자는 스텁으로 증명된다. 스텁으로 경로가
// 돌지 않으면 실제 어댑터를 붙여도 돌지 않는다.
//
// 어댑터 규약: instruction.json과 context.json을 읽고 result.json을 쓴다.
//   author 모드  {claims, artifactIds}
//   verify 모드  {verdict, findings}

const fs = require('fs');

const [instructionFile, contextFile, resultFile] = process.argv.slice(2);
if (!instructionFile || !contextFile || !resultFile) {
  process.stderr.write('스텁 어댑터에는 instruction·context·result 경로가 필요합니다.\n');
  process.exit(2);
}

const instruction = JSON.parse(fs.readFileSync(instructionFile, 'utf8'));
const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));

// 모드는 지시문이 정한다. context에는 lensId가 검증일 때만 있다.
const mode = instruction.allowedMode === 'verify' || context.lensId ? 'verify' : 'author';

if (mode === 'author') {
  // 저작 스텝은 대상 문서를 실제로 고친다. 고치지 않으면 이 경로가 무엇을
  // 증명하는지 알 수 없다 — 검증이 깨끗한 worktree를 요구하는지도 여기서 드러난다.
  const target = context.target;
  if (target && fs.existsSync(target)) {
    const before = fs.readFileSync(target, 'utf8');
    if (!before.includes('스텁 어댑터가 덧붙인 줄')) {
      fs.writeFileSync(target, `${before.replace(/\s*$/u, '')}\n\n스텁 어댑터가 덧붙인 줄\n`, 'utf8');
    }
  }
  const artifactIds = process.env.RUNDOL_STUB_ARTIFACT ? [process.env.RUNDOL_STUB_ARTIFACT] : [];
  fs.writeFileSync(resultFile, `${JSON.stringify({ claims: ['스텁 저작'], artifactIds })}\n`, 'utf8');
  process.exit(0);
}

// 검증 판정은 환경으로 정한다. 렌즈 판별력은 실제 어댑터가 붙은 뒤 잴 것이고,
// 여기서는 통과와 반박 양쪽 경로가 도는지만 본다.
const verdict = process.env.RUNDOL_STUB_VERDICT || 'pass';
fs.writeFileSync(resultFile, `${JSON.stringify({ verdict, findings: [] })}\n`, 'utf8');
process.exit(0);
