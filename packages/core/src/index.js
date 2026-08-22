'use strict';

// 공통 도메인 계약. 협업 노드가 채워질 자리이며, 지금은 값 선언만 갖는다.
//
// 이 패키지는 게시될 때 저장소의 `src/`를 함께 싣지 않는다. 그래서 값 목록의
// 정본(`src/vocabulary.js`)을 require할 수 없고, 같은 값을 여기 한 번 더 적는다.
//
// 두 번 적는 것이 안전한 이유는 파일이 아니라 시험이다. test/vocabulary.test.js가
// 아래 값이 정본과 같은지 확인하며, 갈리면 `npm test`가 실패한다. 그 시험이 없던
// 동안 TASK_STATES는 `cancelled`가 빠진 채로 최초 커밋부터 방치되었다 — 상태를
// 하나 늘린 커밋(1e9db63)이 열두 파일을 고치면서 여기를 지나쳤고, 아무도 그 사실을
// 알지 못했다. 값을 옮기는 것보다 어긋남을 말하게 만드는 것이 먼저다.
//
// 여기 값을 고칠 때는 정본을 먼저 고치고 그 결과를 옮긴다. 반대 방향으로 하면
// 정본이 아닌 것이 정본이 된다.

/** 태스크 상태. 저장 순서이며 `src/vocabulary.js`의 TASK_STATES와 같아야 한다. */
const TASK_STATES = Object.freeze(['todo', 'doing', 'waiting', 'review', 'done', 'cancelled']);

/** 실행 주체. `src/vocabulary.js`의 EXECUTORS와 같아야 한다. */
const EXECUTORS = Object.freeze(['cli', 'llm', 'hybrid']);

/** 브랜치 이름 규칙. 프로젝트 ref는 언제나 `refs/heads/rundol/<key>`다. */
const BRANCHES = Object.freeze({ settings: 'rundol/settings', project: (key) => `rundol/${key}` });

module.exports = { TASK_STATES, EXECUTORS, BRANCHES };
