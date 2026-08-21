---
id: GLS-002
uid: ZQ0R8PE4
type: document
kind: glossary
title: 런돌 프로젝트 운영 용어
description: Workspace, 프로젝트, Client, lease, 문서 계약, task shard, revision과 Git branch 역할의 공통 의미와 금지 표현을 정의한다.
granularity: bounded-v1
scope: "Workspace 프로젝트 Client lease 문서 계약 task branch의 공용 운영 용어"
excludes:
  - "사용자 제품 도메인별 업무 용어"
owner: "[[project#^MEMBER-001|프로젝트 책임자]]"
state: active
tags:
  - rundol/artifact
  - artifact/glossary
  - domain/rundol
  - feature/project-operations-language
aliases:
  - GLS-002
related:
  - "[[ARC-003-Git-작업공간과-동기화-아키텍처|ARC-003]]"
  - "[[ARC-004-로컬-Board와-협업-아키텍처|ARC-004]]"
---

# 런돌 프로젝트 운영 용어

## 용어

| 용어 | 정의 | 사용 예 | 사용하지 않을 표현 |
|---|---|---|---|
| Workspace | 여러 프로젝트의 registry, Client manifest, lease event, 공통 Board 표시 설정을 소유하는 `rundol/workspace` 정본 | Workspace branch, Workspace worktree | 모든 프로젝트 문서 저장소 |
| 프로젝트 | 독립 charter·문서·태스크를 `rundol/<key>` branch에 소유하는 계획 단위 | 프로젝트 `rundol` | Workspace와 혼용한 작업공간 |
| 코드 branch | 저장소 root에서 제품 코드와 release asset을 소유하는 일반 branch | `main`, `trunk` | Rundol 문서 branch |
| project key | 소문자 kebab-case 프로젝트 식별자 | `customer-portal` | 표시 이름, 문서 ID |
| linked worktree | 한 Git object database의 branch를 canonical 별도 경로에 checkout한 작업 디렉터리 | `projects/rundol/` | 복사본, mount symlink |
| 문서 계약 | `project.md.documentProfile`의 type policy, enforcement, revision | contract check | Board 표시 설정, 프로필 프리셋 |
| canonical artifact | 정해진 type·ID·frontmatter·경로를 가진 프로젝트 정본 문서 | `REQ-019`, `ARC-004` | INDEX, 추적성 표 |
| atomic-v1 | 구현 기능 ID마다 유형별 필수 명세를 독립적으로 완성하는 계약 | `functionIds: [COL-01]` | 여러 기능 공통 placeholder |
| Client | device·agent·service 중 하나로 등록되고 MEMBER owner가 있는 협업 실행 주체 | `test-device` | 사용자 계정, HTTP session |
| ~~soft lease~~ (폐기) | 문서 편집 의도를 5분 동안 알리던 advisory 잠금. [[ADR-015-문서-소프트-리스-폐기와-동시성-판정의-일원화|ADR-015]]로 폐기했다. 새 문서와 대화에서 쓰지 않는다 | (없음) | 로컬 append 락, 태스크 클레임, Driver 임대 |
| 로컬 append 락 | 같은 장치의 여러 프로세스가 이벤트 원장에 동시에 쓰는 것을 직렬화하는 파일 락. 같은 파일시스템 안이라 실제로 보장된다 | append lock | soft lease, 분산 잠금 |
| 태스크 클레임 | 여러 장치의 실행이 같은 태스크를 중복 수행하지 않게 하는 장치. 원격 ref 갱신의 성패로 판정하므로 공통 시계를 요구하지 않는다 | push 경합, 비교-교환 | 시간 만료 임대 |
| entity revision | entity 내용으로 계산한 SHA digest 또는 contract의 numeric revision | `baseRevision` | Git branch revision과 무조건 동일 |
| snapshot | Board가 요청 시 정본과 Git 상태를 읽어 만든 저장하지 않는 통합 조회 모델 | board snapshot | 별도 정본 데이터베이스 |
| task shard | Client별 디렉터리에 최대 크기로 분할한 `000001.json` task 저장 segment | `tasks/client-a/000001.json` | 문서 목록, task projection |
| projection | shard 또는 정본 task store에서 계산한 로컬 통합 task view | `.rundol/state/tasks.json` | 정본 shard |
| semantic merge | task ID와 필드 의미를 기준으로 base·ours·theirs를 합치는 병합 | single store sync | 무조건적인 text merge |
| branch boundary | 코드·Workspace·프로젝트의 branch, worktree, push ref가 역할과 일치해야 하는 규칙 | `rdl git boundary` | 단순 디렉터리 권장사항 |
| Needs Attention | 담당자·완료조건·링크·의존성·sync 상태에서 계산한 Board 경고 | waiting/review 집계 | 저장된 승인 상태 |
| strict check | 구조·link·계약 오류를 error로 판정하는 검증 | `rdl check --strict` | 자동 수정 명령 |
| implementation check | 연결된 기능의 원자 계약과 REQ·TST 준비 상태를 검사하는 strict gate | `--implementation` | test 실행 자체 |
| managed hook | Rundol이 설치하고 marker로 식별하는 pre-push 경계 hook | 교차 push 차단 | 사용자 hook 삭제본 |
| trusted publishing | GitHub Actions OIDC 단기 token으로 npm package를 게시하는 방식 | provenance publish | 저장소의 장기 npm token |

## 식별자와 코드

| 이름 | 형식 | 의미 | 예시 |
|---|---|---|---|
| 문서 ID | `<TYPE>-NNN` | canonical artifact 식별자 | `ARC-004` |
| 프로젝트 charter ID | `project:<key>` | 프로젝트 정본 charter | `project:rundol` |
| 기능 ID | `<DOMAIN>-NN` | 독립 구현 기능 | `COL-01`, `BOP-02` |
| Member ID | `MEMBER-NNN` | project.md의 책임자 block | `MEMBER-001` |
| Client ID | 소문자 kebab-case | Client manifest와 event 파일 식별 | `test-device` |
| Lease ID | `LEASE-` + 20자리 대문자 hex | acquire부터 release까지 같은 lease | `LEASE-0123ABCDEF0123ABCDEF` |
| Event ID | `EVT-` + 20자리 대문자 hex | append event 유일 식별 | `EVT-0123ABCDEF0123ABCDEF` |
| Task ID | `TASK-` 접두 식별자 | 프로젝트 task 정본 key | `TASK-001` |
| Workspace branch | `rundol/workspace` | registry·Client·event 정본 | `refs/heads/rundol/workspace` |
| 프로젝트 branch | `rundol/<key>` | charter·docs·tasks 정본 | `refs/heads/rundol/rundol` |

## 표기 원칙

- 제품 UI 이름은 `Board`, 실행 주체는 `Client`, 편집 의도는 `lease`로 표기한다.
- Git의 branch/ref/revision과 HTTP entity revision을 문맥 없이 `버전` 하나로 부르지 않는다.
- Workspace 공통 설정과 프로젝트 고유 계약을 `설정` 하나로 합치지 않는다.
- canonical 문서 link는 실제 파일명을 사용하고 별도 INDEX·catalog·traceability matrix를 만들지 않는다.
- soft lease를 잠금 보장으로 설명하지 않으며 revision·strict check·Git 검증과 함께 설명한다.
