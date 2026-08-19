---
id: IFC-002
uid: KY9721FA
type: document
kind: interface
title: 보드 조회와 스냅샷 인터페이스
description: BOP-01의 loopback 읽기 전용 HTTP endpoint, 필터, 통합 snapshot 응답과 영역별 revision 계약을 정의한다.
granularity: bounded-v1
implementationContract: atomic-v1
functionIds:
  - BOP-01
scope: "BOP-01 문서 태스크 Client lease sync contract를 조회하는 HTTP 인터페이스"
excludes:
  - "변경 요청의 token 인증과 baseRevision 충돌 처리"
owner: "[[project#^MEMBER-001|프로젝트 책임자]]"
state: active
tags:
  - rundol/artifact
  - artifact/interface
  - domain/rundol
  - feature/board-read-api
aliases:
  - IFC-002
related:
  - "[[REQ-021-로컬-보드-실행과-스냅샷|REQ-021]]"
  - "[[TST-011-로컬-보드-실행과-스냅샷-검증|TST-011]]"
  - "[[ARC-004-로컬-Board와-협업-아키텍처|ARC-004]]"
---

# 보드 조회와 스냅샷 인터페이스

## 공통 계약

- base URL은 Board가 출력한 `http://127.0.0.1:<port>`이며 버전 prefix가 없는 로컬 전용 API다.
- 모든 조회는 `GET`, 인증 없음, 멱등, server-side timeout 없음이다.
- JSON 응답은 UTF-8, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`를 사용한다.
- project key는 `[a-z0-9-]+`, document ID path segment는 percent-encoding한다.

## 엔드포인트

| method·path | 목적 | 성공 응답 |
|---|---|---|
| `GET /api/overview` | Workspace 전체 집계 | `{schemaVersion, projects, totals}` |
| `GET /api/projects` | 프로젝트 summary 배열 | `[{key,name,counts,tasks,attention}]` |
| `GET /api/projects/:key` | 프로젝트 summary 단건 | summary 또는 `404` |
| `GET /api/projects/:key/tasks` | 프로젝트 태스크 검색 | query result |
| `GET /api/projects/:key/tasks/:taskId` | 태스크 단건 | task 또는 `404` |
| `GET /api/projects/:key/documents` | 정본 Markdown 문서 목록 | `{project,documents}` |
| `GET /api/projects/:key/documents/:documentId` | 문서 단건 | document 또는 `404` |
| `GET /api/projects/:key/leases` | 현재 유효 lease | `{project,leases}` |
| `GET /api/projects/:key/sync` | Git 상태 | sync object |
| `GET /api/projects/:key/contract` | 문서 profile 계약 | contract object |
| `GET /api/projects/:key/board-snapshot` | Board 통합 조회 | snapshot object |
| `GET /api/clients` | Workspace Client registry | `{root,clients}` |

호환용 `GET /api/tasks`, `/api/tasks/:taskId`, `/api/revision`, `/api/collaboration`도 선택된 프로젝트를 기준으로 유지한다.

## 태스크 검색 요청

| query | 타입 | 필수 | 검증·기본값 |
|---|---|---|---|
| `q` | string | 아니요 | ID·title·summary의 소문자 부분 일치 |
| `owner` | string | 아니요 | 정확히 일치 |
| `priority` | string | 아니요 | 정확히 일치 |
| `status` | string | 아니요 | 정확히 일치; 알려지지 않은 값은 빈 결과 가능 |
| `offset` | integer | 아니요 | 최소 0, 기본 0 |
| `limit` | integer | 아니요 | 1..500, 기본 100 |

응답은 `{tasks,total,offset,limit,counts,owners,statuses}`다. 정렬은 `high`, `mid`, `low`, 기타 우선순위 후 task ID 오름차순이다. `counts`는 status filter를 적용하기 전 q·owner·priority 결과를 기준으로 한다.

## 문서와 sync 응답

문서 항목은 `{id,type,kind,title,description,owner,state,tags,related,file,body,modifiedAt,revision}`이다. `revision`은 frontmatter metadata와 body JSON 표현의 SHA-256 hex다.

sync는 `{project,head,remoteRef,ahead,behind,dirty,changedFiles,conflicts,state}`를 반환한다. `state`는 `conflict`, `diverged`, `behind`, `ahead`, `modified`, `clean` 중 하나며 upstream이 없으면 ahead/behind는 null이다.

## 통합 snapshot 응답

`GET /api/projects/:key/board-snapshot`은 다음 필드를 모두 반환한다.

| 필드 | 타입 | 내용 |
|---|---|---|
| `project` | string | 선택 project key |
| `revision` | object | `workspace,tasks,documents,people,clients,leases,sync,contract,presentation` SHA-1/SHA-256 파생 revision |
| `projects` | array | Workspace project summaries |
| `documents` | array | 본문 포함 문서 목록 |
| `tasks` | object | 동일 query를 적용한 task result |
| `attention` | array | 담당자·완료조건·reviewer·선행 task·깨진 링크·sync 경고 |
| `people` | object | charter의 role/member/stakeholder |
| `clients`, `leases` | array | schemaVersion 6 협업 상태 |
| `sync`, `contract`, `presentation` | object | 운영·계약·표시 상태 |
| `runs`, `proposals` | array | 현재 구현에서는 빈 배열 |

## 오류 계약

| 상태 | 조건 | 본문 |
|---|---|---|
| `404` | project summary, task, document 또는 route 없음 | `{error}` |
| `500` | Workspace/layout/Git/JSONL 읽기나 내부 계산 실패 | `{error}` |

조회 실패는 자동 재시도하지 않는다. filesystem/Git 상태를 정리한 뒤 같은 GET을 다시 호출할 수 있다.

## 기능별 설계 계약

### BOP-01

#### 오퍼레이션과 경로

읽기 기능은 `GET /api/overview`, `GET /api/projects`, `GET /api/projects/:key`, `GET /api/projects/:key/tasks`, `GET /api/projects/:key/tasks/:taskId`, `GET /api/projects/:key/documents`, `GET /api/projects/:key/documents/:documentId`, `GET /api/projects/:key/leases`, `GET /api/projects/:key/sync`, `GET /api/projects/:key/contract`, `GET /api/projects/:key/board-snapshot`, `GET /api/clients`를 제공한다. 통합 조회는 `GET /api/projects/:key/board-snapshot`이 담당한다.

#### 권한

loopback OS 계정의 파일 읽기 권한을 사용한다. 별도 HTTP token은 요구하지 않으며 서버는 외부 interface에 bind하지 않는다.

#### 요청

project key와 선택적 task query만 받는다. request body는 받지 않으며 조회로 파일·ref·worktree를 변경하지 않는다.

#### 응답

정본 reader 결과와 계산된 revision을 JSON으로 반환한다. snapshot은 문서, 태스크, 책임 구조, Client, lease, Git, contract, presentation을 한 응답에 포함한다.

#### 업무 규칙

문서는 ID 순, Client는 파일명 순, task는 우선순위와 ID 순으로 결정적으로 정렬한다. 만료 lease는 제외하고 Needs Attention은 저장하지 않고 요청마다 계산한다.

#### 오류·취소·멱등성

모든 endpoint는 멱등이다. 연결 취소는 서버 상태를 바꾸지 않는다. 없는 단건 자원과 route는 404, reader 실패는 500이다.

#### 감사와 보안

GET 자체는 감사 event를 만들지 않는다. JSON은 no-store이며 정적 UI는 CSP와 frame 차단을 사용한다. 응답에 session token이나 Git credential을 포함하지 않는다.

#### 수용 기준

- snapshot은 workspace, tasks, documents, people, clients, leases, sync, contract, presentation 영역과 각 문자열 revision을 반환한다.
- 문서 목록은 body와 entity revision을 포함한다.
- task filter·pagination·정렬이 계약대로 동작한다.
- sync state와 active lease가 현재 Git·event 상태에서 계산된다.
- 조회 호출 전후 Git ref와 파일 내용이 동일하다.
