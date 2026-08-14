# 문서 표준

## 설계 원칙

1. 하나의 사실은 하나의 문서에서만 정의하고 다른 문서는 실제 파일명으로 연결한다.
2. `project.md`는 사람과 의사결정 체계를, `PRD`는 제품 성과를, `REQ`는 검증할 동작을 정의한다.
3. 화면·데이터·인터페이스·아키텍처 문서는 해당 관점의 설계가 필요할 때만 만든다.
4. 구현 상세를 요구사항에 반복하거나 요구사항을 설계문서에 다시 복사하지 않는다.
5. 모든 정규 문서와 태스크는 요구사항부터 검증 증거까지 추적할 수 있어야 한다.

## 항상 필요한 프로젝트 계약

각 `projects/<project-key>/project.md`는 프로젝트마다 하나만 존재한다. 이 문서는 문서 코드가 있는 일반 산출물이 아니라 프로젝트의 고정 진입점이다.

- 미션, 목표와 성공 기준
- 포함·제외 범위와 변경 권한
- 역할, 멤버와 내부·외부 이해관계자
- 책임 매트릭스와 의사결정·에스컬레이션
- 위험, 협업 리듬과 완료 정의

구체적인 필수 구조는 [프로젝트 거버넌스 계약](PROJECT-GOVERNANCE.md)을 따른다. 소규모 프로젝트도 항목을 삭제하지 않으며, 미정인 정보는 확인 책임과 후속 태스크를 남긴다.

`documentProfile` schemaVersion 2는 profile, traits, policy, revision, history에 더해 `enforcement`, 유형별 AI 추천 문맥 `rules.after`, 비활성 유형별 `omissions`를 정본으로 저장한다. 추천 문맥은 AI가 참고하면 좋은 자료이며 누락되어도 문서 생성·저장·동기화를 막지 않는다. `omissions`는 흡수 대상과 필수 구성요소 또는 적용 제외 사유를 명시한다. 필수 구성요소는 해당 문서 템플릿의 섹션을 추천값으로 제공하되 프로젝트가 자유롭게 추가·삭제할 수 있다. 재설정은 기존 문서를 이동하거나 삭제하지 않고 revision/history만 전진시키며, `rdl contract show|next|check`와 Board는 같은 evaluator 결과를 표시한다.

## 문서 유형

문서는 필요한 근거가 있을 때 생성한다. 모든 프로젝트에 모든 유형을 강제하지 않는다.

| 코드 | 역할 | 생성 기준 | 담지 않는 내용 |
|---|---|---|---|
| `PRD` | 문제, 사용자, 제품 목표와 범위 | 제품 또는 서비스 성과를 합의해야 할 때 | 상세 동작과 구현 설계 |
| `REQ` | 기능·시스템 동작, 규칙, 수용 기준과 비기능 기준 | 구현하거나 검증할 요구가 있을 때 | 화면 배치, 스키마, 프로토콜 상세 |
| `ARC` | 시스템 경계, 컴포넌트, 배포와 품질 속성 | 여러 구성요소 또는 비기능 설계가 필요할 때 | 개별 기능의 수용 기준 |
| `SCR` | 사용자 흐름, 화면 상태, 바인딩과 접근성 | 사용자 화면이나 상호작용이 있을 때 | API·DB 내부 구현 |
| `MOD` | 엔티티, 관계, 불변식, 보존과 마이그레이션 | 영속 데이터 구조가 있거나 바뀔 때 | 화면 흐름과 API 표현 |
| `API` | HTTP·명령·이벤트 인터페이스 계약 | 구성요소 또는 외부 시스템 경계를 노출할 때 | 내부 업무 흐름 전체 |
| `ADR` | 중요한 선택과 대안, 근거와 결과 | 되돌리기 어렵거나 여러 문서에 영향을 주는 결정이 있을 때 | 일반 회의록과 구현 절차 |
| `TST` | 검증 범위, 시나리오, 환경과 통과 증거 | 여러 요구를 묶어 검증하거나 별도 품질 계획이 필요할 때 | 요구사항 원문의 반복 |
| `RUN` | 배포, 관측, 장애 대응과 복구 절차 | 운영되는 서비스나 정기 작업이 있을 때 | 개발 설계와 제품 목표 |
| `GLS` | 모호한 업무·기술 용어의 단일 정의 | 같은 용어를 여러 사람이 다르게 해석할 때 | 일반 사전이나 문서 색인 |

`SPC`는 `REQ`와 역할이 겹쳐 표준 유형에서 제외한다. 기능의 동작·규칙·상태 전이·오류·수용 기준은 `REQ`에 기록하고, 관점별 상세는 `SCR`, `MOD`, `API`, `ARC`로 분리한다.

`NTE`는 `inbox/`에서 개인 메모나 외부 자료를 임시 수집하는 비정규 노트다. 정규 산출물 목록과 추적성 검사에는 포함하지 않으며, 팀이 합의할 사실은 위 문서 유형으로 승격한다.

## 권장 추적 구조

```text
project.md
└─ PRD (제품 목표가 있는 경우)
   └─ REQ
      ├─ SCR (화면이 있는 경우)
      ├─ MOD (데이터 설계가 있는 경우)
      ├─ API (인터페이스가 있는 경우)
      ├─ ARC/ADR (구조적 결정이 있는 경우)
      └─ TST
         └─ RUN (운영 대상인 경우)
```

연결 방향은 문서의 계층보다 추적성을 우선한다. 설계문서는 최소 하나의 `REQ` 또는 관련 `ARC`를, 테스트 문서는 최소 하나의 `REQ`를 연결한다.

## 정규 문서 메타데이터

`projects/<project-key>/docs/**/*.md`의 모든 정규 문서는 아래 필드를 가진다.

```yaml
---
id: REQ-003
type: document
kind: requirement
title: OAuth 로그인
description: 사용자가 조직 계정으로 안전하게 로그인하고 실패 원인을 확인할 수 있어야 한다.
owner: "[[project#^MEMBER-001|문서 담당자]]"
state: active
tags:
  - rundol/artifact
  - artifact/requirement
  - domain/auth
  - feature/oauth-login
aliases:
  - REQ-003
related:
  - "[[PRD-001-인증-제품요구사항|PRD-001]]"
---
```

필수 필드는 `id`, `type`, `kind`, `title`, `description`, `owner`, `state`, `tags`, `aliases`, `related`다. `owner`와 `reviewers`는 `project.md`의 `MEMBER-*`, `stakeholders`는 `STAKEHOLDER-*` block을 연결한다.

## 파일명과 폴더

일반 산출물 ID는 `<3자리 코드>-<3자리 이상 번호>`, 파일명은 `<ID>-<한글 중심 기능명>.md` 형식이다. 예: `REQ-003-OAuth-로그인.md`.

새 문서는 유형별 정규 경로에만 만든다.

| 유형 | 정규 경로 |
|---|---|
| PRD | `docs/prd/` |
| REQ | `docs/requirements/` |
| ARC | `docs/architecture/` |
| SCR | `docs/screens/` |
| MOD | `docs/model/` |
| API | `docs/api/` |
| ADR | `docs/adr/` |
| TST | `docs/tests/` |
| RUN | `docs/runbooks/` |
| GLS | `docs/glossary/` |
| NTE | `inbox/` |

기존 `docs/` 루트와 과거 하위 폴더의 문서는 계속 읽을 수 있다. `rdl doc migrate`는 이동·링크 변경 계획만 출력하고, `rdl doc migrate --apply`가 프로젝트 단위 rollback을 보장하며 적용한다. 중복 ID는 자동 병합하지 않는다. 폴더별 `INDEX.md`는 기본으로 만들지 않고 검색, 태그와 Obsidian graph를 사용한다.

Obsidian link 대상에는 alias가 아니라 실제 물리 파일명을 사용한다. 프로젝트 사람과 역할은 `[[project#^MEMBER-001|이름]]`, `[[project#^ROLE-001|역할명]]`, `[[project#^STAKEHOLDER-001|이름]]`으로 연결한다.

등록 멤버와 관련 문서를 검증하면서 문서를 만들려면 CLI를 사용한다.

```bash
rdl doc create REQ "로그인 요구사항" --owner MEMBER-001 --scope "한 사용자의 로그인 처리" --exclude "회원가입과 비밀번호 재설정" --function-id AUTH-01 --related PRD-001 --project memo
rdl check --project memo --strict --implementation
```

CLI는 유형별 기본 메타와 태그를 채우지만, 생성 뒤에도 수용 기준과 실제 설계 내용을 작성해야 한다. `project.md`, 역할·멤버·이해관계자는 일반 문서 생성 명령으로 대체하지 않는다.

REQ·SCR·MOD·API·TST의 정본 단위는 기능 ID다. 같은 파일에 여러 기능을 배치할 수 있지만 기능 범위, 표의 한 행, 공통 설명 또는 공통 수용 기준으로 묶지 않는다. 각 기능은 단독 문서로 작성했을 때와 같은 유형별 필수 구성요소를 독립적으로 채운다. `rdl check --implementation`은 이 계약, 미확정 규칙, REQ와 TST의 기능별 연결을 검사한다.

추적성은 기능 ID와 직접 링크에서 계산한다. 별도 `INDEX.md`, 문서 목록, 카탈로그 또는 추적성 매트릭스를 정본으로 만들지 않는다. 필요할 때 `rdl contract trace --project <key> --json`으로 현재 계산 결과를 조회한다.

## 기존 SPC 문서 이전

기존 `SPC`를 기계적으로 `REQ`로 이름만 바꾸지 않는다.

1. 독립적인 기능·시스템 동작이면 새 `REQ`로 전환한다.
2. 기존 `REQ`와 같은 기능이면 규칙·상태 전이·오류만 기존 `REQ`에 병합한다.
3. 화면, 데이터, 인터페이스 또는 구조에만 해당하는 내용은 각각 `SCR`, `MOD`, `API`, `ARC/ADR`로 옮긴다.
4. 참조 문서와 태스크의 링크를 새 원본으로 변경한 뒤 기존 `SPC`를 삭제한다.
5. `rdl check --strict`로 남은 `SPC`와 끊어진 링크가 없는지 확인한다.
