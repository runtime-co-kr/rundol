# Board와 협업 API

`rdl board`는 `127.0.0.1`에만 바인딩되는 로컬 UI와 JSON API를 제공한다. 변경 요청에는 실행 시 생성되는 `X-Rundol-Token`이 필요하다. 조회는 토큰을 요구하지 않으며 어떤 조회도 원장을 바꾸지 않는다 — 무엇이 주의를 요구하는지 묻는 행위가 상태를 바꾸면 화면을 열어 두는 것만으로 기록이 자란다.

프로젝트는 두 가지 방법으로 고른다. 경로에 담은 `/api/projects/:key/...`가 명시적인 쪽이고, `?project=<key>` 질의는 선택된 프로젝트에 붙는 짧은 경로에 쓴다. 질의도 없으면 보드를 띄울 때 고른 프로젝트를 쓴다.

## 조회 API

Workspace 범위:

- `GET /api/overview`: Workspace 전체 프로젝트와 상태 집계
- `GET /api/projects`: 프로젝트 목록
- `GET /api/projects/:key`: 프로젝트 하나의 집계
- `GET /api/clients`: Workspace Client Registry
- `GET /api/revision`: 선택 프로젝트의 통합 revision. 폴링이 스냅숏을 다시 받을지 정하는 값이다
- `GET /api/collaboration`: 역할·멤버·이해관계자
- `GET /api/tasks`, `GET /api/tasks/:taskId`: 선택 프로젝트의 태스크
- `GET /api/tasks/:taskId/comments`: 태스크 댓글. `comments`는 시각 순서이고 `threads`는 뿌리와 답글로 접은 같은 값이다

프로젝트 범위:

- `GET /api/projects/:key/board-snapshot`: 영역별 revision, 프로젝트, 문서 본문, 태스크, 댓글, 조치 필요, 책임구조, Client, 계약, 표시 규칙과 Git 상태 통합 조회
- `GET /api/projects/:key/tasks`, `GET /api/projects/:key/tasks/:taskId`
- `GET /api/projects/:key/documents`, `GET /api/projects/:key/documents/:documentId`: 정본 Markdown 문서와 연결 메타데이터
- `GET /api/projects/:key/assets/:name`: 문서에 넣은 그림. 프로젝트 루트 안의 그림 확장자만 내보내고 `nosniff`를 함께 보낸다
- `GET /api/projects/:key/sync`: HEAD, upstream, ahead/behind, 변경·충돌 상태
- `GET /api/projects/:key/contract`: 문서 계약과 유형별 정책
- `GET /api/projects/:key/runs`: 런 갈래(`waiting`·`drivable`·`driving`·`unreadable`)와 승인 가능한 Client 목록
- `GET /api/projects/:key/runs/:runId`: 승인 대화상자가 읽는 한 런의 목표, 지나온 스텝, 사람 게이트, 대상 문서 ID와 이벤트 자취

태스크 목록은 한 요청에서 기본 100건, `limit`으로 최대 500건을 반환한다. `board-snapshot`은 화면이 한 번에 그려야 하므로 그 상한을 받지 않는다.

## 변경 API

- `POST /api/clients`: 이 기기의 Client 등록. `id`, `name`, `type`, `owner`가 필요하다
- `POST /api/clients/:clientId/enable|disable`
- `POST /api/projects/:key/tasks`, `POST /api/projects/:key/tasks/:taskId`
- `POST /api/tasks`, `POST /api/tasks/:taskId`: 선택 프로젝트에 붙는 같은 동작
- `POST /api/tasks/:taskId/comments`: `body`와 선택적 `member`, 답글이면 `parentId`
- `POST /api/projects/:key/documents/:documentId`: `baseRevision`과 Markdown `body`를 받아 검증 후 저장
- `POST /api/projects/:key/documents/:documentId/check`: 저장하지 않고 같은 판정만 돌려준다. 편집 중 검증이 쓰는 자리다
- `POST /api/projects/:key/assets`: `name`과 base64 `data`. 긴 변 한계를 넘으면 비율을 지켜 줄인다
- `POST /api/projects/:key/contract`, `POST /api/projects/:key/contract/plan`
- `POST /api/projects/:key/presentation`: `scope`(`workspace`|`project`)와 `baseRevision`을 받아 `board.json`에 쓴다. 커밋은 `rdl save`가 맡는다
- `POST /api/projects/:key/runs/:runId/approve`: 사람 게이트 승인. `clientId`와 `reason`이 필요하고 `step`은 선택이다
- `POST /api/projects/:key/refresh`, `POST /api/projects/:key/sync`
- `POST /api/refresh`, `POST /api/sync`: 선택 프로젝트에 붙는 같은 동작

`POST /api/collaboration/:memberId`는 `405`로 거부한다. `project.md`는 프로젝트 정본이므로 사람·역할 변경은 `rdl member` 명령만 담당한다 — 같은 파일에 쓰는 경로가 둘이면 검증과 되돌리기가 두 배가 된다.

기본 요청 본문 상한은 64KB이고 그림을 들이는 경로만 예외로 32MB까지 읽어 16MB 그림을 받는다. 문서 본문은 512KB를 넘을 수 없다.

## revision과 충돌

태스크·문서·표시 규칙 수정은 조회 응답의 `revision`을 `baseRevision`으로 전달해야 한다. 현재 revision과 다르면 서버는 `409 Conflict`와 최신 엔티티를 반환하며 기존 변경을 덮어쓰지 않는다. 문서 저장은 frontmatter를 보존하고 `rdl check --strict` 실패 시 원본으로 롤백한다.

댓글은 `baseRevision`을 요구하지 않는다. append-only 이벤트라 남의 댓글을 덮을 수 없고, 리비전을 요구하면 두 사람이 동시에 쓸 때 한 명이 거절당한다 — 논의 때문에 논의가 막히는 구조가 된다. 답글은 같은 태스크에 실재하는 댓글에만 붙으며 깊이는 하나다.

## 신원과 오류 코드

작성 주체는 요청이 주장하는 값이 아니라 이 기기의 등록된 Client다. 요청이 정하게 두면 화면에서 아무 신원이나 적을 수 있고, 그 순간 "누가 남긴 기록인가"가 무너진다. Client ID는 인증 수단이 아니고 실제 쓰기 권한은 Git 자격 증명과 로컬 세션 토큰으로 제한한다. Client의 `active`는 등록 정책 상태이며 온라인 상태가 아니다.

거절에는 종류가 붙는다. 화면이 거절 문장을 뒤져 원인을 되짚으면 말을 다듬는 순간 판정이 깨지므로, 응답이 `code`를 함께 싣는다.

| `code` | 상태 | 뜻 |
|---|---:|---|
| `unknown-client` | 403 | 이 기기가 Registry에 없다. 화면의 등록 절차나 `rdl client register`로 푼다 |
| `inactive-client` | 403 | 등록은 되어 있으나 비활성이다 |
| `workspace-too-old` | 409 | Client 신원을 담지 못하는 구형 Workspace다. `rdl workspace migrate`가 필요하다 |
| `harness-board` | 403 | 하네스가 띄운 보드에서 승인을 시도했다 |
| `missing-approver`, `missing-reason` | 400 | 승인자 Client 또는 승인 사유가 없다 |
| `approval-refused` | 400 | 자격·상태 판정이 승인을 거절했다 |

## 런과 사람 게이트

런 갈래 판정은 `rdl run pending`이 정본이고 보드는 인자를 옮겨 결과를 그린다. 표면마다 판정을 두면 같은 런에 화면과 명령줄이 다른 답을 낸다. 조회는 `reconcile`을 부르지 않으므로 승인하려고 열어 보는 행위와 승인하는 행위의 경계가 남는다.

승인은 `rdl run approve`와 같은 함수가 판정한다. 승인자는 화면에서 고른 활성 human Client여야 하고 그 owner가 프로젝트의 활성 멤버여야 하며, 사유가 없으면 거부한다. 이 기기의 작성자 신원은 승인자가 될 수 없다 — 그 값은 태스크 샤딩이 쓰는 기기 ID이고 유형이 human이 아니다.

`RUNDOL_HARNESS_CHILD=1`로 실행된 보드는 승인만 거부하고 조회는 그대로 제공한다. human 자격을 하네스가 들 수 없다는 것이 사람 게이트의 전부이므로, 그 표면이 자격을 HTTP로 빌려주면 게이트는 이름만 남는다. 무엇이 막혀 있는지는 하네스도 알아야 사람에게 가져갈 수 있다.

구동·재개·정지·소유권 이전은 보드에 두지 않았다. 사람만 풀 수 있는 것과 기계가 이을 수 있는 것은 다른 일이고, 한 화면에 섞으면 승인이 "막힌 것을 미는 단추"로 읽힌다.

## Workspace UI

- 데스크톱은 Navigation, Main content, Context의 3패널 구조를 사용한다.
- 기본 내비게이션은 홈, 문서, 태스크, 런, 사람과 역할, 설정을 제공한다.
- 문서는 목록·유형·검색으로 탐색하고 Markdown 읽기 화면과 typed metadata Context를 제공한다.
- 문서 편집은 명시적인 편집 모드에서만 시작하며 저장 시 base revision을 검사한다. 편집 중에는 폴링이 화면을 갈아치우지 않는다.
- 태스크 댓글은 같은 문서 편집기로 쓴다. 그림 붙여넣기, `[[문서 링크`, 서식과 표가 댓글에서도 되며 편집기 번들이 없으면 입력칸으로 떨어진다.
- Home은 검토자·담당자·완료조건·연결·선행 태스크에서 파생한 조치 필요를 우선 표시한다. 태스크 단위로 묶고 등급(error·warning·info)을 태그로 보여주며 등급으로 걸러 볼 수 있다.
- Git 상태는 조치 필요에 넣지 않는다. 목록은 봐야 할 문제이고 동기화는 누르면 커밋과 push가 일어나는 실행이므로, 헤더의 동기화가 그 일을 갖는다.
- 런 화면은 사람을 기다리는 런·이어서 몰 수 있는 런·구동 중인 런을 갈래대로 보여 주고 사람 게이트를 그 자리에서 승인한다. 승인 화면은 런의 목표, 지나온 스텝과 대상 문서 본문을 문서 화면과 같은 렌더 경로로 그린다.
- 미등록 기기는 하려던 일 위에서 등록한다. 편집·댓글·동기화가 `unknown-client`로 막히면 등록 절차가 열리고, 마치면 누르려던 일이 이어진다. 등록 칸은 화면 전체에 한 벌만 있고 설정 화면은 같은 절차로 들어가는 문일 뿐이다. push 확인처럼 되돌리기 어려운 동작의 확인은 등록이 대신 눌러 주지 않는다.
- Member·Role·Stakeholder는 사람과 역할 화면이, 문서 계약·표시 규칙·승인 정책·Client는 설정 화면이 갖는다. Sync 상태는 화면이 아니라 헤더의 동기화 단추에 붙는다 — 상태를 보는 자리와 실행하는 자리가 갈리면 무엇을 눌러야 하는지 다시 찾아야 한다.
- 720px 이하에서는 Navigation과 Context를 별도 drawer로 연다.

## 폐기한 것

문서 소프트 임대와 그 조회·변경 API는 0.36에서 폐기했다. 만료 시각으로 배타를 주장하려면 공통 시계와 즉시 관측 가능한 공유 상태, 그리고 만료를 판정하는 단일 권위가 있어야 하는데 중앙 서버 없는 Git 구조에는 셋 다 없다. 그래서 그 기능이 준 것은 보장이 아니라 조언이었고, 명령과 화면은 잠금처럼 보였다. 지금은 같은 문서를 동시에 고치면 저장 시 `baseRevision` 비교가 `409 Conflict`로 막고, 그 뒤의 판정은 Git 병합이 한다. 근거는 ADR-015에 있다.
