'use strict';

// 고아가 될 손자. 자기 pid를 남기고 오래 살아 있는다. 시험이 끝나면 스스로도
// 사라지도록 상한을 둔다 — 시험이 프로세스를 흘리면 그것도 결함이다.

const fs = require('fs');

const [pidFile] = process.argv.slice(2);
fs.writeFileSync(pidFile, String(process.pid), 'utf8');
setTimeout(() => process.exit(0), 30000);
