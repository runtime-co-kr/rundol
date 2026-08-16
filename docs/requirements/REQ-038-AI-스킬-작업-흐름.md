---
id: REQ-038
type: document
kind: requirement
title: 인공지능 스킬 작업 흐름
description: AI 스킬이 정본 문서 유형, 태스크, 검증·save·sync 순서를 지키며 CLI evaluator 진단을 최종 판단으로 쓰는 작업 흐름 요구사항
granularity: bounded-v1
scope: AI 스킬의 설계 진행 순서와 CLI 권위 경계
excludes:
  - CLI evaluator의 판정 규칙 자체
  - 특정 AI 제품의 내부 구현
implementationContract: atomic-v1
functionIds:
  - HRN-06
owner: "[[project#^MEMBER-001|프로젝트 책임자]]"
state: active
tags:
  - rundol/artifact
  - artifact/requirement
  - domain/rundol
  - feature/명령줄-ai-스킬-보드-통합-규격
aliases:
  - REQ-038
related:
  - "[[PRD-001-Rundol-제품-요구사항|PRD-001]]"
  - "[[REQ-012-명령줄-AI-스킬-보드-통합-규격|REQ-012]]"
  - "[[TST-002-문서-계획-계약-검증|TST-002]]"
---

# 인공지능 스킬 작업 흐름

## 배경

AI 스킬 작업 흐름은 [[REQ-012-명령줄-AI-스킬-보드-통합-규격|REQ-012]]이 나르던 기능 하나를 문서 1개 = 기능 1개 계약에 따라 분리한 정본이다. AI는 본문·코드를 작성하는 오케스트레이터이고, ID·상태·검증·Git 동기화의 권위는 CLI에 있다 — 어떤 AI가 작업했는지와 무관하게 결과가 같은 규칙으로 판정된다.

## 요구사항

- 스킬은 DESIGN.md와 인덱스를 만들지 않고 기능을 묶지 않으며 CLI evaluator 진단을 최종 실행 판단으로 사용한다.
- 연결 확인 후 계약을 읽고 태스크를 doing으로 전환하며 검사 통과 후 acceptance와 done·sync를 진행한다.
- conflict·checkpoint·implementation 오류에서는 정본 변경과 완료를 중단한다.

## 상태와 예외

| 현재 상태 또는 상황 | 사건 | 기대 상태 또는 동작 |
|---|---|---|
| 경계·계약 유효 | 진행 | 문서 작성과 태스크 전환을 계속한다. |
| conflict·checkpoint·implementation 오류 | 진행 시도 | 정본 변경과 완료를 중단한다. |

## 기능별 설계 계약

### HRN-06

#### 입력

- 사용자 의도, init·boundary·contract show·next 결과와 2~4개 관련 문서

#### 출력

- 정본 문서 유형, Rundol 태스크, 검증·save·sync 순서를 지키는 AI 작업 흐름

#### 업무 규칙

- 스킬은 DESIGN.md와 인덱스를 만들지 않고 기능을 묶지 않으며 CLI evaluator 진단을 최종 실행 판단으로 사용한다.

#### 상태와 전이

- 연결 확인 후 계약을 읽고 태스크를 doing으로 전환하며 검사 통과 후 acceptance와 done·sync를 진행한다.

#### 권한과 승인

- AI는 본문·코드를 작성하고 CLI는 ID·상태·검증·Git 동기화를 담당한다.

#### 정상·오류·취소

- 경계와 계약이 유효하면 진행하고 conflict·checkpoint·implementation 오류에서는 정본 변경과 완료를 중단한다.

#### 감사 기록

- 사용한 task, 관련 문서, check 결과와 sync 커밋으로 AI 작업 결과를 재구성할 수 있다.

#### 수용 기준

- Codex·Claude·Copilot에 설치된 스킬이 동일한 atomic-v1·무인덱스·브랜치 경계 순서를 안내한다.
