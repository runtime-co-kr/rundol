---
id: ARC-003
type: document
kind: architecture
title: 깃 작업공간과 동기화 아키텍처
description: 코드·Workspace·프로젝트를 분리한 Git ref와 linked worktree 경계, 발견·연결·저장·동기화의 데이터 흐름을 정의한다.
granularity: bounded-v1
scope: "코드 Workspace 프로젝트 Git 경계와 검증된 저장·동기화 데이터 흐름"
excludes:
  - "localhost Board HTTP 서버와 화면 구성"
  - "Client manifest와 문서 lease의 필드 계약"
owner: "[[project#^MEMBER-001|프로젝트 책임자]]"
state: active
tags:
  - rundol/artifact
  - artifact/architecture
  - domain/rundol
  - feature/git-workspace-sync
aliases:
  - ARC-003
related:
  - "[[REQ-013-워크스페이스-초기화와-발견|REQ-013]]"
  - "[[REQ-014-프로젝트-연결과-복구|REQ-014]]"
  - "[[REQ-015-검증된-프로젝트-저장과-동기화|REQ-015]]"
  - "[[TST-004-워크스페이스-초기화와-발견-검증|TST-004]]"
  - "[[TST-005-프로젝트-연결과-복구-검증|TST-005]]"
  - "[[TST-006-프로젝트-저장과-동기화-검증|TST-006]]"
  - "[[ADR-004-Git-ref와-worktree-소유-경계|ADR-004]]"
---

# 깃 작업공간과 동기화 아키텍처

## 컨텍스트와 경계

저장소 루트는 제품 코드 브랜치를, `projects/workspace/`는 `rundol/workspace`를, `projects/<project-key>/`는 `rundol/<project-key>`를 checkout한 linked worktree를 소유한다. `projects/workspace/projects/project-<key>.yaml`이 프로젝트 ref와 mount를 등록하고 각 프로젝트의 `project.md`가 정본 문서 계약을 소유한다. 제품 브랜치에는 프로젝트 산출물을 복제하지 않는다.

```mermaid
flowchart LR
  User[CLI 또는 AI Client] --> Discover[bootstrap.discoverWorkspace]
  Discover --> Local[로컬 ref와 worktree 검사]
  Discover --> Remote[origin의 rundol refs 조회]
  Local --> Decision{created / attached / repaired / already-connected / needs-selection / conflict}
  Remote --> Decision
  Decision --> Attach[attach 또는 repair]
  Attach --> WRef[refs/heads/rundol/workspace]
  Attach --> PRef[refs/heads/rundol/project-key]
  WRef --> WTree[projects/workspace]
  PRef --> PTree[projects/project-key]
  Attach --> Boundary[pre-push 경계와 upstream 설정]
```

## 컴포넌트

| 컴포넌트 | 책임 | 소유 데이터 | 의존 대상 |
|---|---|---|---|
| `src/bootstrap.js` | 로컬·원격 ref, manifest, worktree 관계를 읽고 쓰기 없는 연결 결정을 산출 | discovery 결과 | Git object/ref 조회 |
| `src/attach.js` | 발견된 commit을 동일 이름 로컬 ref에 연결하고 정해진 경로에 worktree를 생성·복구 | worktree, `.git/info/exclude` | bootstrap, branch-boundary |
| `src/workspace.js` | schemaVersion 6 manifest와 project registry를 해석하고 안전한 상대 경로를 강제 | Workspace layout | 파일 시스템 |
| `src/state.js` | 프로젝트 변경 검증, commit, fetch, 병합, materialize, 동일 ref push | 프로젝트 branch와 task store | Git, checker, merge |
| `src/settings.js` | `rundol/workspace` 변경을 저장하고 프로젝트보다 먼저 동기화 | Workspace branch | Git |
| `src/branch-boundary.js` | worktree 역할 검증, `push.default=simple`, managed pre-push hook | Git local config와 hook | Git |

## 발견과 연결 데이터 흐름

```mermaid
sequenceDiagram
  participant C as rdl init/attach
  participant D as discoverWorkspace
  participant G as Git
  participant F as File system
  C->>D: remote, 선택 project
  D->>G: local refs/worktrees와 ls-remote 조회
  D->>G: workspace/project commit 내용 검증
  D->>F: manifest와 대상 경로 점유 여부 확인
  D-->>C: action과 available projects
  alt attached 또는 repaired
    C->>G: 동일 이름 local ref 연결
    C->>F: canonical 경로에 worktree 생성
    C->>G: branch upstream과 pre-push 경계 설치
  else needs-selection
    C-->>C: ref와 파일을 변경하지 않고 선택 목록 반환
  else conflict
    C-->>C: 부분 생성 없이 중단
  end
```

`discoverWorkspace`는 원격 탐색 중 필요한 commit object를 fetch할 수 있으나 로컬 branch ref나 worktree를 만들지 않는다. 다중 프로젝트인데 선택이 없으면 `needs-selection`, manifest와 ref 불일치·잘못된 worktree branch·Workspace 분기·비어 있지 않은 대상 경로는 `conflict`다. `attachWorkspace`는 대상 전체의 비점유를 먼저 확인한 뒤 Workspace와 선택 프로젝트를 연결한다.

## 저장과 동기화 데이터 흐름

```mermaid
flowchart TD
  Start[rdl save 또는 rdl sync] --> Boundary[worktree 경계 확인]
  Boundary --> Validate[projection과 문서 계약 검증]
  Validate --> Save[변경 stage와 local commit]
  Save --> Fetch[명시적 remote tracking ref로 fetch]
  Fetch --> Relation{commit 관계}
  Relation -->|동일| Unchanged[unchanged]
  Relation -->|remote가 후손| FF[update-ref 후 hard reset]
  Relation -->|local이 후손| Ahead[local-ahead]
  Relation -->|양쪽 변경| Merge{task storage}
  Merge -->|sharded| GitMerge[파일 단위 git merge]
  Merge -->|single| Semantic[task 의미 병합]
  Semantic -->|충돌| Pending[.rundol/pending/merge-conflicts.json 기록 후 중단]
  Semantic -->|성공| Commit[merge commit]
  GitMerge --> Commit
  FF --> Materialize[projection materialize와 재검증]
  Ahead --> Materialize
  Commit --> Materialize
  Unchanged --> Materialize
  Materialize --> Push[local ref와 같은 remote ref로 push]
```

`syncState`는 Workspace 설정을 먼저 동기화한 뒤 선택 프로젝트를 처리한다. 동시 fetch가 공유 `FETCH_HEAD`를 바꿀 수 있으므로 `refs/remotes/<remote>/<branch>`를 명시적으로 사용한다. 공통 이력이 없거나 의미 충돌이 있으면 자동 병합하지 않는다. push refspec은 항상 `<config.ref>:<config.ref>`이다.

## 실행과 배포

| 영역 | 설계 |
|---|---|
| 런타임 | Node.js CommonJS와 시스템 Git 명령을 사용한다. |
| 네트워크 | 발견·동기화 때 선택 remote만 접근하며 문서 조회와 검증은 로컬에서 수행한다. |
| 저장소 | 정본은 세 개 역할의 Git ref이고 `.rundol/state`, pending, logs는 로컬 실행 상태다. |
| 관측 | discovery action, boundary violations, sync action, commit, push 여부를 JSON 결과로 노출한다. |
| 복구 | 손실된 worktree는 유효한 로컬 ref에서 재생성하고, 분기나 점유 경로는 자동 덮어쓰지 않는다. |

## 품질 속성

| 속성 | 목표 | 설계 대응 | 검증 |
|---|---|---|---|
| 무손실 발견 | 탐색만으로 ref·worktree를 변경하지 않음 | discovery와 attach 분리 | bootstrap/attach 테스트 |
| 역할 격리 | 경로마다 정확히 한 branch 역할 | canonical path와 branch assertion | branch-boundary 테스트 |
| 동기화 결정성 | 동일 commit 관계에서 같은 action | 명시적 tracking ref와 merge-base | git 테스트 |
| 충돌 보존 | 자동 해결 불가 변경을 덮어쓰지 않음 | pending conflict 기록 후 실패 | semantic merge 테스트 |
| push 안전성 | 교차 ref와 기본 삭제 차단 | managed pre-push hook | push validation 테스트 |

## 보안과 운영 제약

Git credential은 시스템 credential helper에 맡기며 Rundol 파일에 저장하지 않는다. 기존 pre-push hook은 `pre-push.rundol-user`로 보존한 후 managed hook이 먼저 실행한다. branch 삭제는 `RUNDOL_ALLOW_DELETE=1`인 명시적 운영 상황만 허용하며 정상 동기화 경로에는 사용하지 않는다.

## 알려진 제약

- Workspace branch가 서로 분기된 경우 자동 의미 병합 대상이 아니며 운영자가 이력을 정리해야 한다.
- `repair`는 유효한 로컬 ref가 있을 때 worktree만 복구하며 손상된 정본 내용을 재구성하지 않는다.
- single task store 의미 병합과 sharded Git 병합은 충돌 표현이 다르므로 운영자는 반환된 action과 pending 파일을 함께 확인해야 한다.
