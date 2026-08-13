---
id: project:rundol
type: project
kind: charter
title: Rundol
description: <프로젝트의 미션, 목표, 역할과 이해관계자를 한 문장으로 작성>
owner: "[[project#^MEMBER-001|프로젝트 책임자]]"
state: active
tags:
  - rundol/artifact
  - artifact/project-charter
  - domain/<domain>
  - feature/<feature>
aliases:
  - project:rundol
related: []
documentProfile:
  schemaVersion: 2
  revision: 2
  name: lean
  enforcement: checkpoint
  traits: []
  history: [lean, lean]
  policy:
    required: [PRD, REQ]
    recommended: []
    onDemand: [ARC, MOD, API, ADR, TST, RUN, GLS]
    disabled: [SCR]
  rules:
    PRD:
      after: []
    REQ:
      after: [PRD]
    ARC:
      after: [REQ]
    SCR:
      after: [REQ]
    MOD:
      after: [REQ]
    API:
      after: [REQ]
    ADR:
      after: [ARC]
    TST:
      after: [REQ]
    RUN:
      after: [REQ]
    GLS:
      after: []
  omissions:
    SCR:
      absorbedBy: REQ
      sections: [사용자 흐름, 화면 상태, 입력과 검증, 접근성]
---

# Rundol

## 미션

<프로젝트 팀이 존재하는 이유와 제공해야 할 변화를 작성>

## 목표

| ID | 목표 | 성공 조건 | 책임 역할 | 근거 |
|---|---|---|---|---|
| GOAL-001 | <목표> | <검증 가능한 종료 조건> | ROLE-001 | [[project|project]] |

## 범위

- 포함: <이번 프로젝트가 책임지는 제품·기술·운영 범위>
- 제외: <의도적으로 다루지 않는 범위와 이유>
- 경계 변경: <범위 변경 승인 역할과 기록할 ADR 또는 PRD>

## 역할

### <역할 이름> ^ROLE-001

- 미션: <이 역할이 달성해야 하는 결과>
- 결정권: <최종 결정할 수 있는 범위>
- 주요 산출물: <책임 문서와 결과물>
- 에스컬레이션: <합의되지 않을 때의 상위 역할>

## 프로젝트 팀원

### <프로젝트 책임자 이름> ^MEMBER-001

- 역할: [[project#^ROLE-001|역할 이름]]
- 소속: <조직 또는 회사>
- 업무 계정: <Git 계정 또는 조직 사용자 ID>
- 책임 영역: <담당 범위>
- 상태: active

## 이해관계자

### <내부 또는 외부 이해관계자> ^STAKEHOLDER-001

- 유형: internal-organization
- 관심: <기대하거나 우려하는 결과>
- 영향력: high
- 참여 방식: <정기 검토, 승인, 장애 연락 등>
- 담당 역할: [[project#^ROLE-001|역할 이름]]

## 책임 매트릭스

| 영역 | Responsible | Accountable | Consulted | Informed |
|---|---|---|---|---|
| <업무 영역> | MEMBER-001 | MEMBER-001 | STAKEHOLDER-001 | TEAM |

## 의사결정과 에스컬레이션

- <결정 종류, 제한 시간, 결정권자와 기록할 ADR 기준>

## 위험과 제약

| ID | 위험 또는 제약 | 영향 | 대응 | 책임 역할 |
|---|---|---|---|---|
| RISK-001 | <위험 또는 제약> | <일정·품질·보안 영향> | <회피·완화·수용 계획> | ROLE-001 |

## 협업 리듬

- 진행 점검: <주기, 참석 역할, 갱신할 태스크 상태>
- 산출물 검토: <주기, 승인자, 검토 증거>
- 이해관계자 공유: <대상, 주기, 채널과 책임 역할>

## 완료 정의

- 요구사항과 설계, 구현, 테스트 간 연결이 검증된다.
- 인수 기준과 품질 게이트를 통과하고 증거가 태스크 또는 TST에 연결된다.
- 운영·보안·데이터 영향이 검토되고 필요한 문서가 최신 상태다.
- `rdl check --strict` 결과에 오류와 경고가 없다.

