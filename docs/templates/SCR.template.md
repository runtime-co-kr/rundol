---
id: SCR-000
type: document
kind: screen
title: <화면 또는 상호작용 제목>
description: <사용자가 이 화면에서 달성하는 목표와 주요 상태를 한 문장으로 작성>
granularity: bounded-v1
scope: "<문서 책임 범위>"
excludes:
  - "<인접하지만 이 문서가 책임지지 않는 범위>"
owner: "[[project#^MEMBER-001|Product UX Owner]]"
state: draft
tags:
  - rundol/artifact
  - artifact/screen
  - domain/<domain>
  - feature/<feature>
aliases:
  - SCR-000
related:
  - "[[REQ-000-<요구사항명>|REQ-000]]"
---

# <화면 또는 상호작용 제목>

## 진입

<진입 경로, 권한, URL/라우트, 사전조건>

## 사용자 흐름

1. <사용자 행동과 시스템 반응>

## 바인딩

| UI 요소 | 데이터 원천 | 표시/검증 규칙 | 사용자 행동 |
|---|---|---|---|

## 상태

| 상태 | 진입 조건 | 표시 내용 | 허용 행동 |
|---|---|---|---|
| loading | | | |
| empty | | | |
| error | | | |
| ready | | | |

## 접근성과 반응형

<키보드, 스크린리더, 포커스, 화면 크기 기준>

## 디자인에 없는 것

<오류 문구, 권한 차이, 타임아웃, 동시 수정 등 그림으로 표현되지 않은 규칙>
