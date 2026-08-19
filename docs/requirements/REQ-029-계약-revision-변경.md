---
id: REQ-029
uid: 6932H6E9
type: document
kind: requirement
title: 계약 리비전 변경
description: baseRevision 일치를 요구하는 원자적 계약 변경과 stale revision 409 응답 요구사항
granularity: bounded-v1
scope: 문서 계획 계약의 revision 기반 변경과 동시성 제어
excludes:
  - 계약의 평가와 강제 수준 적용
  - Board 화면의 편집 상호작용
implementationContract: atomic-v1
functionIds:
  - DCP-05
owner: "[[project#^MEMBER-001|프로젝트 책임자]]"
state: active
tags:
  - rundol/artifact
  - artifact/requirement
  - domain/rundol
  - feature/document-contract
aliases:
  - REQ-029
related:
  - "[[PRD-001-Rundol-제품-요구사항|PRD-001]]"
  - "[[REQ-010-문서-계획-계약-요구사항|REQ-010]]"
---

# 계약 리비전 변경

## 배경

계약 revision 변경은 [[REQ-010-문서-계획-계약-요구사항|REQ-010]]이 나르던 기능 하나를 문서 1개 = 기능 1개 계약에 따라 분리한 정본이다. 여러 표면이 같은 계약을 바꿀 수 있으므로 변경은 baseRevision 일치를 요구하는 원자적 저장이어야 하고, 동시 변경은 조용한 덮어쓰기 대신 명시적 실패여야 한다.

## 요구사항

- 계약 변경은 기존 문서를 삭제하거나 이동하지 않고 영향과 revision을 반환한다.
- Board 변경 API는 baseRevision을 요구하고 stale revision에 HTTP 409를 반환한다.
- 계약 저장은 전부 적용되거나 전부 적용되지 않는다. 검증에 걸린 입력이 하나라도 있으면 revision을 올리지 않는다.

## 상태와 예외

| 현재 상태 또는 상황 | 사건 | 기대 상태 또는 동작 |
|---|---|---|
| stale baseRevision | Board 계약 저장 | HTTP 409와 현재 계약을 반환한다. |
| 유효 baseRevision | 계약 저장 | revision이 1 증가하고 impact와 최신 평가를 반환한다. |

## 기능별 설계 계약

### DCP-05

#### 입력

- 현재 baseRevision과 변경할 profile, enforcement, policy

#### 출력

- 증가한 revision, 변경 impact와 최신 평가 결과

#### 업무 규칙

- 변경은 기존 파일을 삭제·이동·병합하지 않으며 history를 전진시킨다.

#### 상태와 전이

- baseRevision 일치 시 revision이 1 증가하고 stale revision이면 현재 계약을 반환한다.

#### 권한과 승인

- CLI contract set 또는 token이 유효한 Board 요청만 계약을 변경한다.

#### 정상·오류·취소

- 유효 변경은 원자적으로 저장하고 stale·invalid 입력은 HTTP 409 또는 CLI 오류로 원본을 보존한다.

#### 감사 기록

- 이전 profile 이름과 새 revision이 history와 프로젝트 브랜치 커밋에 남는다.

#### 수용 기준

- 동시 변경은 조용히 덮어쓰지 않고 한 요청만 성공하며 나머지는 최신 revision을 받는다.
