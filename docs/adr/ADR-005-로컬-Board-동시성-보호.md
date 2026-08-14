---
id: ADR-005
type: document
kind: adr
title: 로컬 보드 동시성 보호
description: loopback 세션 token, 낙관적 entity revision, 5분 소프트 lease를 결합해 로컬 Board 변경의 인증과 동시성을 보호한다.
granularity: bounded-v1
scope: "localhost token 낙관적 revision soft lease를 함께 사용하는 동시성 보호 결정"
excludes:
  - "공개 네트워크 다중 사용자 인증과 중앙 잠금"
owner: "[[project#^MEMBER-001|프로젝트 책임자]]"
state: accepted
tags:
  - rundol/artifact
  - artifact/adr
  - domain/rundol
  - feature/local-board-concurrency
aliases:
  - ADR-005
related:
  - "[[ARC-004-로컬-Board와-협업-아키텍처|ARC-004]]"
  - "[[API-003-Board-변경과-동시성-API|API-003]]"
  - "[[MOD-003-문서-리스-이벤트-데이터-모델|MOD-003]]"
---

# 로컬 보드 동시성 보호

## 맥락

Board는 한 로컬 계정의 파일과 Git 저장소를 직접 수정한다. 브라우저 탭, CLI, AI Client가 동시에 같은 문서나 태스크를 편집할 수 있으므로 마지막 저장이 이전 변경을 조용히 덮어쓰면 안 된다. 반면 중앙 인증 서버나 분산 lock service를 도입하면 로컬 우선 제품의 설치·오프라인 특성을 훼손한다.

## 결정 기준

- 외부 네트워크에 서비스가 노출되지 않아야 한다.
- stale write를 검출하고 최신 entity를 돌려줘야 한다.
- 편집 의도를 다른 Client가 미리 확인할 수 있어야 한다.
- 비정상 종료 뒤 영구 lock이 남지 않아야 한다.
- Git과 strict 문서 검증을 최종 무결성 계층으로 유지해야 한다.

## 선택지

| 선택지 | 장점 | 단점 | 위험 |
|---|---|---|---|
| 파일 lock만 사용 | 구현이 단순 | 비정상 종료 시 고착, 의미 충돌 미검출 | 강제 해제 중 변경 손실 |
| 중앙 DB와 사용자 인증 | 강한 세션·lock 관리 | 서버 운영과 migration 필요 | 로컬 우선·오프라인 목표 훼손 |
| token + 낙관적 revision + 만료 lease | 중앙 서비스 없이 겹치는 위험을 계층별 완화 | lease가 강제 lock은 아님 | Client가 규약을 무시하면 편집 중복 |

## 결정

2026-08-14, 세 계층을 결합한다.

- 서버는 `127.0.0.1`에만 bind하고 실행마다 24-byte random hex token을 만든다. 모든 비-GET 요청은 `X-Rundol-Token`이 일치해야 한다.
- 문서와 태스크는 조회 응답의 SHA-256 entity revision을 `baseRevision`으로 요구한다. 불일치는 `409 Conflict`와 현재 entity를 반환한다.
- 문서 편집 의도는 Workspace branch의 append-only lease 이벤트로 공유한다. acquire와 renew는 5분 뒤 만료되며 release 또는 만료 뒤 다른 Client가 획득할 수 있다.
- lease 변경은 active Client, 프로젝트 charter에 등록된 owner member, 존재하는 document를 요구한다. 보유 Client만 renew/release할 수 있다.
- lease는 advisory 계층이다. 실제 저장은 revision 비교, strict 문서 검사, Git 경계를 계속 통과해야 한다.

## 결과

- 긍정적 결과: 별도 서버 없이 무단 로컬 POST, stale write, 일반적인 동시 편집을 서로 다른 계층에서 차단한다.
- 부정적 결과: token을 가진 로컬 프로세스는 같은 권한을 가지며 lease를 무시한 CLI 편집 자체는 막지 못한다.
- 후속 작업: UI는 편집 시작 시 lease를 획득하고 저장·취소 시 release하며, 409 응답에서 최신 entity를 비교하도록 유지한다.
- 재검토 조건: Board가 loopback 밖에 bind되거나 여러 OS 계정·원격 사용자가 동시에 접속하거나 강제 잠금·감사 승인 요구가 생길 때 중앙 인증과 저장 계층을 별도 ADR로 결정한다.
