# Board와 협업 API

`rdl board`는 `127.0.0.1`에만 바인딩되는 로컬 UI와 JSON API를 제공한다. 변경 요청에는 실행 시 생성되는 `X-Rundol-Token`이 필요하다.

## 조회 API

- `GET /api/overview`: Workspace 전체 프로젝트와 상태 집계
- `GET /api/projects`: 프로젝트 목록
- `GET /api/projects/:key/board-snapshot`: 영역별 revision, 프로젝트, 문서 본문, 태스크, Needs Attention, 책임구조, Client, 임대와 Git 상태 통합 조회
- `GET /api/projects/:key/tasks`: 검색·필터 가능한 태스크 목록
- `GET /api/projects/:key/documents`: 정본 Markdown 문서와 연결 메타데이터
- `GET /api/projects/:key/leases`: 유효한 문서 소프트 임대
- `GET /api/projects/:key/sync`: HEAD, upstream, ahead/behind, 변경·충돌 상태
- `GET /api/clients`: Workspace Client Registry

## 변경 API

- `POST /api/projects/:key/tasks`
- `POST /api/projects/:key/tasks/:taskId`
- `POST /api/projects/:key/documents/:documentId`: `baseRevision`과 Markdown `body`를 받아 검증 후 저장
- `POST /api/projects/:key/leases/:documentId/acquire|renew|release`
- `POST /api/projects/:key/refresh`
- `POST /api/projects/:key/sync`
- `POST /api/clients`
- `POST /api/clients/:clientId/enable|disable`

태스크와 문서 수정은 조회 응답의 `revision`을 `baseRevision`으로 전달해야 한다. 현재 revision과 다르면 서버는 `409 Conflict`와 최신 엔티티를 반환하며 기존 변경을 덮어쓰지 않는다. 문서 저장은 frontmatter를 보존하고 `rdl check --strict` 실패 시 원본으로 롤백한다.

## Workspace UI

- 데스크톱은 Navigation, Main content, Context의 3패널 구조를 사용한다.
- 기본 내비게이션은 홈, 내 작업, 문서, 태스크와 검토를 제공한다.
- 문서는 목록·유형·검색으로 탐색하고 Markdown 읽기 화면과 typed metadata Context를 제공한다.
- 문서 편집은 명시적인 편집 모드에서만 시작하며 저장 시 base revision을 검사한다.
- Home은 검토자·담당자·완료조건·연결·선행 태스크와 Git 상태에서 파생한 Needs Attention을 우선 표시한다.
- Member·Role·Stakeholder는 People, Sync·Lease 상태는 Operations, Client와 정책은 Settings로 분리한다.
- 720px 이하에서는 Navigation과 Context를 별도 drawer로 연다.

Client의 `active`는 등록 정책 상태이며 온라인 상태가 아니다. Client ID는 인증 수단이 아니고 실제 쓰기 권한은 Git 자격 증명과 로컬 세션 토큰으로 제한한다. 문서 임대는 충돌 가능성을 낮추는 Git 기반 소프트 임대이며 강한 잠금이나 문자 단위 공동 편집을 의미하지 않는다.
