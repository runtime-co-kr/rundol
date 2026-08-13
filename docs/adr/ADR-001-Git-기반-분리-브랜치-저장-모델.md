---
id: ADR-001
type: document
kind: adr
title: 깃 기반 분리 브랜치 저장 모델
description: 프로젝트 자료를 일반 파일과 Git 정본으로 유지하되 제품·Workspace·프로젝트별 독립 브랜치와 linked worktree로 소유권을 분리한다.
owner: "[[project#^MEMBER-001|프로젝트 책임자]]"
state: accepted
tags:
  - rundol/artifact
  - artifact/adr
  - domain/storage-architecture
  - feature/branch-ownership
aliases:
  - ADR-001
related:
  - "[[ARC-001-런돌-시스템-아키텍처|ARC-001]]"
  - "[[REQ-001-워크스페이스와-프로젝트-수명주기|REQ-001]]"
  - "[[REQ-004-원격-동기화와-충돌-관리|REQ-004]]"
---

# 깃 기반 분리 브랜치 저장 모델

## 맥락

런돌은 기존 제품 저장소에 도입되며 프로젝트 헌장, 요구사항·설계 문서, 태스크, Client Registry와 협업 이벤트를 버전 관리해야 한다. 이 자료는 제품 코드와 관련되지만 수명 주기, 변경 빈도, 접근 주체와 병합 방식이 다르다. 제품 브랜치에 모두 넣으면 사용하지 않는 팀에도 관리 파일과 설정 변경을 강제하고, 별도 SaaS나 데이터베이스를 정본으로 두면 오프라인 사용·이식성·IDE와 AI 클라이언트의 직접 접근이 약해진다.

결정하지 않으면 다음 문제가 발생한다.

- 제품 코드와 거버넌스 자료 중 어느 branch가 어떤 파일을 소유하는지 모호해진다.
- 문서 도구·Board·AI client마다 별도 복제본이 생겨 정본이 갈라진다.
- 중앙 서비스가 없는 환경에서 이력, 병합, 백업과 복구를 다시 구현해야 한다.
- 여러 프로젝트가 하나의 대형 상태 파일을 공유해 불필요한 충돌과 권한 결합이 생긴다.

## 결정 기준

우선순위가 높은 순서로 다음 기준을 적용한다.

1. 사용자가 전용 server 없이 모든 정본을 읽고 복구할 수 있는 이식성
2. 제품 branch와 프로젝트 운영 자료 사이의 명확한 소유권·수명 주기 분리
3. 오프라인 생성·편집·검증과 기존 Git remote를 이용한 협업
4. IDE, Obsidian, CLI, Board와 AI client가 같은 물리 file을 사용하는 도구 중립성
5. 원격 변경을 강제 덮어쓰지 않는 이력 보존과 충돌 가시성
6. 기존 Git 저장소에 대한 낮은 도입 비용과 별도 infrastructure 최소화
7. schema migration, 진단과 장애 복구의 재현 가능성

## 선택지

| 선택지 | 장점 | 단점 | 위험 |
|---|---|---|---|
| 제품 branch에 모든 런돌 파일 저장 | Git 사용이 단순하고 일반 clone에서 즉시 보인다. | 제품 commit·review와 문서·태스크 이력이 섞이고 모든 사용자에게 파일을 강제한다. | 제품 branch 오염, 대량 태스크 충돌, 도입 거부 |
| 중앙 DB·SaaS를 정본으로 사용 | query, 권한, 실시간 협업과 대규모 index 구현이 쉽다. | server 운영·인증·backup이 필요하고 offline·폐쇄망·직접 file 접근이 약해진다. | vendor·service 의존, DB와 export 문서 불일치, 복구 복잡성 |
| 별도 Git 저장소에 프로젝트 자료 저장 | 제품 저장소와 강하게 분리되고 독립 권한 설정이 가능하다. | repository 간 식별·clone·경로·commit 연결과 onboarding이 복잡하다. | 제품 commit과 문서 version drift, 다중 remote 운영 부담 |
| 동일 저장소의 독립 branch와 linked worktree | 기존 object·remote·credential을 재사용하면서 제품과 자료 소유권을 분리하고 실제 file로 노출한다. | worktree와 여러 ref 관리가 필요하고 branch 간 원자 transaction이 없다. | shared Git object 권한, worktree 손상, 사용자의 branch 오해 |
| 제품 branch의 hidden ref·가상 filesystem | UI에서 파일 노출을 줄이고 내부 제어를 강화할 수 있다. | 표준 도구 접근성·투명성·복구성이 낮고 별도 filesystem adapter가 필요하다. | 전용 runtime 종속, 장애 시 사용자가 직접 복구하기 어려움 |

## 결정

2026-08-13에 프로젝트 책임자는 **일반 파일과 Git을 정본으로 사용하고 동일 저장소의 독립 branch를 linked worktree로 노출하는 모델**을 채택한다.

소유권은 다음과 같이 고정한다.

```text
제품 branch
└─ 제품 source와 제품 release 자료

rundol/workspace
├─ workspace.yaml
├─ clients/
├─ projects/
└─ events/

rundol/<project-key>
├─ project.md
├─ docs/
└─ tasks/
```

- `rundol/workspace`는 Workspace Registry, Client Registry와 공유 협업 event를 소유한다.
- 각 `rundol/<project-key>`는 해당 프로젝트 헌장, 정규 문서와 태스크를 소유한다.
- 신규 전용 branch는 제품 branch에서 분기하지 않는 독립 초기 commit으로 시작한다.
- branch는 `projects/workspace/`와 `projects/<project-key>/` linked worktree로 연결해 일반 file처럼 읽고 편집한다.
- 제품 branch에는 loader, `.rundol` 또는 `.gitignore` 변경을 요구하지 않는다. worktree 숨김은 local `.git/info/exclude`의 `/projects/*/` 규칙만 사용한다.
- `.rundol/state`와 `.rundol/logs`는 삭제 후 재생성 가능한 local runtime 상태이며 Git 정본에 포함하지 않는다.
- Workspace를 먼저 동기화하고 프로젝트를 각각 독립 동기화한다. fast-forward 또는 공통 base의 3-way merge만 허용하며 force push를 사용하지 않는다.
- 파일·ref·worktree 생성과 복구는 사용자가 직접 Git plumbing을 조합하기보다 Rundol CLI가 검증된 순서로 수행한다.

## 결과

### 긍정적 결과

- 모든 정본이 Markdown·YAML·JSON과 표준 Git commit으로 남아 전용 server 없이 열람·backup·diff·복구할 수 있다.
- 제품 source branch는 런돌 운영 자료를 추적하지 않고 프로젝트별 자료도 서로 독립된 이력과 충돌 범위를 가진다.
- IDE, Obsidian, Board와 AI client가 동일한 worktree file을 사용해 export·import 복제본이 필요 없다.
- 기존 remote, credential, review와 backup infrastructure를 재사용한다.
- clone 후 `rdl attach` 또는 `rdl git init`으로 ref·worktree와 local projection을 재구성할 수 있다.
- 원격 변경은 Git commit graph와 pending conflict로 드러나며 강제 덮어쓰기를 피할 수 있다.

### 부정적 결과

- 사용자는 일반 제품 branch 외에 `rundol/workspace`와 프로젝트 branch의 존재와 소유권을 이해해야 한다.
- linked worktree metadata가 손상되거나 경로가 관리되지 않은 file과 충돌할 수 있어 복구 명령과 진단이 필요하다.
- Workspace와 여러 프로젝트 동기화는 하나의 원자 transaction이 아니므로 일부 project만 성공할 수 있다.
- 같은 저장소의 worktree는 object database와 refs를 공유하므로 filesystem 격리가 곧 Git 권한 격리를 의미하지 않는다.
- Git은 문자 단위 실시간 공동 편집이나 강한 distributed lock을 제공하지 않아 revision, soft lease와 충돌 해결 절차가 필요하다.
- 대량 entity는 file 분할과 memory index가 필요하며 arbitrary query는 DB보다 제한적이다.

### 후속 작업

- init·attach·detach·git init의 멱등성, 부분 실패 복구와 제품 branch 무변경을 통합 test로 유지한다.
- schema와 branch 규칙 변경은 명시적 migration을 제공하고 이전 ref를 자동 삭제하지 않는다.
- shared object database가 허용되지 않는 고위험 Agent 작업에는 별도 clone·sandbox 또는 제한된 Git command 정책을 검토한다.
- 대량 태스크는 Client·segment shard를 유지하고 충돌·성능 지표를 관찰한다.
- Board API의 file·Git error가 remote service에 노출되지 않도록 localhost 경계를 유지한다.

### 재검토 조건

- 강한 tenant 격리나 프로젝트별 독립 Git 권한이 필수일 때
- 24시간 다중 사용자 실시간 공동 편집과 server-side locking이 핵심 요구가 될 때
- Git ref·worktree 운영 비용이 프로젝트 onboarding과 장애의 주요 원인이 될 때
- 문서·태스크 규모가 shard와 local index의 성능 목표를 지속적으로 초과할 때
- 제품 저장소 관리자가 custom ref·worktree 생성을 허용하지 않을 때
- 중앙 감사·보존 정책이 local Git만으로 충족되지 않을 때

재검토 시 별도 프로젝트 Git 저장소와 중앙 collaboration service를 우선 비교하되, 일반 file export와 Git 이력 보존 요구는 유지한다.
