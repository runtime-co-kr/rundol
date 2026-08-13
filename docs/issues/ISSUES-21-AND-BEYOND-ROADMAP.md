# Rundol #21 이후 후속 이슈 로드맵

## 문서 정보

| 항목 | 값 |
|---|---|
| 상태 | Draft |
| 목적 | GitLab #1~#20 이후의 구현 순서와 이슈 경계를 검토하기 위한 로컬 초안 |
| 담당자 | 미정 — Rundol Maintainer가 각 이슈 등록 시 지정 |
| 리뷰어 | 미정 — Core, Board, Agent Runtime, Security 담당자가 이슈별 지정 |
| 결정권자 | 미정 — 제품·기술 책임자가 신규 범위와 우선순위 승인 |
| 주요 이해관계자 | 로컬 사용자, 폐쇄망 운영자, 프로젝트 관리자, AI Client 운영자, 보안 담당자 |

## 현재 기준선

```text
#15  모노레포 패키지 경계
  ↓
#16  Workspace·Client Registry·Git 소프트 임대
  ↓
#17  멀티 프로젝트 Home
  ↓
#18  태스크·문서·책임·추적성
  ↓
#19  Client·임대 UI
  ↓
#20  Git Watch·충돌·오프라인 운영 화면
```

#20까지 완료하면 Rundol은 Git 기반 멀티 프로젝트 협업 대시보드가 된다. 실제 AI Agent를 실행·관제하는 Agent OS로 확장하려면 #21 이후의 통합 검증, Context Projection, Agent Runner와 보안 경계가 필요하다.

## 기존 열린 이슈 정리 원칙

### #4 실시간 소켓 동기화

- #16~#20 검증 전에는 구현을 보류한다.
- Git Sync로 부족한 지연 문제가 실제로 확인된 경우에만 선택적 LAN 이벤트 가속 계층으로 재정의한다.
- CRDT, P2P, 인터넷 Relay와 원격 셸은 별도 검증 없이 포함하지 않는다.

### #13·#14

- #16 완료 후 중복된 `rundol/settings` 구조를 `rundol/workspace` 기준으로 갱신한다.
- #13은 남은 프로젝트별 Obsidian Vault 항목만 유지한다.
- #14의 구조 감사가 #16에서 충족되면 검증 후 종료한다.

### #16·#19 경계

- #16은 Workspace, Client, Lease 저장 구조와 CLI를 소유한다.
- #19는 Client와 Lease의 Board UI를 소유한다.
- #16의 Board 표시 완료조건은 #19에서 검증한다.

---

# #21 `[E2E] 폐쇄망 멀티 프로젝트 Git 협업 통합 검증`

## 배경

#17~#20이 각각 완료되어도 실제 폐쇄망에서 여러 사용자와 Client가 함께 사용할 때 전체 흐름이 안전하다는 보장은 없다. Agent 기능을 추가하기 전에 Git Sync, Client Registry, 소프트 임대와 오프라인 복구를 하나의 시나리오로 검증해야 한다.

## 목표

- 2~10인 규모의 폐쇄망 협업 시나리오를 재현한다.
- 여러 프로젝트, Device·Agent·Service Client와 사내 GitLab을 함께 검증한다.
- 데이터 유실, 임대 충돌, push 실패와 오프라인 복구의 증거를 남긴다.
- 다음 Agent OS 단계의 기반이 충분한지 Go/No-Go를 결정한다.

## 요구사항

- 프로젝트 2개 이상을 동시에 연결하고 Home에서 집계한다.
- Client 3개 이상이 서로 다른 태스크 shard와 임대 이벤트를 작성한다.
- 활성 상태 5~15초 Git Watch, 유휴 backoff와 재접속을 검증한다.
- 문서 임대 획득, 갱신, 만료, 동시 획득과 충돌 처리를 검증한다.
- 네트워크 단절 중 태스크·문서 변경 후 재접속을 검증한다.
- non-fast-forward, merge conflict, schema 오류와 JSONL 손상을 재현한다.
- 1,000개와 10,000개 태스크 fixture에서 Board·CLI 성능을 측정한다.
- Windows를 기본 검증 환경으로 하고 Linux 동작 차이를 기록한다.
- main 브랜치가 Rundol 파일 변경을 요구하지 않는지 확인한다.

## 비범위

- Agent 프로세스 실행
- WebSocket·Yjs·P2P·Relay
- SaaS 사용자 관리
- 성능 문제를 측정하지 않고 디스크 index를 선도입하는 작업

## 완료조건

- [ ] 신규 설치부터 Workspace 연결까지 재현 가능한 절차가 있다.
- [ ] 여러 Client의 태스크·임대 변경이 원본과 Board에서 일치한다.
- [ ] 오프라인 변경과 로컬 commit이 유실되지 않는다.
- [ ] 충돌 발생·표시·해결·재검증 흐름이 통과한다.
- [ ] 성능 기준과 실제 측정 결과가 기록된다.
- [ ] 모든 실패 시나리오에 복구 절차와 증거가 있다.
- [ ] `rdl check --strict`와 E2E 테스트가 통과한다.
- [ ] Agent Runtime 단계 진행 여부가 결정 기록으로 남는다.

## 의존성

`#15`, `#16`, `#17`, `#18`, `#19`, `#20`

---

# #22 `[Context] 프로젝트 지식 그래프와 AI Context Projection`

## 배경

AI Client가 매번 저장소 전체를 검색하면 토큰, 속도와 결과 일관성이 나빠진다. Rundol이 문서·태스크·책임·검증 관계를 정규화해 AI가 작은 공통 Context를 읽게 해야 한다.

## 목표

```bash
rdl ctx TASK-104
```

명령으로 Task 수행에 필요한 프로젝트 Context를 결정적으로 생성한다.

## 요구사항

- 태스크, 요구사항, 결정, 설계, 의존성, 완료조건, 검증과 책임을 연결한다.
- 문서와 태스크의 양방향 관계 index를 메모리에서 생성한다.
- 동일 Git 상태와 옵션에서는 동일한 Context를 생성한다.
- Context schema와 version을 정의한다.
- 프로젝트 경계와 문서 접근 정책을 적용한다.
- 토큰 예산에 따라 원문, 요약, 링크-only 단계로 축약한다.
- stale index와 깨진 관계를 감지한다.
- 결과에 사용한 source 파일과 revision을 포함한다.
- Codex, Claude Code, Gemini CLI가 같은 입력 계약을 사용할 수 있어야 한다.

## 출력 예

```json
{
  "schemaVersion": 1,
  "project": "crm",
  "task": {},
  "requirements": [],
  "decisions": [],
  "designs": [],
  "dependencies": [],
  "acceptanceCriteria": [],
  "validations": [],
  "responsibility": {},
  "sources": []
}
```

## 비범위

- 벡터 DB 필수 도입
- 중앙 검색 서버
- AI가 생성한 요약을 검증 없이 정본으로 저장
- 다른 프로젝트의 내용을 자동 혼합

## 완료조건

- [ ] `rdl ctx <TASK-ID> --json`이 동작한다.
- [ ] 요구사항부터 검증까지의 연결이 source와 함께 반환된다.
- [ ] 깨진 링크와 권한 밖 문서를 Context에서 제외하고 진단한다.
- [ ] 동일 입력의 결정적 출력 테스트가 통과한다.
- [ ] 토큰 예산별 축약 테스트가 통과한다.
- [ ] index 삭제 후 원본에서 재생성할 수 있다.
- [ ] `rdl check --strict`와 Context 회귀 테스트가 통과한다.

## 의존성

`#18`, `#21`

---

# #23 `[Agent] 로컬 Agent Executor Registry 및 Runner 계약`

## 배경

Client Registry의 `agent`는 변경 주체의 식별자일 뿐 실제 실행 프로세스가 아니다. Rundol을 Agent OS로 확장하려면 임의 셸을 제공하지 않으면서 등록된 AI Client를 안전하게 실행하는 로컬 Runner 계약이 필요하다.

## 목표

- Codex, Claude Code, Gemini CLI 등의 실행 프로필을 등록한다.
- 프로젝트와 격리 worktree 범위 안에서만 실행한다.
- 입력·출력과 승인의 공통 계약을 정의한다.
- 원격 세션이 호스트에서 임의 명령을 실행하지 못하게 한다.

## 요구사항

- Executor Profile schema와 version을 정의한다.
- 실행 파일, 정적 인수, 환경변수 allowlist와 timeout을 설정한다.
- Client Registry의 Agent와 Executor Profile을 구분한다.
- 프로젝트별 격리 worktree를 생성·검증·정리한다.
- `rdl ctx` 결과를 표준 입력으로 전달한다.
- 임의 실행 파일과 자유 형식 shell command를 요청에서 받지 않는다.
- 실행 전 프로젝트, Task, Agent, 권한과 승인 정책을 검증한다.
- stdout·stderr와 결과 산출물의 저장 경계를 정의한다.
- 중단·비정상 종료 후 프로세스와 worktree를 복구한다.

## 프로필 예

```yaml
schemaVersion: 1
id: codex-default
provider: openai
executor: codex
workspaceMode: isolated-worktree
network: restricted
approval: local
timeoutMinutes: 30
```

## 비범위

- 웹 Agent 관제 화면
- 인터넷 원격 실행
- 자동 승인
- 임의 셸 API
- Agent별 상세 Adapter 구현

## 완료조건

- [ ] Profile schema와 등록·조회·검증 CLI가 동작한다.
- [ ] 허용되지 않은 실행 파일·인수·환경변수가 차단된다.
- [ ] Agent가 지정 프로젝트 worktree 밖을 작업 경로로 사용할 수 없다.
- [ ] timeout, 취소, 비정상 종료와 재시작 테스트가 통과한다.
- [ ] 기존 CLI·Board와 패키지 경계가 유지된다.
- [ ] 보안 검토 전에는 실험 기능으로 명시된다.

## 의존성

`#15`, `#16`, `#22`

---

# #24 `[Agent] Task Run·Session 수명주기와 실행 이벤트 저장`

## 배경

Agent 실행을 태스크와 연결하고 여러 실행의 상태·결과·실패를 보존하려면 공통 Run·Session 모델이 필요하다.

## 목표

- 하나의 Task에 여러 Run과 Session을 연결한다.
- 실행 상태와 결과를 Client별 구현과 무관한 이벤트로 기록한다.
- 프로세스 로그와 프로젝트 정본을 분리한다.

## 상태 모델

```text
queued
starting
running
needs-input
needs-approval
review
failed
cancelled
completed
```

## 이벤트 초기 범위

```text
run.created
run.started
run.output
run.needs_input
run.needs_approval
run.completed
run.failed
run.cancelled
```

## 요구사항

- Task, Run, Session, Agent Client와 Executor Profile 관계를 정의한다.
- 상태 전이 규칙과 금지 전이를 검증한다.
- 실행 시작·종료·실패·취소 원인을 기록한다.
- 변경 파일, test 결과, 검증 증거와 후속 태스크를 연결한다.
- 재실행 시 이전 Run을 덮어쓰지 않는다.
- 대용량 로그와 바이너리는 Git에 저장하지 않는다.
- 공유되어야 하는 결과와 로컬 진단 로그를 분리한다.
- 프로세스 중단 후 실제 프로세스와 Run 상태 불일치를 복구한다.

## 비범위

- 여러 호스트 간 분산 스케줄링
- 중앙 실행 서버
- 토큰 기반 과금
- 웹 관제 화면

## 완료조건

- [ ] Run·Session schema와 상태 전이 테스트가 있다.
- [ ] 한 Task에서 여러 Run의 이력이 보존된다.
- [ ] 입력·승인 대기 상태가 다른 상태와 구분된다.
- [ ] 중단된 프로세스의 stale 상태를 복구한다.
- [ ] 결과·검증·변경 파일이 Task에 추적된다.
- [ ] 로그 보존·회전·삭제 정책이 문서화된다.

## 의존성

`#23`

---

# #25 `[Board] Agent Operations 및 Needs Attention 대시보드`

## 배경

Run·Session 기반이 생기면 사용자는 여러 프로젝트에서 실행 중이거나 입력·승인·검토가 필요한 Agent 작업을 한 화면에서 확인해야 한다.

## 목표

- Agent 운영 상태를 멀티 프로젝트 Home에 통합한다.
- 사람이 지금 개입해야 하는 Run을 우선 표시한다.
- Task, Context, 변경, 검증과 승인 흐름을 하나의 작업공간으로 연결한다.

## 요구사항

- Running, Needs Input, Needs Approval, Review, Failed, Completed 집계를 제공한다.
- 프로젝트, Task, Agent, Profile, 시작 시각과 경과시간을 표시한다.
- Run 시작 요청, 로컬 승인, 입력 전달, 중지와 재시도를 제공한다.
- 등록된 Executor Profile만 선택할 수 있다.
- 변경 파일과 diff를 검토할 수 있다.
- test 결과와 완료조건을 연결한다.
- 승인 전 Git push·merge를 수행하지 않는다.
- Agent 로그와 이벤트를 실시간 또는 증분 갱신한다.
- Agent가 요청한 승인의 대상과 위험 수준을 표시한다.

## 비범위

- 임의 터미널
- 무승인 Git push·merge
- 원격 호스트 직접 제어
- 브라우저 기반 범용 IDE

## 완료조건

- [ ] 여러 프로젝트의 Run 상태가 Home 집계와 일치한다.
- [ ] Needs Input·Approval·Review 항목이 Attention 목록에 표시된다.
- [ ] Task 상세에서 Run·diff·test·검증을 추적할 수 있다.
- [ ] 허용되지 않은 Profile이나 작업은 UI와 API 모두 차단한다.
- [ ] 취소·실패·재시도 UI 회귀 테스트가 통과한다.
- [ ] 접근성과 모바일 읽기 흐름이 검증된다.

## 의존성

`#17`, `#18`, `#23`, `#24`

---

# #26 `[Security] Agent Runner 격리·승인·Secret 보호`

## 배경

Agent 실행은 문서·태스크 편집보다 높은 권한을 요구한다. Runner가 일반 사용자 권한과 자격증명을 그대로 상속하면 원격 제어 및 정보 유출 위험이 생긴다.

## 목표

- Agent가 실제로 할 수 있는 범위를 OS와 실행 정책으로 제한한다.
- 프로젝트 데이터, Secret, 네트워크와 Git 작업의 승인 경계를 정의한다.
- 침해나 오작동 시 영향 범위를 최소화한다.

## 요구사항

- 별도 저권한 계정 또는 동등한 프로세스 격리를 검토한다.
- 프로젝트 mount와 격리 worktree만 파일 접근 대상으로 허용한다.
- 환경변수와 Secret은 deny-by-default와 allowlist를 사용한다.
- SSH key, Git credential helper, 사용자 홈과 Docker socket을 기본 제공하지 않는다.
- 네트워크 접근 정책과 허용 목적지를 정의한다.
- 실행 시간, CPU, 메모리와 출력 크기를 제한한다.
- read-only, file-write, test, commit, push 권한을 분리한다.
- Git push와 위험 작업은 명시적 승인을 요구한다.
- 외부 문서와 태스크 본문을 신뢰할 수 없는 입력으로 취급한다.
- 정책 변경, 실행, 승인과 거부를 감사 가능하게 기록한다.
- 패키지 checksum, 코드 서명과 SBOM 전략을 정의한다.

## 비범위

- 모든 OS에 동일한 샌드박스 구현 보장
- 침투 테스트 전체 수행
- SaaS IAM
- 무인 관리자 권한 실행

## 완료조건

- [ ] 위협 모델과 보안 경계가 문서화된다.
- [ ] 프로젝트 밖 경로, Secret과 금지 네트워크 접근 테스트가 통과한다.
- [ ] 위험 작업 승인과 거부가 감사 로그에 남는다.
- [ ] Runner가 관리자 권한을 요구하지 않는다.
- [ ] 보안 검토 없이 자동 승인 모드를 활성화할 수 없다.
- [ ] 알려진 고위험 구성에 명확한 경고와 복구 절차가 있다.

## 의존성

`#23`, `#24`

---

# 검증 후 등록 후보

## #27 `[Adapter] Codex·Claude Code·Gemini CLI 공통 Adapter`

### 목표

- 각 AI Client의 명령행과 이벤트 차이를 Adapter가 흡수한다.
- Task와 Context Projection을 공통 입력으로 사용한다.
- Run 상태, 변경 파일, test, 검증, 결정, 사용량과 후속 태스크를 공통 출력으로 변환한다.
- AI 도구를 교체해도 프로젝트·Task·Run 이력을 유지한다.

### 등록 조건

- #23과 #24의 계약이 실제 Agent 하나에서 검증되었을 것.
- 두 번째 Agent 통합이 필요해 공통 Adapter의 가치가 확인되었을 것.

### 의존성

`#22`, `#23`, `#24`

## #28 `[Collaboration] 오프라인 문서 변경 제안과 병합 흐름`

### 목표

```text
임대 없이 오프라인 수정
→ 원본 덮어쓰기 금지
→ Proposal 생성
→ Markdown diff
→ 수락·부분 수락·거절
```

### 주요 범위

- Proposal schema와 기준 문서 revision
- 작성 Client·Member와 생성 시각
- 원본·제안 Markdown diff
- 임대 충돌 시 Proposal 보존
- 수락·거절 감사 이벤트
- 병합 후 Wiki link와 `rdl check --strict` 검증

### 등록 조건

- #21에서 오프라인 문서 충돌이 반복적으로 확인될 것.
- #19의 단순 읽기 전용·재시도만으로 해결되지 않을 것.

### 의존성

`#18`, `#19`, `#20`, `#21`

## #29 `[Distribution] 폐쇄망 설치·업데이트·복구 번들`

### 목표

- npm tarball과 사설 Registry 설치를 검증한다.
- 서명, checksum, SBOM, rollback과 schema migration을 제공한다.
- Board·CLI·Node의 통합·개별 설치를 검증한다.
- 업데이트 실패 시 기존 프로젝트와 로컬 데이터를 보존한다.

### 등록 조건

- #15 패키지 경계가 안정화될 것.
- #21의 실제 폐쇄망 배포 환경이 확정될 것.

### 의존성

`#15`, `#21`

---

# 보류 항목

## 선택적 LAN 이벤트 가속

- 기존 #4를 재정의하는 후보이며 별도 이슈 번호를 선점하지 않는다.
- Git Watch 지연이 실제 사용자 문제로 확인된 경우에만 진행한다.
- 역할은 Board 상태 이벤트 전달로 제한하고 파일 정본과 Git 이력을 대체하지 않는다.
- Agent 실행, 원격 셸, 인터넷 Relay와 CRDT는 포함하지 않는다.

## CRDT/Yjs 공동 편집

- 동일 Markdown 문서의 동시 타이핑 요구가 반복 검증될 때만 등록한다.
- Git은 체크포인트와 최종 내구성 원본으로 유지한다.
- 서버 사양, 권한, snapshot과 파일 투영 규칙을 별도 설계한다.

## 인터넷 Relay와 P2P

- 폐쇄망 기본 제품 범위에 포함하지 않는다.
- 외부 네트워크 접근 수요와 운영 주체가 확인된 뒤 별도 제품 결정으로 다룬다.

---

# 권장 등록 및 실행 순서

## 지금 등록할 후보

```text
#21 E2E 폐쇄망 통합 검증
#22 프로젝트 지식 그래프와 Context Projection
#23 Agent Executor Registry와 Runner 계약
#24 Task Run·Session 수명주기
#25 Agent Operations Dashboard
#26 Agent Runner 보안
```

## 검증 후 등록

```text
#27 AI Client Adapter
#28 오프라인 문서 Proposal
#29 폐쇄망 배포 번들
```

## 보류

```text
#4 선택적 LAN 이벤트 가속으로 재검토
CRDT/Yjs
Relay
P2P
SaaS
```

# 전체 의존성

```text
#15 ─────────────┐
#16 → #17 → #18 ├→ #21 → #22 → #23 → #24 → #25
       ├→ #19 ──┤                  └──────→ #26
       └→ #20 ──┘

#22 + #23 + #24 → #27
#18 + #19 + #20 + #21 → #28
#15 + #21 → #29
```

# 단계별 제품 상태

```text
#16~#20 완료
  Git-native 멀티 프로젝트 협업 대시보드

#21 완료
  폐쇄망에서 검증된 협업 제품

#22 완료
  AI가 사용할 수 있는 Project Knowledge OS

#23~#24 완료
  로컬 Agent 실행 기반

#25 완료
  멀티 프로젝트 Agent Operations UI

#26 완료
  배포 검토가 가능한 Agent OS 보안 경계
```

# 공통 Definition of Done

모든 후속 이슈는 다음을 공통 완료조건으로 사용한다.

- [ ] 요구사항, 결정, 구현, 테스트와 사용자 증거가 추적된다.
- [ ] 기존 프로젝트와 migration 경로가 보존된다.
- [ ] 정상·실패·중단·복구 시나리오가 테스트된다.
- [ ] 로컬 우선, Git 정본과 오프라인 원칙이 유지된다.
- [ ] Secret, 로컬 경로와 삭제 불가능한 캐시가 Git에 추가되지 않는다.
- [ ] CLI 사람용 출력과 JSON 출력이 같은 상태를 표현한다.
- [ ] 보안·운영·성능 영향이 문서화된다.
- [ ] 관련 문서와 설치되는 AI 스킬의 계약이 일치한다.
- [ ] `rdl check --strict`와 전체 회귀 테스트가 통과한다.

# 후속 결정 필요

- 각 이슈의 담당자, 리뷰어와 최종 결정권자 지정
- #21~#26을 한 번에 등록할지 #21 검증 후 순차 등록할지 결정
- #4를 보류할지 LAN 이벤트 가속으로 즉시 재정의할지 결정
- Agent Runner의 첫 번째 기준 Adapter를 Codex로 정할지 결정
- Windows 저권한 계정, 컨테이너 또는 둘 다 지원할지 결정
- 로그 보존 기간과 폐쇄망 감사 요구 수준 확정
