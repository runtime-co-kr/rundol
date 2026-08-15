---
id: ARC-002
type: document
kind: architecture
title: 런돌 시스템 아키텍처
description: Git 기반 Workspace, 프로젝트별 상태 브랜치, CLI 문서 계약 evaluator와 로컬 Board의 경계와 실행 구조
owner: "[[project#^MEMBER-001|프로젝트 책임자]]"
state: active
tags:
  - rundol/artifact
  - artifact/architecture
  - domain/rundol
  - feature/rundol-시스템-아키텍처
aliases:
  - ARC-002
related:
  - "[[REQ-010-문서-계획-계약-요구사항|REQ-010]]"
  - "[[REQ-011-보드-문서-계획과-표시-설정-요구사항|REQ-011]]"
  - "[[TST-002-문서-계획-계약-검증|TST-002]]"
---

# 런돌 시스템 아키텍처

## 컨텍스트와 경계

Rundol은 기존 Git 저장소 안에서 프로젝트 문서, 태스크, 책임과 변경 이력을 검증 가능한 상태로 운영하는 로컬 우선 도구다. 사용자는 CLI 또는 localhost Board를 통해 작업하며, AI 클라이언트는 설치된 Rundol 스킬과 동일한 CLI 계약을 따른다.

시스템의 정본 경계는 Git이다. 애플리케이션 소스가 있는 일반 브랜치와 별도로 Workspace 설정은 `rundol/workspace`, 프로젝트 산출물은 `rundol/<project-key>` 브랜치가 소유한다. 각 브랜치는 `projects/workspace/`, `projects/<project-key>/` linked worktree로 연결된다. npm registry와 Git remote는 설치·동기화 시에만 사용하는 외부 경계이며, 문서 작성과 검증은 네트워크 없이 동작한다.

문서 계획 계약은 프로젝트별 `project.md`의 `documentProfile`이 소유한다. `rules.<TYPE>.after`는 AI 추천 문맥일 뿐 생성·저장 순서를 강제하지 않으며, `policy`, `omissions`, `enforcement`, `revision`은 CLI·스킬·Board가 공유하는 계약이다.

구현 준비도는 각 REQ·SCR·MOD·API·TST의 `implementationContract: atomic-v1`과 `functionIds`가 소유한다. 한 파일에 여러 기능을 배치해도 각 기능은 유형별 전체 필드를 독립적으로 가지며, 추적성은 이 ID와 직접 링크에서 메모리로 계산한다. INDEX·카탈로그·추적표는 별도 정본으로 저장하지 않는다.

## 컴포넌트

| 컴포넌트 | 책임 | 소유 데이터 | 의존 대상 | 담당 팀/역할 |
|---|---|---|---|---|
| CLI 진입점 `bin/rdl.js` | 명령 파싱, 프로젝트 선택, 도메인 서비스 호출과 JSON 출력 | 없음 | Workspace, state, check, document, Board 서비스 | 프로젝트 책임자 |
| Workspace·bootstrap | 로컬/원격 Rundol 상태 발견, manifest·ref·worktree 연결과 복구 | Workspace registry, project manifest | Git | 프로젝트 책임자 |
| 프로젝트 상태·태스크 | 태스크 shard, operation, projection, save·sync와 semantic merge | `tasks/**`, `.rundol/state` 로컬 projection | Git, collaboration store | 프로젝트 책임자 |
| 문서·계약 evaluator | 정규 문서 생성, profile 정규화, omission·checkpoint 평가 | `project.md`, `docs/**` | 문서 템플릿, frontmatter parser | 프로젝트 책임자 |
| 구현 계약 검사기 | 기능별 유형 전용 필드, 미확정 규칙, 묶음 명세와 REQ·TST 대응 검증 | 진단과 계산형 trace | 정규 문서 registry, task links | 검토자·품질 담당자 |
| 검증기 | 거버넌스, 태스크, 링크, 문서 계약, Vault와 구조 진단 | 진단 결과만 생성 | Workspace·문서·태스크 reader | 검토자·품질 담당자 |
| Collaboration store | Client registry와 lease event 저장·조회 | `projects/workspace/clients`, `events` | Workspace branch | 운영 담당자 |
| Local Board | 문서·태스크·협업·계약 snapshot과 로컬 편집 UI 제공 | UI 상태, project/Workspace `board.json` | 동일 도메인 서비스, localhost HTTP | 사용자·프로젝트 책임자 |
| 패키지 배포 | core, protocol, board, node, cli, 통합 rundol 패키지 빌드·공개 | npm package tarball | GitHub Actions, npm trusted publishing | 릴리스 책임자 |

## 데이터 흐름

1. `rdl init`은 현재 Git 저장소에서 manifest, Rundol refs와 worktree를 읽어 `created|attached|repaired|already-connected|needs-selection|conflict` 동작을 결정한다.
2. 문서 작업 전 CLI는 `project.md` 계약과 실제 `docs/**` registry를 읽어 `ready`, 추천 문맥, omission 상태와 위반을 계산한다.
3. `rdl doc create`는 등록 owner, 관련 산출물과 function-id를 검증한 뒤 기능별 독립 계약 섹션을 가진 정규 파일을 만든다.
4. AI 또는 사용자는 기능별 본문을 편집하고 `rdl check --strict --implementation`과 계산형 `rdl contract trace`로 구현 준비도를 검증한다.
5. 태스크 명령은 client별 shard를 갱신하고 operation과 projection을 기록한 뒤 프로젝트 브랜치에 커밋하며 구현 태스크의 done 전환을 기능별 REQ·TST 계약으로 제한한다.
6. `rdl save`는 Workspace 설정과 선택 프로젝트를 검증·커밋한다. `rdl sync`는 Workspace를 먼저 동기화한 뒤 프로젝트 ref를 fetch, merge, 검증, push한다.
7. Board는 동일 reader로 snapshot을 만들고 revision 기반 쓰기 API와 atomic-v1·준비 기능 수·무인덱스 요약을 제공한다.

## 실행과 배포

| 영역 | 설계 |
|---|---|
| 런타임 | Node.js CLI와 표준 라이브러리 중심 CommonJS 모듈. 지원 기준은 Node.js 20 이상이며 CI는 현재 지원 Node matrix를 검증한다. 직접 의존성이 요구하는 최소 런타임과 CI가 실제로 검증하는 버전이 지원 기준이며, 셋 중 하나만 낮게 적어두지 않는다. |
| 네트워크 | 기본 동작은 로컬 파일·Git. Board는 `127.0.0.1` HTTP에만 bind하고, Git sync와 npm 설치·배포만 외부 네트워크를 사용한다. |
| 저장소 | Git refs와 linked worktree가 정본이다. `.rundol/state`, logs, `.obsidian`은 로컬 실행·개인 설정이며 Git 추적 대상과 분리한다. |
| 배포 단위 | npm의 `@rundol/core`, `protocol`, `board`, `node`, `cli`, `rundol` 패키지. CLI build는 검증된 root 소스·문서·스킬을 dist로 복제한다. |
| 관측 | CLI JSON 결과, `rdl doctor`, `rdl check`, debug JSONL, Board 운영 상태와 Git sync 상태를 제공한다. 원격 telemetry는 전송하지 않는다. |
| 복구 | bootstrap repair, Git fast-forward·semantic merge, pending conflict 기록, migration dry-run·rollback, 명시적 backup ref를 사용한다. 강제 push는 정상 경로에서 사용하지 않는다. |

## 품질 속성

| 속성 | 목표 | 설계 대응 | 검증 방법 |
|---|---|---|---|
| 로컬 우선 | 네트워크 장애에도 작성·검증 가능 | 파일·Git 기반 도메인 서비스, 선택적 remote | offline CLI 시나리오와 init/attach 테스트 |
| 결정성 | 같은 정본 상태에서 같은 평가 결과 | 정렬된 registry, profile 정규화, 공용 evaluator | document profile/contract deep equality 테스트 |
| 추적성 | 요구·태스크·검증을 실제 ID와 파일로 연결 | frontmatter, Wiki link, task links, strict 검사 | `rdl check --strict` |
| 구현 준비도 | 묶음 명세와 미확정 규칙으로 구현을 시작하지 않음 | atomic-v1 기능 섹션, task done gate, 계산형 trace | `rdl check --implementation` |
| 안전성 | 자동 연결·migration·cleanup이 사용자 파일을 잃지 않음 | discovery-before-write, conflict preflight, dry-run과 rollback | bootstrap, migration, structure 회귀 테스트 |
| 동시성 | Board와 다중 Client 변경의 stale write 방지 | revision, lease, semantic merge, HTTP 409 | Board workspace와 Git 통합 테스트 |
| 배포 신뢰성 | package 경계와 버전이 항상 일치 | version-check, tarball install, OIDC trusted publishing | `npm run release:check`와 Release workflow |
| 사용성 | 문서 계약이 작은 프로젝트와 AI 작업을 과도하게 차단하지 않음 | 추천 문맥 비차단, omission 명시, Board 자유 구성요소 편집 | contract/Board UI 테스트와 브라우저 검증 |

## 보안과 개인정보

Board의 변경 API는 실행 시 생성한 token을 요구하고 stale revision을 거부한다. 서버는 기본적으로 loopback 주소에만 노출하며 CSP, `X-Content-Type-Options`, frame 차단 헤더를 적용한다. 읽기 API는 로컬 프로세스가 접근할 수 있으므로 공유 머신에서는 Board 실행 계정과 저장소 권한을 신뢰 경계로 본다.

Git 자격 증명과 npm 인증 정보는 Rundol 파일에 저장하지 않고 기존 Git credential helper와 npm trusted publishing을 사용한다. Doctor 출력은 URL credential과 token을 마스킹한다. 문서·태스크에는 프로젝트 운영에 필요한 책임 정보만 저장하며, telemetry나 원격 사용량 수집은 하지 않는다.

## 알려진 제약

- Board는 단일 로컬 Node 프로세스이며 조직용 중앙 협업 서버가 아니다. 원격 다중 사용자 실시간 편집이 필요해지면 별도 서버 경계를 ADR로 검토한다.
- 문서 계약은 정규 문서 유형 10개와 project charter를 중심으로 한다. 사용자 정의 kind가 필요해지면 호환성·migration 비용을 먼저 평가한다.
- `rules.after`는 하위 호환 필드명 때문에 순서를 암시하지만 실제 의미는 비차단 AI 추천 문맥이다. 다음 schema major 변경 시 명시적 이름으로의 이전을 검토한다.
- Board 읽기 API는 token을 요구하지 않는다. loopback 외 접근 요구가 생기면 읽기 인증과 위협 모델을 선행 설계한다.
- 패키지 빌드는 root 소스 복제 방식이다. 컴파일 또는 독립 package 개발이 필요해지면 단일 소스 정본과 release reproducibility를 유지하는 전환 계획이 필요하다.
