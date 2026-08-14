---
id: ADR-004
type: document
kind: adr
title: 깃 참조와 작업 트리 소유 경계
description: 코드, Workspace, 프로젝트 산출물을 동일 이름 전용 branch와 canonical linked worktree로 분리하고 pre-push로 교차 push를 차단한다.
granularity: bounded-v1
scope: "코드 Workspace 프로젝트가 서로 다른 동일 이름 Git ref와 worktree를 소유하는 결정"
excludes:
  - "문서 유형별 본문 책임과 원자 기능 계약"
owner: "[[project#^MEMBER-001|프로젝트 책임자]]"
state: accepted
tags:
  - rundol/artifact
  - artifact/adr
  - domain/rundol
  - feature/git-ownership-boundary
aliases:
  - ADR-004
related:
  - "[[ARC-003-Git-작업공간과-동기화-아키텍처|ARC-003]]"
  - "[[REQ-013-워크스페이스-초기화와-발견|REQ-013]]"
  - "[[REQ-015-검증된-프로젝트-저장과-동기화|REQ-015]]"
---

# 깃 참조와 작업 트리 소유 경계

## 맥락

제품 코드와 Rundol 운영 문서는 변경 주기, 검토자, 동기화 명령이 다르다. 한 branch나 한 작업 디렉터리에 함께 두면 제품 commit에 프로젝트 문서가 섞이거나 한 프로젝트 저장이 다른 프로젝트를 포함할 수 있다. 원격과 로컬의 branch 이름을 바꾸어 push하는 방식은 정본의 역할을 모호하게 하고 자동화가 잘못된 ref를 갱신할 위험을 만든다.

## 결정 기준

- 제품 코드와 프로젝트 문서의 commit 이력을 독립적으로 검토할 수 있어야 한다.
- clone 뒤에도 manifest와 ref만으로 canonical 경로를 복구할 수 있어야 한다.
- 보통의 `git status`에서 linked project가 제품 변경으로 나타나지 않아야 한다.
- 교차 branch push와 우발적 branch 삭제를 push 시점에 차단해야 한다.
- 기존 사용자 pre-push hook을 손실하지 않아야 한다.

## 선택지

| 선택지 | 장점 | 단점 | 위험 |
|---|---|---|---|
| 제품 branch에 모든 파일 저장 | Git 구조가 단순 | 책임과 release 이력이 혼합 | 문서 저장이 제품 배포를 오염 |
| 별도 저장소 사용 | 물리적 격리가 강함 | clone·권한·원격 관리가 이중화 | 코드와 문서 버전 관계 단절 |
| 같은 저장소의 전용 branch와 linked worktree | object 공유, 독립 이력, 로컬 동시 접근 | 경계 검증과 hook 필요 | 잘못된 refspec 사용 시 역할 혼동 |

## 결정

2026-08-14, 전용 branch와 canonical linked worktree 방식을 채택한다.

- 저장소 루트의 현재 branch는 코드 역할이며 `rundol/*` branch를 허용하지 않는다. 기본 제품 branch는 `origin/HEAD`에서 발견한다.
- Workspace는 `refs/heads/rundol/workspace`와 `projects/workspace/`를 소유한다.
- 프로젝트 `<key>`는 `refs/heads/rundol/<key>`와 `projects/<key>/`를 소유한다.
- `.git/info/exclude`의 `/projects/*/`로 제품 worktree에서 linked worktree 경로를 숨긴다.
- `push.default=simple`을 설정하고 Rundol branch의 upstream은 같은 이름 remote ref로 고정한다.
- managed pre-push hook은 local ref와 remote ref가 다른 push 및 기본 branch 삭제를 거절한다. 기존 hook은 `pre-push.rundol-user`로 보존해 먼저 실행한다.
- 경로·branch·Git top-level이 기대값과 다르면 생성·저장·동기화를 중단한다.

## 결과

- 긍정적 결과: 코드, 조직 Workspace, 각 프로젝트 산출물의 변경과 동기화가 독립적이며 clone 후 ref 기반 복구가 가능하다.
- 부정적 결과: 사용자는 여러 worktree와 branch 역할을 이해해야 하고 오래된 Git 도구나 수동 worktree 이동은 지원하지 않는다.
- 후속 작업: 모든 저장·sync 진입점에서 branch boundary 검사를 유지하고 새 branch 역할 도입 시 이 ADR을 재검토한다.
- 재검토 조건: Git 이외의 정본 저장소를 채택하거나 프로젝트별 별도 repository가 필수가 되거나 중앙 서버가 branch를 직접 관리하게 될 때 재검토한다.
