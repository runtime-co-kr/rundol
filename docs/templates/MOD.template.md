---
id: MOD-000
type: document
kind: model
title: <데이터 영역 제목>
description: <이 모델이 표현하는 데이터와 핵심 불변식을 한 문장으로 작성>
granularity: bounded-v1
scope: "<문서 책임 범위>"
excludes:
  - "<인접하지만 이 문서가 책임지지 않는 범위>"
owner: "[[project#^MEMBER-001|Data Engineering Owner]]"
state: draft
tags:
  - rundol/artifact
  - artifact/model
  - domain/<domain>
  - feature/<feature>
aliases:
  - MOD-000
related:
  - "[[REQ-000-<요구사항명>|REQ-000]]"
  - "[[ARC-001-<시스템명>-아키텍처|ARC-001]]"
---

# <데이터 영역 제목>

## 엔티티

| 엔티티 | 필드 | 타입 | 필수 | 의미 | 제약 |
|---|---|---|---|---|---|

## 관계

| 출발 | 관계 | 대상 | 카디널리티 | 삭제/수명주기 의미 |
|---|---|---|---|---|

## 불변식

- <항상 참이어야 하는 규칙>

## 인덱스와 조회

| 조회 패턴 | 정렬/필터 | 인덱스 또는 접근 전략 |
|---|---|---|

## 보존과 개인정보

| 데이터 | 보존 기간 | 삭제/익명화 | 접근 권한 |
|---|---|---|---|

## 마이그레이션

<기존 데이터 변환, 롤백, 호환성 계획>
