# Rundol 0.24 마이그레이션

이 문서는 `0.23.x`에서 `0.24.0`으로 올릴 때 필요한 작업을 다룬다. **실행할 마이그레이션 명령은 없다.** 바뀌는 것은 `project.md`의 `documentProfile`이 저장하는 범위다.

## 변경 요약

| 항목 | 0.23.0까지 | 0.24.0 |
|---|---|---|
| `documentProfile.rules.<TYPE>.after` | 프로젝트가 저장 | **저장하지 않음** (내장 상수에서 계산) |
| `documentProfile.omissions.<TYPE>.absorbedBy`·`sections` | 프로젝트가 저장 | **저장하지 않음** (흡수 규칙 폐지) |
| `documentProfile.omissions.<TYPE>.notApplicable`·`reason` | 프로젝트가 저장 | **그대로 보존** |
| 유형별 하부 요소 | 흡수 설정 안에만 존재 | `board.json` 프리셋이 소유, 모든 유형에 적용 |
| 프로필 목록 | 내장 5종 고정 | 내장 5종 + `board.json`이 정의한 팀 프리셋 |
| 진단 `RDL-PROFILE-006`·`007`·`010`·`011` | 있음 | **제거** |

`policy`, `enforcement`, `revision`, `history`, `traits`는 그대로다. 문서와 태스크 파일은 전혀 바뀌지 않는다.

## 왜 바뀌었나

`rules.after`는 유형마다 아홉 개씩 아흔 개의 설정이었는데 소비처가 한 곳뿐이었다. 아무것도 차단하지 않고, 아직 만들지 않은 유형에만 나타나며, 기본값 그대로 쓰였다. "REQ는 PRD 다음"이라는 지식은 프로젝트마다 다르지 않으므로 상수로 옮겼다. `rdl contract next` 출력은 이전과 같다.

흡수는 보증이 없었다. 제목 문자열의 존재만 확인했기 때문에 내용 없는 제목 여섯 줄로도 충족으로 판정됐고, 반대로 제목 없이 충실히 서술한 문서는 미충족이었다. 나중에 그 유형을 활성화해도 흡수해 둔 내용을 옮기라고 알려주는 경로가 없어 양쪽에 같은 주제가 남았다. 유형마다 설정을 유지하고 진단 넷을 관리할 값이 아니었다.

대신 하부 요소를 **실제로 만드는 유형**에 붙였다. 기본값은 템플릿 추측이 아니라 실제 프로젝트 문서 257건에서 뽑았다.

## 1. 업그레이드

```powershell
npm install -g rundol@0.24.0
rdl --version
```

## 2. 확인

```powershell
rdl contract show --project <key> --json
rdl check --strict --project <key>
```

`0.23.0`에서 유효했던 계약은 그대로 유효하다. 예전 `rules`·`omissions` 블록이 남아 있어도 읽기는 통과한다.

## 3. 정리 시점

다음번 `rdl contract set` 또는 Board의 계약 저장에서 `documentProfile` 블록 전체가 다시 렌더되며 `rules`와 흡수 규칙이 사라진다. 별도 명령은 필요 없다.

`notApplicable`과 그 사유는 이때도 남는다. 기계가 만든 기본값이 아니라 사람이 기록한 판단이기 때문이다.

## 4. 팀 프리셋 (선택)

프로필을 팀에 맞게 정의하려면 `projects/workspace/board.json`에 추가한다.

```json
{
  "schemaVersion": 1,
  "profiles": {
    "our-team": {
      "label": "우리 팀",
      "description": "요구사항과 검증만 필수로 두는 팀 표준",
      "policy": { "required": ["REQ", "TST"], "recommended": ["ARC"] },
      "sections": { "REQ": ["배경", "요구사항", "수용 기준", "우리 팀 보안 검토"] }
    }
  }
}
```

- 프로필 이름은 저장값이므로 영문 소문자·숫자·하이픈만 쓴다.
- 내장에 없는 이름은 `policy`가 필수다. 없으면 조용히 기본 프로파일로 되돌아가 만든 적 없는 계약이 저장된다.
- `sections`를 지정하지 않은 유형은 내장 기본값을 그대로 쓴다.
- 프로젝트 단위로 덮으려면 `projects/<key>/board.json`에 같은 형태로 넣는다.

```powershell
rdl contract set --profile our-team --project <key>
```

## 호환성

`0.24.0`이 저장한 `project.md`를 `0.23.0`으로 열면 `rules.<TYPE>.after가 없습니다`로 invalid가 된다. 같은 Workspace를 여러 버전으로 다룬다면 함께 올린다.

## 문제 해결

### `지원하지 않는 문서 프로필입니다: <이름>`

`board.json`에 그 프리셋이 없거나 `policy`가 빠졌다. 4번 형식을 확인한다.

### 계약이 `invalid`로 나온다

`rdl contract check --project <key>`로 사유를 확인한다. `rules`·`omissions` 잔존은 원인이 아니다. 읽기에서 요구하지 않는다.
