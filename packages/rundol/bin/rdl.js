#!/usr/bin/env node
'use strict';

// @rundol/cli는 전이 의존이라 npm이 그 bin을 전역 링크하지 않는다. 그래서 통합
// 배포판이 rdl 이름을 직접 선언하고 여기서 넘긴다.
//
// 넘기는 데 프로세스를 새로 띄우지는 않는다. 대상 CLI는 require.main을 검사하지
// 않고 argv[1]로 자기 위치를 찾지도 않으며 process.exit 대신 exitCode만 설정하므로,
// require로 들여도 직접 실행과 동작이 같다 — 종료 코드와 출력이 같은지는
// tarball-compat 시험이 지킨다. 자식 프로세스를 띄우면 Node 시작이 한 번 더
// 붙고, 그 비용이 명령마다 붙는다.
require('@rundol/cli/dist/bin/rdl.js');
