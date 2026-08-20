---
id: project:rundol
uid: FXEJWWQS
type: project
kind: charter
title: Rundol
description: Git 저장소 안에서 문서, 태스크, 책임, 협업 상태와 변경 이력을 검증 가능한 프로젝트 정보로 운영하는 로컬 우선 도구를 개발한다.
owner: "[[project#^MEMBER-001|강영준]]"
state: active
tags:
  - rundol/artifact
  - artifact/project-charter
  - domain/project-governance
  - feature/rundol-product
aliases:
  - project:rundol
related:
  - "[[PRD-001-Rundol-제품-요구사항|PRD-001]]"
documentProfile:
  schemaVersion: 2
  revision: 8
  name: assured
  enforcement: checkpoint
  traits: []
  history: [lean, lean, lean, lean, lean, lean, lean, assured]
  policy:
    required: [PRD, REQ, ARC, SCR, MOD, IFC, ADR, TST, RUN, STD, GLS]
    recommended: []
    onDemand: []
    disabled: []
---

# Rundol

## 미션

사람과 AI가 동일한 Git 저장소에서 프로젝트의 목적, 요구사항, 설계, 태스크, 책임과 검증 증거를 함께 읽고 안전하게 변경할 수 있는 로컬 우선 운영 기반을 제공한다.

## 목표

| ID | 목표 | 성공 조건 | 책임 역할 | 근거 |
|---|---|---|---|---|
| GOAL-001 | 프로젝트 정본을 일반 파일과 Git 이력으로 보존한다. | 격리 환경에서도 문서·태스크·검사가 동작하고 원격 동기화를 복구할 수 있다. | ROLE-001 | [[PRD-001-Rundol-제품-요구사항\|PRD-001]] |
| GOAL-002 | 기능 명세와 검증 증거의 완전성을 자동 판정한다. | 선언된 모든 기능 ID가 독립 REQ·TST 계약을 갖고 implementation 검사에 통과한다. | ROLE-001 | [[REQ-012-명령줄-AI-스킬-보드-통합-규격\|REQ-012]] |
| GOAL-003 | 코드, Workspace, 프로젝트 정보의 Git 소유 경계를 지킨다. | `rdl git boundary` 위반과 교차 ref push가 0건이다. | ROLE-001 | [[ARC-003-Git-작업공간과-동기화-아키텍처\|ARC-003]] |
| GOAL-004 | npm 설치와 릴리스를 반복 가능하게 운영한다. | release check와 게시 후 6개 패키지 버전 검증이 모두 통과한다. | ROLE-001 | [[REQ-024-패키지-버전과-릴리스-검증\|REQ-024]] |

## 범위

- 포함: Workspace와 프로젝트 bootstrap, Git branch/worktree 경계, 정규 문서와 태스크, 문서 계획 계약, 기능 추적, 협업 Client와 lease, localhost Board, 설치 진단과 npm 릴리스.
- 제외: 중앙 SaaS 데이터베이스, 범용 일정·회계·인사 관리, CRDT 실시간 공동 편집, 공개 네트워크용 다중 사용자 인증, AI 모델 실행과 비용 결제.
- 경계 변경: 제품 범위는 ROLE-001이 PRD를 검토해 승인하며, 시스템 경계나 되돌리기 어려운 기술 결정은 별도 ADR로 기록한다.

## 역할

### 제품·기술 책임자 ^ROLE-001

- 미션: Rundol의 제품 방향, 정본 계약, 기술 경계와 릴리스 품질을 일관되게 유지한다.
- 결정권: PRD 범위, 문서 계약, 공개 CLI/API 호환성, Git 경계, 릴리스 승인.
- 주요 산출물: project.md, PRD, REQ, ARC, ADR, TST, RUN, 릴리스 태그와 npm 패키지.
- 에스컬레이션: 보안·데이터 손실·호환성 파괴 위험은 배포를 중단하고 별도 ADR과 회귀 테스트를 요구한다.

### 구현·검증 담당 ^ROLE-002

- 미션: 승인된 기능 계약을 코드와 자동화된 증거로 구현하고 회귀를 차단한다.
- 결정권: 내부 구현 세부, 테스트 구조와 진단 근거. 공개 계약 변경은 ROLE-001 승인 대상이다.
- 주요 산출물: 코드, 단위·통합·설치 테스트, 태스크 acceptance 증거.
- 에스컬레이션: 요구사항 미확정, REQ-TST 추적 누락, branch boundary 위반은 ROLE-001에 즉시 보고한다.

## 프로젝트 팀원

### 강영준 ^MEMBER-001

- 역할: [[project#^ROLE-001|제품·기술 책임자]], [[project#^ROLE-002|구현·검증 담당]]
- 소속: 런타임
- 업무 계정: y.j.kang@runtime.co.kr
- 책임 영역: 프로젝트 전반 관리, 기술 의사결정 및 개발 총괄
- 상태: active

### 류승호 ^MEMBER-002

- 역할: [[project#^ROLE-002|구현·검증 담당]]
- 소속: 런타임
- 업무 계정: s.h.ryu@runtime.co.kr
- 책임 영역: UI 중심 개발과 품질 개선, 필요 시 기타 개발 지원
- 상태: active

## 이해관계자

### Rundol 사용자와 AI 개발 클라이언트 ^STAKEHOLDER-001

- 유형: user-community
- 관심: 적은 설정으로도 일관된 문서·태스크·Git 경계와 복구 가능한 로컬 작업 흐름을 얻는 것
- 영향력: high
- 참여 방식: GitHub 이슈, 사용 사례, 설치·Board·AI 스킬 회귀 피드백
- 담당 역할: [[project#^ROLE-001|제품·기술 책임자]]

### npm과 GitHub 배포 기반 ^STAKEHOLDER-002

- 유형: external-supplier
- 관심: SemVer, package metadata, trusted publishing과 워크플로 보안 계약 준수
- 영향력: medium
- 참여 방식: GitHub Actions 실행 결과와 npm registry 게시 상태로 자동 검증
- 담당 역할: [[project#^ROLE-002|구현·검증 담당]]

## 책임 매트릭스

| 영역 | Responsible | Accountable | Consulted | Informed |
|---|---|---|---|---|
| 제품 범위와 요구사항 | MEMBER-001 | MEMBER-001 | STAKEHOLDER-001 | TEAM |
| 아키텍처와 Git 경계 | MEMBER-001 | MEMBER-001 | STAKEHOLDER-001 | TEAM |
| 구현과 자동화 검증 | MEMBER-001 | MEMBER-001 | STAKEHOLDER-001 | TEAM |
| UI 개발과 품질 개선 | MEMBER-002 | MEMBER-001 | MEMBER-001 | TEAM |
| npm 릴리스 | MEMBER-001 | MEMBER-001 | STAKEHOLDER-002 | STAKEHOLDER-001 |

## 의사결정과 에스컬레이션

- 기능 구현은 독립 REQ와 TST가 준비되고 태스크 acceptance가 정의된 뒤 시작한다.
- 공개 CLI/API, 저장 형식, branch/ref 소유권 또는 보안 경계를 바꾸는 결정은 ADR을 요구한다.
- 데이터 손실, 잘못된 ref push, 릴리스 호환성 파괴 가능성이 있으면 즉시 작업을 중단하고 ROLE-001이 복구 또는 롤백을 결정한다.
- 일반 구현 이견은 관련 REQ·ARC·테스트 근거로 해결하며 한 작업 주기 안에 합의되지 않으면 ADR 후보로 승격한다.

## 위험과 제약

| ID | 위험 또는 제약 | 영향 | 대응 | 책임 역할 |
|---|---|---|---|---|
| RISK-001 | Git branch와 worktree 역할을 혼동한다. | 코드 또는 프로젝트 정본이 잘못된 ref에 게시될 수 있다. | managed pre-push hook과 `rdl git boundary`를 저장·배포 전 실행한다. | ROLE-001 |
| RISK-002 | 문서 유형 존재만으로 구현 준비를 오판한다. | 불완전한 요구사항으로 구현과 검수가 진행된다. | atomic-v1 필드와 기능별 REQ-TST trace를 implementation 모드로 검사한다. | ROLE-002 |
| RISK-003 | 로컬 Board의 읽기 정보가 같은 장치의 다른 프로세스에 노출된다. | 프로젝트 메타데이터의 로컬 기밀성이 약해질 수 있다. | localhost bind, mutation token, CSP를 유지하고 공개 네트워크 노출을 지원 범위에서 제외한다. | ROLE-001 |
| RISK-004 | npm·GitHub 외부 서비스 장애가 릴리스를 중단한다. | 검증된 버전 게시가 지연된다. | 태그와 release check 결과를 보존하고 외부 서비스 복구 후 동일 버전 게시 상태를 확인한다. | ROLE-002 |

## 협업 리듬

- 진행 점검: 작업 시작과 종료 때 Rundol 태스크 상태와 acceptance를 갱신한다.
- 산출물 검토: 문서 작성 직후 artifact strict 검사, 구현 전 implementation 검사, 릴리스 전 전체 release check를 수행한다.
- 이해관계자 공유: 패치마다 CHANGELOG와 마이그레이션 영향을 갱신하고 GitHub 릴리스 및 npm 게시 결과를 확인한다.
- 용어 기준: 문서와 태스크에 쓰는 운영 용어는 [[GLS-002-Rundol-프로젝트-운영-용어|GLS-002]]를 따른다.

## 완료 정의

- 기능별 REQ와 TST가 독립적인 전체 계약을 가지며 `rdl contract trace`가 ready를 반환한다.
- 구현, 문서, 태스크 acceptance와 자동화 테스트 증거가 직접 연결된다.
- 필요한 ARC·MOD·API·ADR·RUN·GLS가 한 책임 경계로 작성되고 INDEX나 generic DESIGN 문서를 정본으로 만들지 않는다.
- 코드, Workspace, 프로젝트 worktree가 각자 소유 branch와 원격 ref에만 동기화된다.
- `rdl check --strict --implementation`, `rdl check --structure`, 전체 테스트와 release check가 오류 없이 통과한다.
- 배포 대상 버전이 Git 태그, GitHub Actions와 npm registry에서 동일하게 확인된다.
