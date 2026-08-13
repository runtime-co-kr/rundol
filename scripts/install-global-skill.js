'use strict';

// 스킬 설치 로직은 src/skill.js가 정본이다. 이 스크립트는 수동 실행용 진입점이며
// npm postinstall로 연결하지 않는다. npm 전역 + git URL 설치에서 postinstall이 있으면
// npm이 패키지를 복사하지 않고 캐시 임시 클론에 링크해 설치가 깨진다.
const { installSkill } = require('../src/skill');

const shouldRun = process.env.npm_config_global === 'true' || process.argv.includes('--force');
if (!shouldRun) process.exit(0);

const result = installSkill();
for (const item of result.targets) {
  if (item.status === 'preserved') process.stderr.write(`[rundol] Existing unmanaged ${item.client} skill was preserved: ${item.target}\n`);
  else process.stdout.write(`[rundol] Installed ${item.client} skill: ${item.target}\n`);
}
