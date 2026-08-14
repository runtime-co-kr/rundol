---
id: MOD-002
type: document
kind: model
title: 작업공간 클라이언트 데이터 모델
description: COL-01 협업 Client manifest의 식별자, 소유자, 유형, 활성 상태, revision과 보존 규칙을 정의한다.
granularity: bounded-v1
implementationContract: atomic-v1
functionIds:
  - COL-01
scope: "COL-01 Client manifest의 생성·상태 변경·조회 데이터 계약"
excludes:
  - "문서 lease 이벤트와 프로젝트 task shard"
owner: "[[project#^MEMBER-001|프로젝트 책임자]]"
state: active
tags:
  - rundol/artifact
  - artifact/model
  - domain/rundol
  - feature/workspace-client
aliases:
  - MOD-002
related:
  - "[[REQ-019-협업-클라이언트-등록|REQ-019]]"
  - "[[TST-009-협업-클라이언트-등록-검증|TST-009]]"
  - "[[ARC-004-로컬-Board와-협업-아키텍처|ARC-004]]"
---

# 작업공간 클라이언트 데이터 모델

## 엔티티

| 엔티티 | 필드 | 타입 | 필수 | 기본값·제약 |
|---|---|---|---|---|
| Client manifest | `schemaVersion` | integer | 예 | 항상 `1` |
| Client manifest | `revision` | positive integer | 예 | 생성 시 `1`, 상태 변경마다 1 증가 |
| Client manifest | `id` | string | 예 | 소문자 kebab-case, `^[a-z0-9]+(?:-[a-z0-9]+)*$` |
| Client manifest | `name` | string | 예 | trim 후 비어 있지 않음 |
| Client manifest | `type` | enum | 예 | `device`, `agent`, `service` 중 하나 |
| Client manifest | `owner` | member ID | 예 | `^MEMBER-\d{3}$` |
| Client manifest | `status` | enum | 예 | 생성 시 `active`, 이후 `active` 또는 `disabled` |
| Client manifest | `registeredAt` | RFC 3339 UTC string | 예 | 생성 시각의 `toISOString()` |
| Client manifest | `registeredBy` | member ID | 예 | 생성 시 `owner`와 동일 |

정본 경로는 schemaVersion 6 Workspace worktree의 `clients/client-<id>.yaml`이다. 파일명에서 얻은 ID와 본문 `id`는 같아야 한다. list 결과는 파일명 오름차순이다.

## 관계

| 출발 | 관계 | 대상 | 카디널리티 | 삭제·수명주기 |
|---|---|---|---|---|
| Workspace | 등록 | Client manifest | 1:N | manifest를 자동 삭제하지 않음 |
| Client manifest | 소유 | `project.md` Member | N:1 | lease 사용 시 대상 프로젝트에 member가 존재해야 함 |
| Client manifest | 발생 | lease event | 1:N | Client disable 후 기존 이벤트는 보존 |

## 불변조건

- 동일 `id`의 manifest는 두 번 등록할 수 없다.
- `type`, `owner`, `name` 검증이 끝나기 전 파일을 만들지 않는다.
- 상태 변경은 기존 manifest의 `revision`과 `status`만 바꾸며 등록 메타데이터를 보존한다.
- 현재 상태와 같은 enable/disable 요청은 `changed: false`이고 revision과 commit을 만들지 않는다.
- disabled Client는 새 lease 이벤트를 만들 수 없다.

## 인덱스와 조회

| 조회 패턴 | 정렬·필터 | 접근 제약 |
|---|---|---|
| 전체 Client 조회 | `client-*.yaml` 파일명 오름차순 | schemaVersion 6 Workspace 필요 |
| Client 단건 조회 | `clients/client-<id>.yaml` | ID 정규식 통과 필요 |
| Board snapshot | 전체 목록을 SHA-256 영역 revision으로 계산 | 파생값이며 별도 저장하지 않음 |

## 보존과 개인정보

Client manifest에는 실행 주체 이름, 유형, member ID만 저장하고 credential·token·호스트 비밀은 저장하지 않는다. 명시적 삭제 API는 없으며 비활성화로 수명주기를 종료하고 Git 이력으로 변경을 감사한다.

## 마이그레이션

schemaVersion 6 미만 Workspace는 Client 저장을 거절하고 `rdl workspace migrate`를 요구한다. 필드 추가 시 기존 reader가 알 수 없는 YAML 필드를 무시하는 범위에서 optional로 추가하고, 불변조건 변경은 schemaVersion 증가와 migration을 동반한다.

## 기능별 설계 계약

### COL-01

#### 책임과 소유 데이터

Workspace에 협업 실행 주체를 유일한 Client로 등록하고 활성·비활성 상태를 관리한다. Client ID가 `agent-one`이면 소유 데이터는 `clients/client-agent-one.yaml` 한 파일이다.

#### 필드와 타입

입력은 `id:string`, `name:string`, `type:device|agent|service`, `owner:MEMBER-NNN`이다. 저장·출력 필드는 엔티티 표의 9개 필드와 변경 결과의 `file`, `commit`, `changed`다.

#### 키와 식별자

Client의 기본 키는 소문자 케밥 표기 `id`다. 정본 파일은 `clients/client-{id}.yaml` 규칙을 사용하며 파일명의 식별자와 본문의 `id`가 반드시 일치한다. `owner`와 `registeredBy`는 `MEMBER-NNN` 형식으로 프로젝트 charter의 member를 참조한다.

#### 생성과 생명주기

`registerClient`가 validation 후 atomic rename으로 revision 1, active manifest를 생성하고 Workspace commit을 만든다. `setClientStatus`는 active↔disabled 전이만 기록하며 삭제 전이는 없다.

#### 관계와 카디널리티

한 Client는 한 owner member를 참조하고 프로젝트별로 0개 이상의 lease 이벤트를 만들 수 있다. lease 시점마다 owner가 해당 프로젝트 charter의 member인지 재검증한다.

#### 상태와 전이

`미등록 -> active`, `active -> disabled`, `disabled -> active`를 허용한다. 같은 상태 요청은 멱등이며 미등록 Client 상태 변경은 오류다.

#### 불변식과 계산식

Client ID와 파일명은 항상 일치하고 type은 `device`, `agent`, `service` 중 정확히 하나이며 name은 trim 후 한 글자 이상이어야 한다. revision은 생성 시 1이고 실제 상태 변경마다 이전 revision에 1을 더한다. 보드의 Client 영역 revision은 정렬된 Client 응답을 JSON으로 직렬화한 bytes의 SHA-256 hex다.

#### 감사와 보존

등록 시각·등록 주체와 모든 상태 변경 commit을 보존한다. manifest에는 세션 token이나 Git credential을 기록하지 않는다.

#### 수용 기준

- 유효 입력은 revision 1 active manifest와 Workspace commit을 만든다.
- 중복 ID, 잘못된 type·owner, 빈 name은 파일을 만들지 않고 거절한다.
- 상태 변경은 revision을 1 증가시키고 동일 상태 요청은 변경하지 않는다.
- disabled Client의 lease 요청은 거절된다.
