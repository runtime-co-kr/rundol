---
id: REQ-037
uid: AERKR4P4
type: document
kind: requirement
title: 브랜치와 워크트리 경계
description: 코드·Workspace·프로젝트 역할별 branch/worktree 소유를 감지하고 교차 push를 변경 전에 차단하는 요구사항
granularity: bounded-v1
scope: Git branch와 worktree의 역할 경계 감지와 위반 차단
excludes:
  - 문서·태스크 내용의 계약 규칙
  - 원격 저장소 호스팅 방식
implementationContract: atomic-v1
functionIds:
  - HRN-05
owner: "[[project#^MEMBER-001|프로젝트 책임자]]"
state: active
tags:
  - rundol/artifact
  - artifact/requirement
  - domain/rundol
  - feature/명령줄-ai-스킬-보드-통합-규격
aliases:
  - REQ-037
related:
  - "[[PRD-001-Rundol-제품-요구사항|PRD-001]]"
  - "[[REQ-012-명령줄-AI-스킬-보드-통합-규격|REQ-012]]"
  - "[[TST-002-문서-계획-계약-검증|TST-002]]"
---

# 브랜치와 워크트리 경계

## 배경

브랜치·worktree 경계는 [[REQ-012-명령줄-AI-스킬-보드-통합-규격|REQ-012]]이 나르던 기능 하나를 문서 1개 = 기능 1개 계약에 따라 분리한 정본이다. 코드, Workspace registry, 프로젝트 문서는 각자의 브랜치와 worktree를 소유하며, 경계를 넘는 push는 변경이 일어나기 전에 차단되어야 한다.

## 요구사항

- 코드 기본 브랜치는 origin/HEAD의 main·master·사용자 정의 표준을 따르고 Rundol 전용 ref는 정확히 같은 이름으로만 push한다.
- 코드 파일은 루트 코드 worktree, 프로젝트 문서·태스크는 `rundol/{project-key}`, registry는 rundol/workspace만 소유한다.
- init·attach·repair 전에는 읽기 전용 discovery를 수행한다.

## 상태와 예외

| 현재 상태 또는 상황 | 사건 | 기대 상태 또는 동작 |
|---|---|---|
| 올바른 역할 | push | 통과한다. |
| 잘못된 branch·점유 경로·교차 push·삭제 push | push | 변경 전에 차단한다. |

## 기능별 설계 계약

### HRN-05

#### 입력

- Git worktree 목록, Workspace registry, 현재 코드 브랜치와 원격 HEAD

#### 출력

- 코드·Workspace·프로젝트 역할별 기대 branch/worktree와 위반 진단

#### 업무 규칙

- 코드 기본 브랜치는 origin/HEAD의 main·master·사용자 정의 표준을 따르고 Rundol 전용 ref는 정확히 같은 이름으로만 push한다.

#### 상태와 전이

- init·attach·repair 전에는 읽기 전용 discovery를 수행하고 유효 연결 후 managed pre-push 경계를 설치한다.

#### 권한과 승인

- 코드 파일은 루트 코드 worktree, 프로젝트 문서·태스크는 `rundol/{project-key}`, registry는 rundol/workspace만 소유한다.

#### 정상·오류·취소

- 올바른 역할은 통과하고 잘못된 branch·점유 경로·교차 push·삭제 push는 변경 전에 차단한다.

#### 감사 기록

- boundary JSON은 currentCodeBranch, primaryBranch, roles, worktrees와 violations를 반환한다.

#### 수용 기준

- 원격 HEAD가 main, master, trunk인 저장소에서 각각 표준 기본 브랜치를 감지하면서 현재 기능 브랜치를 허용한다.
