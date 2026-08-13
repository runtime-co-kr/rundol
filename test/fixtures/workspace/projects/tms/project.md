---
id: project:tms
type: project
kind: charter
title: 차량 관제 프로젝트
description: TMS 차량관제 프로젝트의 미션, 목표, 역할, 팀원과 내·외부 이해관계자를 정의한다.
owner: "[[project#^MEMBER-001|강영준]]"
state: active
tags:
  - rundol/artifact
  - artifact/project-charter
  - domain/tms
  - feature/tms-fleet-control
aliases:
  - project:tms
related:
  - "[[PRD-001-차량관제-제품요구사항|PRD-001]]"
  - "[[ARC-001-차량관제-시스템아키텍처|ARC-001]]"
---

# 차량 관제 프로젝트

## 미션

운송 운영자가 전화와 수기 확인에 의존하지 않고 차량 위치와 운행 이상을 신속하게 파악하고 대응할 수 있는 신뢰 가능한 관제 체계를 구축한다.

## 목표

| ID | 목표 | 성공 조건 | 책임 역할 | 근거 |
|---|---|---|---|---|
| GOAL-001 | 차량 위치 가시성 확보 | 정상 운행 차량 99%의 최근 위치를 60초 이내 표시 | ROLE-002 | [[REQ-001-실시간-차량위치관제|REQ-001]] |
| GOAL-002 | 이상 대응시간 단축 | 이상 발생부터 운영자 확인까지 중앙값 3분 이내 | ROLE-004 | [[REQ-002-운행이상-알림|REQ-002]] |
| GOAL-003 | 조치 이력 보존 | 조치 기록 없는 종료 alert 비율 1% 미만 | ROLE-008 | [[REQ-003-관제조치-이력|REQ-003]] |
| GOAL-004 | 운영 가능한 복구 체계 | 위치 projection을 30분 이내 재구축 | ROLE-005 | [[ADR-001-텔레메트리-저장소분리|ADR-001]] |

## 범위

- 포함: 차량 telemetry 수집, 실시간 위치 관제, 운행 이상 알림, 조치 이력, 관측·복구 절차
- 제외: 배차 최적화, 운임 정산, 차량 단말 firmware 개발
- 경계 변경: Product Lead와 Engineering Lead가 공동 승인하고 제품 범위는 PRD, 되돌리기 어려운 기술 선택은 ADR로 기록한다.

## 역할

### Product Lead ^ROLE-001

- 미션: 사용자 문제, 제품 범위와 우선순위를 결정한다.
- 결정권: PRD, REQ, 제품 마일스톤
- 주요 산출물: PRD, 요구사항, 수용 기준
- 에스컬레이션: 프로젝트 책임자

### Engineering Lead ^ROLE-002

- 미션: 품질 목표를 만족하는 시스템 구조와 기술 의사결정을 책임진다.
- 결정권: ARC, MOD, API, 기술 ADR
- 주요 산출물: 아키텍처, 데이터 모델, 기술 결정
- 에스컬레이션: 프로젝트 책임자와 기술위원회

### Product UX ^ROLE-003

- 미션: 운영자가 상태를 오해하지 않고 빠르게 대응하는 화면과 상호작용을 설계한다.
- 결정권: SCR, 사용자 흐름, 접근성
- 주요 산출물: 화면 명세와 프로토타입
- 에스컬레이션: Product Lead

### Backend Feature ^ROLE-004

- 미션: telemetry 수집, 관제 API와 이상 감지 기능을 구현한다.
- 결정권: SPC 내부 구현과 서비스 상세 설계
- 주요 산출물: API, worker, component test
- 에스컬레이션: Engineering Lead

### Platform Data ^ROLE-005

- 미션: event stream, 저장소, projection과 복구 가능성을 책임진다.
- 결정권: 데이터 처리·저장·replay 구현
- 주요 산출물: projection, migration, recovery tooling
- 에스컬레이션: Engineering Lead

### Frontend ^ROLE-006

- 미션: 관제 지도와 상세 조치 UI를 구현하고 상태 신선도를 정확히 표현한다.
- 결정권: Web component와 client state 구현
- 주요 산출물: Control Web와 UI test
- 에스컬레이션: Engineering Lead와 Product UX

### Quality ^ROLE-007

- 미션: 요구사항부터 운영 복구까지 검증 가능한 품질 증거를 만든다.
- 결정권: TST, release quality gate
- 주요 산출물: contract, E2E, performance test
- 에스컬레이션: 프로젝트 책임자

### Operations ^ROLE-008

- 미션: 배포, 관측, 장애 대응과 관제 운영 인수인계를 책임진다.
- 결정권: RUN, 배포 중단과 rollback
- 주요 산출물: 운영 절차, dashboard, incident 기록
- 에스컬레이션: 프로젝트 책임자와 운영본부

### Project Facilitator ^ROLE-009

- 미션: 의존성, 대기 상태, 회의 결정과 이해관계자 소통을 가시화한다.
- 결정권: 일정 조정 제안과 에스컬레이션 요청
- 주요 산출물: 진행 현황과 결정 follow-up
- 에스컬레이션: 프로젝트 책임자

## 프로젝트 팀원

### 강영준 ^MEMBER-001

- 역할: [[project#^ROLE-002|Engineering Lead]]
- 소속: AIWorks 기술본부
- 업무 계정: `youngjun-kang`
- 책임 영역: 프로젝트 책임, 시스템 아키텍처와 기술 결정
- 상태: active

### 박서연 ^MEMBER-002

- 역할: [[project#^ROLE-001|Product Lead]]
- 소속: AIWorks 제품본부
- 업무 계정: `seoyeon-park`
- 책임 영역: 제품 범위, 요구사항과 운영본부 협의
- 상태: active

### 이도윤 ^MEMBER-003

- 역할: [[project#^ROLE-003|Product UX]]
- 소속: AIWorks 제품본부
- 업무 계정: `doyun-lee`
- 책임 영역: 관제 화면, 사용자 흐름과 접근성
- 상태: active

### 최민석 ^MEMBER-004

- 역할: [[project#^ROLE-004|Backend Feature]]
- 소속: AIWorks 기술본부
- 업무 계정: `minseok-choi`
- 책임 영역: telemetry gateway와 관제 API
- 상태: active

### 정하린 ^MEMBER-005

- 역할: [[project#^ROLE-005|Platform Data]]
- 소속: AIWorks 플랫폼본부
- 업무 계정: `harin-jung`
- 책임 영역: event stream, projection과 저장소
- 상태: active

### 김태현 ^MEMBER-006

- 역할: [[project#^ROLE-004|Backend Feature]]
- 소속: AIWorks 기술본부
- 업무 계정: `taehyun-kim`
- 책임 영역: 이상 감지와 alert 조치
- 상태: active

### 윤지우 ^MEMBER-007

- 역할: [[project#^ROLE-006|Frontend]]
- 소속: AIWorks 기술본부
- 업무 계정: `jiwoo-yoon`
- 책임 영역: 관제 Web과 client state
- 상태: active

### 한서진 ^MEMBER-008

- 역할: [[project#^ROLE-007|Quality]]
- 소속: AIWorks 품질본부
- 업무 계정: `seojin-han`
- 책임 영역: 인수·성능·복구 테스트
- 상태: active

### 오지훈 ^MEMBER-009

- 역할: [[project#^ROLE-008|Operations]]
- 소속: AIWorks 운영본부
- 업무 계정: `jihoon-oh`
- 책임 영역: 배포, 관측과 장애 대응
- 상태: active

### 배수아 ^MEMBER-010

- 역할: [[project#^ROLE-009|Project Facilitator]]
- 소속: AIWorks PMO
- 업무 계정: `sua-bae`
- 책임 영역: 의존성, 진행 상태와 이해관계자 소통
- 상태: active

## 이해관계자

### 물류운영본부 ^STAKEHOLDER-001

- 유형: internal-organization
- 관심: 차량 위치 신뢰도, 이상 대응시간과 교대 인수인계
- 영향력: high
- 참여 방식: 격주 제품 검토, M2·M3 인수 승인
- 담당 역할: [[project#^ROLE-001|Product Lead]]

### 정보보호위원회 ^STAKEHOLDER-002

- 유형: internal-governance
- 관심: 위치정보 접근권한, 감사 로그와 보존기간
- 영향력: high
- 참여 방식: ARC·MOD 보안 검토, 배포 전 승인
- 담당 역할: [[project#^ROLE-002|Engineering Lead]]

### 지도 API 공급사 ^STAKEHOLDER-003

- 유형: external-organization
- 관심: API 사용량, 계약 준수와 장애 공지
- 영향력: medium
- 참여 방식: 계약 변경과 심각 장애 시 연락
- 담당 역할: [[project#^ROLE-008|Operations]]

### 차량 단말 공급사 ^STAKEHOLDER-004

- 유형: external-organization
- 관심: telemetry 계약, credential 회전과 firmware 호환성
- 영향력: high
- 참여 방식: API contract 변경 검토와 단말 장애 공동 대응
- 담당 역할: [[project#^ROLE-004|Backend Feature]]

## 책임 매트릭스

| 영역 | Responsible | Accountable | Consulted | Informed |
|---|---|---|---|---|
| 제품 범위와 요구사항 | MEMBER-002 | MEMBER-002 | STAKEHOLDER-001, MEMBER-003 | TEAM |
| 시스템 아키텍처 | MEMBER-001, MEMBER-005 | MEMBER-001 | STAKEHOLDER-002, MEMBER-004 | TEAM |
| Telemetry 수집 API | MEMBER-004 | MEMBER-001 | STAKEHOLDER-004, MEMBER-005 | MEMBER-008 |
| 이상 감지 | MEMBER-006 | MEMBER-001 | MEMBER-002, MEMBER-009 | STAKEHOLDER-001 |
| 관제 화면 | MEMBER-007 | MEMBER-003 | MEMBER-002, MEMBER-008 | STAKEHOLDER-001 |
| 인수·성능 테스트 | MEMBER-008 | MEMBER-008 | MEMBER-001, MEMBER-009 | TEAM |
| 배포와 장애 대응 | MEMBER-009 | MEMBER-009 | MEMBER-001, STAKEHOLDER-003 | STAKEHOLDER-001 |

## 의사결정과 에스컬레이션

- 역할 경계를 넘는 합의가 1영업일 안에 끝나지 않으면 MEMBER-010이 MEMBER-001에게 에스컬레이션한다.
- 제품 범위와 기술 품질 목표가 충돌하면 MEMBER-002와 MEMBER-001이 공동 결정하고 되돌리기 어려운 선택은 ADR로 남긴다.
- 위치정보 처리와 외부 제공 범위 변경은 STAKEHOLDER-002 검토 전 병합하지 않는다.
- critical 운영 장애에서는 MEMBER-009가 배포 중단과 rollback을 결정하고 사후 변경은 incident와 ADR에 기록한다.

## 위험과 제약

| ID | 위험 또는 제약 | 영향 | 대응 | 책임 역할 |
|---|---|---|---|---|
| RISK-001 | 단말별 telemetry 품질 편차 | 위치 신뢰도 저하 | 계약 검증과 격리 queue, 공급사 공동 분석 | ROLE-004 |
| RISK-002 | 위치정보 접근 오남용 | 개인정보·감사 위험 | 최소 권한, 감사 로그, 보존 정책 검토 | ROLE-002 |
| RISK-003 | 지도 API 장애와 비용 증가 | 관제 화면 중단·비용 초과 | 사용량 경보, cache와 장애 대체 화면 | ROLE-008 |
| RISK-004 | projection 손상 | 실시간 관제 불가 | replay 절차와 정기 복구 훈련 | ROLE-005 |

## 협업 리듬

- 진행 점검: 매일 팀원이 태스크 상태와 blocker를 갱신하고, 주 2회 MEMBER-010이 의존성을 검토한다.
- 산출물 검토: PRD·ARC·MOD·API·TST 변경은 관련 Accountable 멤버가 병합 전에 검토한다.
- 이해관계자 공유: 격주로 STAKEHOLDER-001에 제품 지표를 공유하고, 보안·계약 변경은 해당 이해관계자에게 즉시 알린다.

## 완료 정의

- REQ, SPC, 설계, TST와 구현 태스크의 추적 연결이 존재한다.
- 기능·성능·복구 인수 기준이 통과하고 결과가 TST에 남는다.
- 위치정보, 외부 공급사, 운영 영향이 담당 이해관계자에게 검토되었다.
- 배포·rollback·관측 절차가 최신이며 `rdl check --strict`에 오류와 경고가 없다.
