---
id: API-003
type: document
kind: api
title: 보드 변경과 동시성 인터페이스
description: BOP-02의 token 인증, 문서·태스크·contract 낙관적 revision, Client·lease·refresh·sync 변경 endpoint를 정의한다.
granularity: bounded-v1
implementationContract: atomic-v1
functionIds:
  - BOP-02
scope: "BOP-02 token과 revision으로 보호되는 Board 변경 HTTP 인터페이스"
excludes:
  - "읽기 전용 snapshot의 집계와 정렬"
owner: "[[project#^MEMBER-001|프로젝트 책임자]]"
state: active
tags:
  - rundol/artifact
  - artifact/api
  - domain/rundol
  - feature/board-mutation-api
aliases:
  - API-003
related:
  - "[[REQ-022-보드-변경-인증과-동시성|REQ-022]]"
  - "[[TST-012-보드-변경-인증과-동시성-검증|TST-012]]"
  - "[[ADR-005-로컬-Board-동시성-보호|ADR-005]]"
---

# 보드 변경과 동시성 인터페이스

## 공통 계약

- 모든 endpoint는 `POST`, `Content-Type: application/json`, `X-Rundol-Token: <session-token>`을 사용한다.
- token은 서버 실행 시 생성되며 불일치하면 body를 적용하지 않고 `403 {error:"유효하지 않은 로컬 세션입니다."}`를 반환한다.
- JSON body 최대 크기는 64KB다. 문서 `body` 값은 UTF-8 512KB까지 허용한다.
- JSON 응답은 UTF-8, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`다.

## 엔드포인트와 요청

| path | 요청 필수 필드 | 성공 |
|---|---|---|
| `POST /api/clients` | `id,name,type,owner` | `201` Client 등록 결과 |
| `POST /api/clients/:clientId/enable|disable` | 없음 | `200 {id,status,changed,commit?}` |
| `POST /api/projects/:key/tasks` | `title,acceptanceCriteria`; 선택 `summary,status,priority,owner,reviewers,stakeholders,links,deps,externalRefs` | `201` task create 결과 |
| `POST /api/projects/:key/tasks/:taskId` | `baseRevision`과 한 개 이상 변경 필드 | `200` task update 결과 |
| `POST /api/projects/:key/documents/:documentId` | `baseRevision,body` | `200` 새 document entity |
| `POST /api/projects/:key/contract/plan` | profile name/options | `200` 비파괴 impact plan |
| `POST /api/projects/:key/contract` | `baseRevision`과 profile 변경 | `200` 증가한 contract revision |
| `POST /api/projects/:key/leases/:documentId/acquire|renew|release` | `clientId` | `200` lease event 결과 |
| `POST /api/projects/:key/refresh` | 없음 | `200` refresh 결과 |
| `POST /api/projects/:key/sync` | 없음 | `200` origin fetch·merge·push 결과 |

호환 endpoint `POST /api/tasks`, `/api/tasks/:taskId`, `/api/collaboration/:id`, `/api/refresh`, `/api/sync`는 선택된 프로젝트에 같은 규칙을 적용한다.

## 태스크 입력 계약

`status`는 `todo|doing|waiting|review|done`, `priority`는 `high|mid|low`다. 문자열 필드는 trim하고 각 `title`·`summary`는 1000자 이하이다. `acceptanceCriteria`는 비어 있지 않은 object이며 각 key는 `^AC-[A-Z0-9]+$`, 값은 `{text: non-empty string, done: boolean}`이다. owner/reviewer는 프로젝트 member, stakeholder는 프로젝트 stakeholder여야 한다.

## 낙관적 revision

문서와 태스크 변경은 최근 GET에서 받은 SHA-256 revision을 `baseRevision`으로 보낸다. 누락 또는 불일치 시 `409`와 `{error,current}`를 반환하고 저장하지 않는다. contract 변경도 현재 numeric revision을 요구하며 불일치·누락은 409다. Client 상태와 lease는 entity revision 대신 상태 불변조건과 Workspace commit으로 직렬화한다.

## 문서 저장 원자성

서버는 document ID를 프로젝트 내부 실제 경로로 해석하고 표준 frontmatter가 있는지 확인한다. frontmatter는 변경하지 않고 body만 임시 파일로 쓴 뒤 rename한다. `checkWorkspace(... strict, skipProfilePolicy)`가 실패하면 원본 전체를 복구한다. 프로젝트 경로 밖의 파일, 512KB 초과 body, frontmatter 없는 파일은 거절한다.

## lease와 sync 규칙

lease endpoint는 active Client, 프로젝트 member인 owner, 존재하는 document를 요구한다. acquire는 기존 active lease가 없어야 하고 renew/release는 같은 Client가 보유해야 한다. acquire/renew TTL은 5분이다. sync는 remote를 `origin`, push를 `true`로 고정하고 Git 충돌은 성공 응답으로 가장하지 않는다.

## 오류 계약

| 상태 | 조건 | 응답·재시도 |
|---|---|---|
| `400` | task/document 입력 검증 실패 | `{error}`; 입력 수정 후 재시도 |
| `403` | token 누락·불일치 | `{error}`; 현재 세션 token 사용 |
| `404` | document 또는 route 없음 | `{error}`; ID 재조회 |
| `409` | 문서·태스크·contract stale revision | `{error,current}`; current 비교 후 재적용 |
| `500` | Client·lease 불변조건, strict check, Git sync, malformed/oversize JSON 등 내부 throw | `{error}`; 원인 해소 후 재시도 |

현재 구현에서 Client·lease domain validation과 request parser 오류는 별도 4xx statusCode를 부여하지 않아 500으로 표면화된다. Client는 응답을 문자열이 아니라 상태 코드와 `error` 필드로 처리해야 한다.

## 기능별 설계 계약

### BOP-02

#### 오퍼레이션과 경로

변경 기능은 `POST /api/clients`, `POST /api/clients/:clientId/enable`, `POST /api/clients/:clientId/disable`, `POST /api/projects/:key/tasks`, `POST /api/projects/:key/tasks/:taskId`, `POST /api/projects/:key/documents/:documentId`, `POST /api/projects/:key/contract/plan`, `POST /api/projects/:key/contract`, `POST /api/projects/:key/leases/:documentId/acquire`, `POST /api/projects/:key/leases/:documentId/renew`, `POST /api/projects/:key/leases/:documentId/release`, `POST /api/projects/:key/refresh`, `POST /api/projects/:key/sync`를 제공한다. 프로젝트 경로가 정본 동작을 지정하며 호환 경로는 서버 시작 시 선택한 프로젝트에 같은 동작을 적용한다.

#### 권한

모든 요청에 실행별 `X-Rundol-Token`이 필수다. 파일·Git 쓰기는 Board 프로세스 OS 계정 권한으로 수행한다. Client/lease는 추가로 member·Client 상태를 검증한다.

#### 요청

JSON은 64KB 이하이며 각 endpoint의 필수 필드를 포함한다. stale write 대상은 조회한 `baseRevision`을 반드시 전달한다. URL의 key, taskId, documentId가 대상 자원을 식별한다.

#### 응답

Client 등록과 task 생성은 201을 반환한다. Client 상태 변경, task 수정, document 수정, contract plan·수정, lease acquire·renew·release, refresh, sync는 200을 반환한다. 응답 본문은 실행한 오퍼레이션이 생성한 entity 또는 commit과 action을 반환한다.

#### 업무 규칙

검증 전 쓰기 금지, 문서 frontmatter 보존, task assignment의 charter 검증, lease의 active owner 규칙, 동일 이름 ref push를 적용한다. contract plan은 쓰지 않고 update만 revision을 증가시킨다.

#### 오류·취소·멱등성

Client 동일 상태 enable/disable, refresh, 변경 없는 sync는 멱등이다. task 생성과 lease acquire는 반복 시 새 결과를 보장하지 않으므로 성공 응답을 잃은 Client는 먼저 GET으로 상태를 확인한다. 연결 취소 후 임시 문서 파일은 정리되고 검증 실패는 원본을 복구한다.

#### 감사와 보안

세션 token은 파일에 저장하지 않고 응답 body에도 반환하지 않는다. 실제 변경은 프로젝트 또는 Workspace Git commit과 lease event에 남는다. credential과 token은 로그·문서에 기록하지 않는다.

#### 수용 기준

- token 없는 모든 POST가 변경 없이 403이다.
- stale 문서·태스크·contract 변경은 409와 current 상태를 반환한다.
- 문서 strict check 실패 시 원본 bytes가 복구된다.
- 유효 Client·lease·task 요청은 정본 branch에 commit 또는 event를 남긴다.
- 잘못된 담당자, 상태, 완료조건, 경로, 크기, lease 소유권은 변경 없이 거절된다.
