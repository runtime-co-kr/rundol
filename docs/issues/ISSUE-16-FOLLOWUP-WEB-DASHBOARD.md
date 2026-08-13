# 이슈 초안: #16 완료 후 멀티 프로젝트 웹 대시보드 도입

## 이슈 정보

| 항목 | 값 |
|---|---|
| 상태 | Draft |
| 선행 이슈 | [#16 Workspace 도메인, Client Registry 및 Git 소프트 임대 구조 도입](https://gitlab.runtime.co.kr/rundol/rundol/-/issues/16) |
| 담당자 | 미정 — 프로젝트 Maintainer가 이슈 등록 시 지정 |
| 리뷰어 | 미정 — Board 및 Workspace 모듈 리뷰 담당자가 지정 |
| 주요 이해관계자 | Rundol 로컬 사용자, 폐쇄망 운영자, 프로젝트 관리자, AI Client 운영자 |
| 결정권자 | 미정 — Rundol 제품·기술 책임자가 범위 변경과 완료 승인 담당 |

## 배경

현재 Rundol Board는 단일 프로젝트의 Kanban과 역할·멤버·이해관계자 관리에 집중되어 있다. #16이 완료되면 `rundol/workspace`, 프로젝트 Registry, Client Registry, Client별 JSONL 소프트 임대, 프로젝트별 로컬 상태와 로그를 사용할 수 있다.

이 기반을 웹 UI에 연결해 다음 질문에 답하는 로컬 운영 대시보드가 필요하다.

- 여러 프로젝트에서 현재 어떤 작업이 진행 중인가?
- 어떤 작업이 막혔거나 사람의 검토를 기다리는가?
- 어떤 사람·장치·AI Client가 변경을 기록하고 있는가?
- 어떤 문서를 누가 편집 중인 것으로 기록했는가?
- 어떤 프로젝트의 Git 동기화에 문제가 있는가?
- 태스크가 어떤 문서·결정·완료조건·검증과 연결되는가?

## 목표

- 등록된 여러 프로젝트를 하나의 Home에서 조회한다.
- 프로젝트를 전환해도 Board 서버를 재시작하지 않는다.
- 태스크·문서·사람·Client·임대·동기화 상태를 연결해 표시한다.
- Git 기반 5~15초 수준의 준실시간 협업 상태를 사용자에게 명확하게 보여준다.
- Agent의 등록 상태와 실제 실행 상태를 혼동하지 않는다.
- localhost, 파일 및 Git 원본, 오프라인 사용 원칙을 유지한다.

## 성공 기준

- 사용자가 Home 한 화면에서 검토 대기, 막힌 작업, 임대 충돌 및 동기화 오류를 발견할 수 있다.
- 등록된 모든 프로젝트를 서버 재시작 없이 전환할 수 있다.
- 태스크에서 관련 문서, 완료조건, 담당자, 검토자 및 변경 Client를 추적할 수 있다.
- Client의 `active` 상태를 온라인 또는 실행 중 상태로 잘못 표시하지 않는다.
- Git 연결이 끊겨도 로컬 Board 조회와 로컬 변경은 유지된다.
- `rdl check --strict`와 관련 테스트가 통과한다.

## 설계 전제

```text
main
  제품 코드

rundol/workspace
  Workspace manifest
  프로젝트 Registry
  Client Registry
  Client별 JSONL 임대 이벤트

rundol/<project-key>
  project.md
  docs/
  tasks/<client-id>/<segment>.json
```

Client·Agent별 별도 브랜치는 만들지 않는다.

```text
사용하지 않음:
rundol/client/*
rundol/agent/*
```

공유 원본과 로컬 실행 상태를 구분한다.

```text
projects/workspace/
  공유·복구되어야 하는 Workspace 정보

projects/<project-key>/.rundol/state/
  Watch lock과 현재 PC의 실행 상태

projects/<project-key>/.rundol/logs/
  현재 PC의 debug 및 sync 진단 로그
```

## 사용자와 책임

| 사용자 | 주요 책임 | 주요 권한 |
|---|---|---|
| Workspace 관리자 | 프로젝트와 Client Registry 관리 | Client 등록·활성화·비활성화, 전체 상태 조회 |
| 프로젝트 관리자 | 프로젝트 태스크·책임·동기화 관리 | 태스크 관리, 충돌 확인, strict check 및 sync 실행 |
| 프로젝트 멤버 | 태스크·문서 작업 | 태스크 변경, 임대 획득·갱신·반납 |
| AI Client | 연결 Member 책임 아래 변경 기록 | Client별 태스크 파일 및 허용된 임대 이벤트 기록 |
| 리뷰어 | 변경과 완료조건 검증 | Review 상태 판단 및 완료 증거 확인 |

사람, 역할, 이해관계자와 기술적 Client를 하나의 개념으로 합치지 않는다.

## 정보 구조

```text
Rundol
├─ Home
│  ├─ 전체 프로젝트
│  ├─ 내 작업
│  ├─ 검토 대기
│  ├─ 막힌 작업
│  ├─ Client
│  ├─ 편집 임대
│  └─ 동기화 이상
│
├─ Projects
│  └─ <Project>
│     ├─ Overview
│     ├─ Tasks
│     ├─ Documents
│     ├─ Decisions
│     ├─ Validation
│     ├─ People
│     └─ Sync
│
├─ Clients
├─ Leases
└─ Settings
```

## 기능 요구사항

### FR-001 멀티 프로젝트 Home

- `rundol/workspace`에 등록된 모든 활성 프로젝트를 표시한다.
- 프로젝트별 전체·진행·검토·대기·완료 태스크 수를 표시한다.
- 유효 임대 수, 동기화 상태, 마지막 변경 시각을 표시한다.
- 검토 대기, 막힌 태스크, 임대 충돌, push 실패, validation 실패를 주의 필요 목록으로 통합한다.
- 프로젝트 선택 상태를 URL에 반영한다.

### FR-002 태스크 뷰

- Board, List, Review 보기를 제공한다.
- Board는 `todo`, `doing`, `waiting`, `review`, `done` 상태를 사용한다.
- 검색, 프로젝트, 담당자, 우선순위, Client 및 상태 필터를 제공한다.
- 필터와 보기 상태를 URL에 보존한다.
- 프로젝트 간 태스크를 한 화면에서 필터링할 수 있다.

### FR-003 태스크 카드와 상세

태스크 카드에 다음 정보를 표시한다.

- 태스크 ID, 제목, 요약
- 상태와 우선순위
- 담당자와 변경 Client
- 완료조건 진척도
- 관련 문서 수
- 미완료 선행 태스크 수
- 검토자 수
- 마지막 변경 시각

다음 조건에는 경고 배지를 표시한다.

- 담당자 또는 완료조건 없음
- 관련 요구사항 또는 검증 증거 없음
- Review 상태인데 검토자 없음
- 선행 태스크 미완료
- 등록되지 않은 Member·Stakeholder 참조
- 깨진 문서 연결

태스크 상세는 `개요`, `연결 문서`, `완료조건`, `책임`, `변경 이력`으로 구성한다.

### FR-004 태스크 동시 변경 보호

- 태스크 갱신 요청은 `baseRevision`을 포함한다.
- 서버 revision과 다르면 `409 Conflict`를 반환한다.
- 사용자는 최신 상태 불러오기, 차이 비교, 재적용 또는 취소를 선택할 수 있다.
- 나중 요청이 앞선 변경을 조용히 덮어쓰지 않는다.

### FR-005 문서와 추적성

- 문서 ID, 유형, 제목, 소유자, 상태, 관련 태스크 수, 임대 상태와 마지막 변경을 표시한다.
- 요구사항 → 설계 → 모델/API/화면 → 태스크 → 완료조건 → 검증 관계를 계층형 목록으로 표시한다.
- Rundol 읽기 화면, 로컬 파일, Obsidian 및 연결 태스크로 이동할 수 있다.
- 초기 범위에서는 완전한 관계 그래프와 웹 Markdown 공동 편집기를 구현하지 않는다.

### FR-006 Client Registry

- `device`, `agent`, `service` Client를 표시한다.
- Client ID, 이름, 유형, 소유 Member, 등록 상태, 등록자, 등록 시각을 표시한다.
- 마지막 Git 이벤트, 작성 태스크 수, 보유 임대 수를 파생해 표시할 수 있다.
- Workspace 관리자는 Client 등록·활성화·비활성화를 수행할 수 있다.
- `active`는 등록이 유효하다는 뜻이며 온라인·실행 중으로 표현하지 않는다.

### FR-007 문서 소프트 임대

- 프로젝트별 유효 임대를 표시한다.
- 문서, Client, Member, lease ID, 기준 Git revision, 획득·만료 시각을 표시한다.
- acquire, renew, release를 지원한다.
- 임대 만료시간은 #16의 계약을 사용하며 UI는 남은 시간을 표시한다.
- 임대는 완전한 잠금이 아니라 Git 동기화 지연이 있는 소프트 임대임을 표시한다.
- 충돌한 임대는 숨기지 않고 양쪽 Client와 이벤트를 보여준다.
- 충돌 시 문서를 기본 읽기 전용으로 전환하고 이미 입력한 내용은 변경 제안으로 보존한다.

### FR-008 사람과 책임구조

- 역할, Member, Stakeholder와 책임 영역을 표시한다.
- 태스크 담당자와 검토자는 등록 Member만 선택할 수 있다.
- 이해관계자는 등록 Stakeholder만 선택할 수 있다.
- Client 소유자는 등록 Member와 연결되어야 한다.
- 태스크에서 담당자, 검토자, 이해관계자와 변경 Client를 구분한다.

### FR-009 Git 동기화와 충돌

프로젝트별 다음 정보를 표시한다.

- 프로젝트 ref와 현재 HEAD
- remote-tracking ref
- ahead/behind
- working tree 변경 수
- push되지 않은 commit 수
- 마지막 fetch, push, 성공 및 오류
- retry 횟수와 다음 재시도 시각

다음 충돌을 구분한다.

- Git merge conflict
- 태스크 revision 충돌
- 임대 충돌
- Client 파일 충돌
- JSONL 파싱 오류
- 등록되지 않은 Client 이벤트
- schema validation 실패

지원 작업:

- refresh
- sync
- retry
- 충돌 상세 조회
- strict check 실행

강제 push는 제공하지 않는다.

### FR-010 로컬 Watch 상태

- Watch 실행 여부, PID, Client ID, 시작 시각을 표시한다.
- 마지막 파일 감지, fetch, push와 retry 상태를 표시한다.
- 데이터는 프로젝트별 `.rundol/state`와 `.rundol/logs`에서 읽는다.
- PID, lock, 로컬 경로, 로그, 임시 캐시와 인증정보를 Git에 포함하지 않는다.

### FR-011 오프라인 동작

- Git remote 연결 실패 시에도 로컬 Board 조회와 변경을 허용한다.
- push 실패 후 변경은 working tree 또는 로컬 commit에 보존한다.
- 오프라인 상태와 복구 방법을 사용자에게 표시한다.
- 연결 복구 시 자동 또는 수동으로 sync를 재시도할 수 있다.

## API 요구사항

```text
GET  /api/overview
GET  /api/projects
GET  /api/projects/:projectKey

GET  /api/projects/:projectKey/board-snapshot
GET  /api/projects/:projectKey/tasks
GET  /api/projects/:projectKey/tasks/:taskId
POST /api/projects/:projectKey/tasks
POST /api/projects/:projectKey/tasks/:taskId

GET  /api/projects/:projectKey/documents
GET  /api/projects/:projectKey/documents/:documentId

GET  /api/clients
GET  /api/clients/:clientId
POST /api/clients
POST /api/clients/:clientId/status

GET  /api/projects/:projectKey/leases
POST /api/projects/:projectKey/leases/:documentId/acquire
POST /api/projects/:projectKey/leases/:documentId/renew
POST /api/projects/:projectKey/leases/:documentId/release

GET  /api/projects/:projectKey/sync
POST /api/projects/:projectKey/refresh
POST /api/projects/:projectKey/sync

GET  /api/projects/:projectKey/collaboration
GET  /api/projects/:projectKey/revision
```

`board-snapshot`은 한 번의 저장소 읽기로 revision, 상태별 집계, 태스크, Member, 임대와 sync 요약을 반환한다. 상태별로 저장소를 반복해서 읽지 않는다.

## 비기능 요구사항

### 성능

- Watch 프로세스는 메모리 index를 유지한다.
- 파일 변경 시 변경된 파일만 다시 파싱한다.
- revision 변경이 없으면 Board 전체를 다시 렌더링하지 않는다.
- 유휴·백그라운드 상태에서 polling 간격을 늘린다.
- JSONL 이벤트는 500건 또는 1MB에서 다음 segment로 전환한다.
- 디스크 index는 측정 결과 필요성이 확인된 뒤 도입한다.

### 보안

- 기본 서버는 `127.0.0.1`에만 바인딩한다.
- 변경 요청에는 로컬 세션 토큰이 필요하다.
- 임의 경로 파일 접근, 임의 셸, Agent 실행 API를 제공하지 않는다.
- 프로젝트 mount 밖의 파일을 읽거나 수정하지 않는다.
- Git 강제 push를 제공하지 않는다.
- 요청 본문 크기 제한, CSP, frame 차단 정책을 유지한다.
- Client ID만으로 사용자를 인증하지 않는다.

### 접근성

- 모든 상태 변경은 키보드로 수행할 수 있어야 한다.
- Drawer에는 focus trap을 적용하고 닫은 뒤 원래 위치로 focus를 복구한다.
- 저장·동기화 성공과 실패를 `aria-live` 영역으로 알린다.
- 모바일에서는 drag 외에 명시적인 상태 변경 메뉴를 제공한다.

## 감사 이벤트

다음 작업을 추적할 수 있어야 한다.

- Client 등록·활성화·비활성화
- 임대 획득·갱신·반납·충돌
- 태스크 생성·변경
- 충돌 발생·해결
- 수동 sync
- validation 실패

오류에는 프로젝트, Client, 대상 문서·태스크, 작업, 발생 시각과 복구 방법을 포함한다.

## 비범위

- 실제 AI Agent 프로세스 실행과 실행 큐
- Agent stdout·stderr 실시간 로그
- 실행 취소·재시도와 모델·토큰 리소스 관리
- 실시간 사용자 Presence와 커서
- 문자 단위 공동 편집 및 Yjs/CRDT
- WebSocket 협업 Node와 외부 Relay
- 인터넷 원격 접속
- 중앙 권위자가 보장하는 하드 임대
- Gantt와 Roadmap
- 중앙 데이터베이스와 SaaS 인증
- 영구 디스크 context·graph index

## 위험과 대응

| 위험 | 영향 | 대응 |
|---|---|---|
| Git 폴링 지연 중 임대 동시 획득 | 두 Client가 자신을 임대자로 인식 | 소프트 임대 명시, 충돌 표시, 입력을 제안으로 보존 |
| Client `active` 오해 | 실행 중 또는 온라인으로 잘못 판단 | 등록 상태와 최근 이벤트를 분리 표시 |
| 프로젝트 수 증가 | 반복 파일 읽기와 API 지연 | 메모리 index와 단일 snapshot API 사용 |
| 동시 태스크 수정 | 마지막 저장이 이전 변경 덮어씀 | `baseRevision`과 `409 Conflict` 적용 |
| push 실패 | 사용자 변경 유실 우려 | working tree·로컬 commit에 보존하고 상태 표시 |
| 민감한 로컬 상태 Git 포함 | PID·경로·로그 노출 | 프로젝트 `.rundol/` Git 제외 및 strict 검사 |
| Board가 범용 PM 도구로 확장 | 핵심 Agent OS 방향 희석 | Home·검토·Client·Sync·추적성을 우선하고 Gantt 등 제외 |

## 완료조건

### Workspace와 Home

- [ ] schemaVersion 6 Workspace의 모든 활성 프로젝트를 발견한다.
- [ ] 서버 재시작 없이 프로젝트를 전환한다.
- [ ] Home에서 전체 프로젝트, 검토 대기, 막힌 작업, 임대 및 동기화 오류를 표시한다.

### Tasks와 Documents

- [ ] Board, List, Review가 동일한 태스크 원본을 사용한다.
- [ ] 카드에 완료조건, 관련 문서, 의존성 및 변경 Client가 표시된다.
- [ ] 오래된 revision의 수정은 `409 Conflict`로 거부된다.
- [ ] 태스크에서 문서·결정·완료조건·검증 관계를 탐색할 수 있다.

### Clients와 Leases

- [ ] Device, Agent, Service Client를 조회·등록·활성화·비활성화할 수 있다.
- [ ] Client 등록 상태를 온라인 또는 실행 중으로 표시하지 않는다.
- [ ] acquire, renew, release와 만료 처리가 동작한다.
- [ ] 임대 충돌과 Git 지연 가능성을 사용자에게 표시한다.

### Sync와 Offline

- [ ] 프로젝트별 HEAD, remote ref, ahead/behind와 마지막 동기화를 표시한다.
- [ ] push 실패, merge conflict 및 validation 실패를 구분한다.
- [ ] 오프라인에서도 로컬 Board를 사용할 수 있다.
- [ ] push 실패 후 로컬 변경과 commit이 보존된다.

### 품질

- [ ] 기존 Board 테스트가 유지된다.
- [ ] 멀티 프로젝트 집계 테스트를 추가한다.
- [ ] Client Registry API 테스트를 추가한다.
- [ ] 임대 만료·충돌 테스트를 추가한다.
- [ ] revision 충돌 테스트를 추가한다.
- [ ] 오프라인·push 실패 테스트를 추가한다.
- [ ] 1,000개 이상 태스크 샤드의 Board 조회 회귀 테스트를 통과한다.
- [ ] `rdl check --strict`가 오류와 경고 없이 통과한다.

## 구현 순서

1. #16 완료 및 회귀 테스트
2. 멀티 프로젝트 조회 API
3. Home과 프로젝트 전환
4. Board snapshot API와 메모리 index
5. List 및 Review 뷰
6. Client Registry 화면
7. 문서 편집 임대 화면
8. Sync·Offline·Conflict 화면
9. 태스크·문서 추적성 화면
10. 별도 Agent Runner 요구사항 수립

## 후속 결정 필요

- 담당자, 리뷰어 및 최종 결정권자 지정
- 이 문서를 정식 GitLab 이슈 하나로 등록할지 Epic과 하위 이슈로 분리할지 결정
- 웹 Markdown 편집기를 이 범위에 포함할지 별도 이슈로 분리할지 결정
- 임대 충돌 해결 UI와 변경 제안 파일 포맷 확정
- 성능 기준을 측정할 기준 프로젝트와 장비 선정

