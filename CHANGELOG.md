# 변경 이력

이 문서는 사용자에게 영향을 주는 Rundol 변경을 기록한다. 버전 분류와 tag 규칙은 [버전과 릴리스 정책](docs/RELEASES.md)을 따른다.

## [Unreleased]

## [0.22.4] - 2026-08-14

### Added

- Added the `diagram-v1` document diagram convention. `rdl contract show --json` now publishes `catalog.diagrams` so AI clients and the Board read the accepted Mermaid kinds, the canonical representation, and the selection criterion from the CLI instead of restating them.
- `MOD` documents now carry a Mermaid `erDiagram` in their `관계` section. `rdl check` reports `RDL-MODEL-001` when it is missing and `RDL-MODEL-002` when attribute comments duplicate the entity table.
- Added `conventions.<TYPE>.selection`, which decides each diagram element with one question: whether this document owns the entity's lifecycle, whether a stored field creates the relationship, and whether a cardinality is enforced at write time or at read time.
- The `MOD` template ships a conforming `erDiagram` scaffold, and the governance skill and document standard state the same selection criterion.

### Changed

- The diagram stays a derived view: entity and relationship tables remain canonical for cardinality, field constraints, and lifecycle, and only entities a document owns show attributes. Both findings are warnings, so existing model documents keep passing `rdl check --strict` until they are updated.
- State transitions stay out of relational notation. The per-function `상태와 전이` contract remains their only source of truth, so no second diagram kind was introduced.

### Migration

- Existing `MOD` documents report `RDL-MODEL-001` until an `erDiagram` is added to their `관계` section. This is advisory and blocks neither `rdl save` nor `rdl sync`.
- When adding the diagram, check whether a relationship row states a read-time constraint such as "at most one currently valid" as its stored cardinality. Fix the table first, because the diagram derives from it.

## [0.22.3] - 2026-08-14

### Added

- Expanded Rundol's canonical project specification from the recent document-contract slice to the full Workspace, synchronization, task, collaboration, Board, installation, and release lifecycle.
- Added one-function-per-file REQ and TST pairs for 11 core capabilities, plus bounded Git, Board, data-model, API, decision, runbook, and glossary documents.
- Replaced the placeholder Rundol project charter with explicit mission, goals, scope, responsibilities, risks, review cadence, and Definition of Done.

### Changed

- Rundol's own reference project now demonstrates the governance skill's preferred small-document shape without introducing a generic `DESIGN.md`, index, catalog, or persisted traceability matrix.

### Migration

- No runtime or storage migration is required from 0.22.2. Reinstall the governance skill and use `rdl contract trace` plus `rdl check --strict --implementation` when expanding an existing project's specifications.

## [0.22.2] - 2026-08-14

### Added

- Added `atomic-v1` function contracts for REQ, SCR, MOD, API, and TST documents, including type-specific standalone fields for every declared function ID.
- Added `rdl check --implementation` readiness validation and `rdl contract trace` computed traceability with no persisted index artifact.
- Added implementation-readiness task completion gates, Board contract visibility, and remote default-branch discovery through `origin/HEAD`.

### Changed

- The governance skill now forbids grouped function ranges, combined specification rows, generic `DESIGN.md`, and canonical index or traceability-matrix documents.
- Rundol's own PRD, REQ, architecture, ADR, and TST documents now describe and verify 16 independent function contracts.

### Migration

- Existing 0.21.1–0.22.1 projects should follow [Rundol 0.22 migration](docs/MIGRATION-0.22.md). Existing implementation documents remain warnings under normal strict checks and must be upgraded before enabling the implementation readiness gate.

## [0.22.1] - 2026-08-14

### Added

- Added template-derived component catalogs, non-blocking AI context guidance, and freely editable omission requirements in Board document contract settings.
- Added inherited Board presentation settings from built-in defaults through Workspace and project `board.json` files, including consistent document type and state labels.
- Added Rundol skill routing and CLI/structure diagnostics that treat generic `DESIGN.md` files as preserved migration inputs rather than canonical documents.

### Fixed

- Expanded Markdown reading width, removed the task Board's inner horizontal scroll, and improved inline-code contrast in light and dark themes.
- Unified document type and state vocabulary across navigation, recent documents, cards, lists, and document details.

### Migration

- Existing 0.22.0 projects need no contract or storage migration. Reinstall the governance skill to receive canonical design routing; optional `board.json` files can override presentation labels without changing document identity or paths.

## [0.22.0] - 2026-08-14

### Added

- Added schemaVersion 2 document planning contracts with enforcement, authoring prerequisites, omission absorption rules, and deterministic evaluation.
- Added `rdl contract show|next|check|plan|set` and shared contract visibility across bootstrap, document creation, validation, save/sync, the governance skill, and the Board.

### Migration

- Existing `0.21.1`–`0.21.3` workspaces should follow [Rundol 0.22 migration](docs/MIGRATION-0.22.md), configure the contract as advisory first, then enable checkpoint after violations are resolved.

## [0.21.3] - 2026-08-14

### Fixed

- Unix 계열 환경의 개별 CLI 전역 설치 검증이 npm의 `<prefix>/bin` 실행 파일 경로를 사용하도록 수정했습니다.

## [0.21.2] - 2026-08-14

### Added

- Bootstrap discovery와 idempotent `rdl init`/`attach` repair 경로를 통합했습니다.
- 프로젝트 `documentProfile`, guided interview, non-interactive 정책 설정을 지원합니다.
- canonical 문서 경로와 legacy 문서 migration, 통합 QA 및 사용자 문서를 정비했습니다.

## [0.21.1] - 2026-08-12

### Added

- 태스크 완료조건을 Board에서 직접 체크하고 revision 충돌을 검증해 저장한다.
- 설정 화면에 기본 색상과 고대비 흑백 모드를 추가한다.
- Markdown의 Mermaid 코드 블록을 로컬 번들로 SVG 렌더링한다.

### Fixed

- 루트를 private monorepo로 전환하고 `packages/rundol`만 배포 이름을 소유하게 해 Git URL 설치에서 발생하던 dangling package Junction을 제거했다.
- 오른쪽 Context 패널을 접은 뒤 펼치기 버튼이 잘려 복구할 수 없던 레이아웃을 수정한다.
- 데스크톱 접힘과 모바일 오버레이 상태가 동시에 남지 않도록 패널 상태를 정규화한다.
- 설정 버튼의 화면 이동과 테마 상태 표시를 회귀 테스트한다.

## [0.21.0] - 2026-08-12

### Added

- Navigation·Main·Context 3패널 Board Shell과 Documents 1급 탐색·읽기 화면
- 영역별 revision을 포함한 Workspace Snapshot과 Needs Attention 파생 상태
- base revision 및 strict validation 롤백을 적용한 Markdown 문서 편집 API와 UI
- People, Operations, Settings 분리 화면과 모바일 Navigation·Context drawer

### Changed

- Home을 단순 태스크 개수에서 최근 문서와 조치 필요 항목 중심으로 재구성했다.
- Tasks를 목록 우선으로 제공하고 Board를 선택 가능한 보기로 변경했다.

## [0.20.1] - 2026-08-12

### Added

- Workspace JSONL 이벤트와 Git CAS 재시도로 동시 문서 번호를 중복 없이 예약한다.

### Changed

- Workspace와 프로젝트 동시 fetch가 공용 `FETCH_HEAD`를 덮어쓰지 않도록 브랜치별 원격 ref를 사용한다.
- README와 상세 문서의 저장 경로, 설치, Obsidian, 명령 예제와 릴리스 정책을 일관되게 정리했다.

## [0.20.0] - 2026-08-11

### Added

- schemaVersion 6 Workspace, Client Registry와 분할 JSONL 문서 임대 이벤트
- 프로젝트 로컬 `.rundol/state`, `.rundol/logs` 실행 상태와 Workspace·Client·Lease CLI
- 멀티 프로젝트 Board Home, 프로젝트 전환, 문서·동기화·임대·Client API와 통합 snapshot
- 태스크 엔티티 revision 및 오래된 수정의 `409 Conflict` 처리

### Changed

- Workspace 공통 상태를 `projects/workspace/`, 프로젝트 상태를 `projects/<key>/`에 연결한다.
- Git safe-directory 판별을 실제 저장소 루트 기준으로 수행한다.

## [0.19.0] - 2026-08-11

### Added

- 저장소 내부 `.rundol` 없이 OS 사용자 runtime state를 사용하는 schemaVersion 5 Workspace
- 원격 `rundol/settings`와 `rundol/<project-key>`를 복원하는 `rdl attach` 및 `rdl detach`
- 프로젝트별 Obsidian Vault와 `rdl check --structure`, `rdl cleanup --apply`
- npm workspaces 기반 `core`, `protocol`, `cli`, `node`, `board`, 통합 `rundol` 패키지 경계

### Changed

- 신규 프로젝트의 Obsidian Vault 루트를 `projects/<project-key>`로 변경
- main `.gitignore` 대신 로컬 `.git/info/exclude`로 프로젝트 worktree를 숨김
- 빈 `.gitkeep` 기본 생성을 제거하고 선택 디렉터리를 필요할 때 로컬 생성

## [0.18.0] - 2026-08-11

### Added

- CLI·LLM·혼합 액션 라우팅과 실제 executor·fallback·채택률 debug 집계
- `rdl task acceptance`를 통한 완료조건 상태 변경
- 미보고 LLM 토큰 이벤트의 명시적 구분

### Fixed

- 종료 코드가 0이 아닌 검증 결과를 debug 성공으로 기록하던 문제
- PRD 입력 제목에 `제품 요구사항` 접미사를 중복 추가하던 문제

## [0.17.0] - 2026-08-11

### Added

- `rdl doctor` 구조화 설치 진단과 독립 `scripts/install-doctor.js`
- GitHub·GitLab HTTPS/SSH 설치, HTTP/1.1 fallback, PATH와 손상 설치 복구 문서
- tarball·Git URL 전역 설치와 손상 package 감지 회귀 테스트

## [0.16.0] - 2026-08-11

### Added

- `rundol/settings` 브랜치와 schemaVersion 4 Workspace
- client ID 기반 최대 500건 태스크 샤드와 단일 `tasks.json` 마이그레이션
- `rdl sync watch`, 충돌 조회·해결 CLI, 표준 문서 생성, debug token 집계
- Board 자동 갱신, 빠른 태스크 생성, drag/drop과 확장된 협업 정보 UI

### Changed

- AI 클라이언트 거버넌스 스킬이 settings와 태스크 샤드 구조를 따르도록 갱신됐다.

## [0.15.0] - 2026-08-11

### Changed

- 중복된 SPC 문서 체계를 REQ로 통합하고 CLI·문서 표준을 정리했다.
