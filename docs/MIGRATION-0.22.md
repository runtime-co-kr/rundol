# Rundol 0.22 마이그레이션

이 문서는 Rundol `0.21.1`부터 `0.22.1`까지의 Workspace를 최신 `0.22.2`로 업그레이드하는 절차다. 중간 버전을 순서대로 설치할 필요는 없다. 출발 버전에 따라 문서 경로, `documentProfile`과 기능별 구현 계약 전환 단계만 달라진다.

## 변경 요약

| 출발 버전 | 기존 상태 | 0.22.2에서 필요한 작업 |
|---|---|---|
| 0.21.1 | 문서 프로필 없음, PRD·GLS·ARC가 `docs/` 루트에 생성될 수 있음 | 연결 재발견, legacy 문서 경로 이전, schemaVersion 2 계약 설정 |
| 0.21.2 | schemaVersion 1 프로필, canonical 문서 경로와 bootstrap 지원 | v1 정책·traits를 보존해 schemaVersion 2로 전환 |
| 0.21.3 | 데이터 계약은 0.21.2와 같고 Unix 전역 설치 경로만 보완 | schemaVersion 2로 전환 |
| 0.22.0 | schemaVersion 2 계약 사용 | 데이터 migration 없음, 스킬 재설치와 선택적 `board.json` 설정 |
| 0.22.1 | schemaVersion 2 계약과 Board 표시 설정 사용 | 스킬 재설치, 구현 문서 `atomic-v1` 전환과 계산형 추적성 검사 |

0.22.0의 schemaVersion 2 계약은 기존 policy에 다음 항목을 추가한다.

- `enforcement`: `advisory` 또는 `checkpoint`
- `rules.<TYPE>.after`: AI 작성 품질을 돕는 비차단 추천 문맥
- `omissions.<TYPE>`: 비활성 문서의 흡수 대상과 필수 구성요소 또는 적용 제외 사유
- revision 기반 CLI·Board 계약 변경

`checkpoint`에서는 필수 문서 또는 생략 계약 위반이 `rdl save`와 `rdl sync`를 차단한다. 추천 문맥의 누락은 차단 조건이 아니다. 따라서 기존 프로젝트는 먼저 `advisory`로 전환한 뒤 차단 계약 위반을 해소하고 `checkpoint`를 적용한다.

## 1. 업그레이드 전 백업

제품 브랜치와 Rundol 프로젝트 브랜치의 변경을 먼저 확인한다.

```powershell
rdl --version
git status --short
git branch --list "rundol/*"
rdl check --strict --project <key> --json
rdl save --project <key> --json
```

각 프로젝트 브랜치와 Workspace 브랜치에 복구용 ref를 만든다. `<date>`는 `20260814` 같은 고정 날짜 문자열로 바꾼다.

```powershell
git branch backup/rundol-workspace-<date> rundol/workspace
git branch backup/rundol-<key>-<date> rundol/<key>
```

원격이 협업 정본이면 기존 Rundol 브랜치도 동기화한다.

```powershell
rdl sync --project <key> --json
```

동기화가 실패하면 업그레이드를 진행하지 말고 충돌 또는 원격 인증 문제를 먼저 해결한다.

## 2. CLI와 스킬 업그레이드

```powershell
npm install --global rundol@0.22.2
rdl --version
rdl doctor --json
rdl skill install --force
```

`rdl --version`이 `0.22.2`인지 확인한다. 스킬은 npm 설치와 분리돼 있으므로, 이전 스킬이 설치돼 있으면 `--force`로 atomic-v1, 무인덱스 추적성과 canonical design routing 절차를 반영한다.

## 3. Workspace 재발견

```powershell
rdl init --project <key> --json
```

정상적인 기존 프로젝트는 `already-connected`, 누락된 worktree를 복구하면 `repaired`, 원격에서 새로 연결하면 `attached`를 반환한다. `needs-selection`이면 프로젝트를 명시해 다시 실행한다. `conflict`에서는 파일이나 ref를 자동 변경하지 말고 진단 내용을 먼저 해결한다.

## 4. 출발 버전별 전환

### 0.21.1에서 업그레이드

0.21.1은 PRD, GLS, ARC 문서를 `docs/` 루트에 둘 수 있다. 먼저 dry-run으로 이동 계획을 확인한다.

```powershell
rdl doc migrate --project <key> --json
rdl check --structure --project <key> --json
```

중복 ID, 파일명 불일치, 예상하지 않은 파일이 없을 때만 적용한다.

```powershell
rdl doc migrate --project <key> --apply --json
```

이후 프로젝트 규모에 맞는 프로필을 advisory로 설정한다.

```powershell
rdl contract plan --project <key> --profile <lean|product|service|platform|assured> --enforcement advisory --json
rdl contract set --project <key> --profile <lean|product|service|platform|assured> --enforcement advisory --json
```

### 0.21.2 또는 0.21.3에서 업그레이드

먼저 현재 v1 프로필을 확인한다.

```powershell
rdl contract show --project <key> --json
```

`status`가 `migration-required`이면 출력된 기존 profile 이름을 그대로 사용해 전환 계획을 확인한다. 이 작업은 기존 policy, traits와 문서를 보존하고 schemaVersion과 revision만 전진시킨다.

```powershell
rdl contract plan --project <key> --profile <현재-profile> --enforcement advisory --json
rdl contract set --project <key> --profile <현재-profile> --enforcement advisory --json
```

이미 `status: valid`와 `schemaVersion: 2`가 표시되면 이 단계는 생략한다.

### 0.22.0 또는 0.22.1에서 업그레이드

문서 계약이나 태스크 저장 포맷 migration은 필요하지 않다. 업데이트된 스킬을 설치하고 기존 프로젝트를 검사한다.

```powershell
rdl skill install --force
rdl contract check --project <key> --json
rdl check --strict --project <key> --json
rdl check --structure --project <key> --json
```

`DESIGN.md`가 발견되면 파일을 자동 삭제하지 않는다. 내용을 검토해 제품·품질 요구는 REQ, 사용자 흐름과 화면 상태는 SCR, 시스템 구조는 ARC, 중요한 결정은 ADR, 구현은 연결 태스크로 이전한다. 해당 문서 유형이 disabled이면 `documentProfile.omissions`의 흡수 대상과 필수 구성요소를 따른다.

문서 표시 문구를 조정하려면 다음 선택 설정 파일을 사용할 수 있다.

- Workspace 공통값: `projects/workspace/board.json`
- 프로젝트 override: `projects/<key>/board.json`

설정 파일이 없으면 내장 기본값이 사용된다. 표시 설정은 label, description, order만 바꾸며 문서 ID, kind, 저장 경로와 계약 의미를 변경하지 않는다.

### 구현 문서 atomic-v1 전환

0.22.2부터 새 REQ, SCR, MOD, API, TST는 하나 이상의 `--function-id`가 필요하다. 기존 문서는 일반 strict에서 경고로 유지되므로 먼저 기능 경계를 검토한 뒤 frontmatter에 계약을 추가한다.

```yaml
granularity: bounded-v1
scope: 이 문서가 책임지는 단일 검토 범위
excludes:
  - 인접하지만 책임지지 않는 범위
implementationContract: atomic-v1
functionIds:
  - PAY-01
  - PAY-02
```

한 파일에 여러 기능을 둘 수는 있지만 명세를 묶지 않는다. `PAY-01~02` 같은 범위, 두 기능을 한 표 행에 넣는 방식, 공통 placeholder·수용 기준·테스트 하나로 여러 기능을 대신하는 방식은 허용하지 않는다. 모든 기능 ID는 문서 유형별 필수 필드를 단독 문서와 같은 수준으로 가진다.

```powershell
rdl check --strict --implementation --project <key> --json
rdl contract trace --project <key> --json
```

trace 결과의 모든 기능이 `ready: true`이고 `persistedIndex: false`인지 확인한다. 별도 INDEX, 문서 목록, 카탈로그나 추적성 매트릭스를 만들지 않는다. 기존 완료 태스크는 그대로 보존하며, 업데이트 후 새로 생성한 REQ·TST 연결 태스크부터 `implementationReadiness: atomic-v1` 완료 게이트가 적용된다.

## 5. 계약 충족

현재 작성 가능한 문서와 차단된 문서를 확인한다.

```powershell
rdl contract next --project <key> --json
rdl contract check --project <key> --json
```

- `ready`의 required 문서를 우선 작성한다.
- 각 `ready` 항목의 `recommendedContext`와 `missingRecommendedContext`를 참고하되, 누락된 추천 문맥 때문에 작성을 멈추지 않는다.
- disabled 문서는 새 파일을 만들지 않는다.
- `absorbed` 항목은 지정된 대상 문서에 계약이 선택한 모든 필수 구성요소를 작성한다.
- `recommended-missing`은 권고이며 checkpoint에서도 저장을 차단하지 않는다.

Board를 사용하는 경우 Settings의 **문서 계획 계약**에서 profile, enforcement, policy 상태, 읽기 전용 AI 추천 문맥, 흡수 대상과 필수 구성요소를 확인할 수 있다. 구성요소는 실제 문서 템플릿의 섹션 추천값을 추가하거나 프로젝트 고유 항목을 자유롭게 입력하고 삭제할 수 있다.

```powershell
rdl board --project <key>
```

## 6. checkpoint 적용과 동기화

advisory 상태에서 오류를 모두 해결한 후 같은 프로필을 checkpoint로 변경한다.

```powershell
rdl contract plan --project <key> --profile <현재-profile> --enforcement checkpoint --json
rdl contract set --project <key> --profile <현재-profile> --enforcement checkpoint --json
rdl contract check --project <key> --json
rdl check --strict --implementation --project <key> --json
rdl contract trace --project <key> --json
rdl check --structure --project <key> --json
rdl save --project <key> --json
rdl sync --project <key> --json
```

완료 조건은 다음과 같다.

- contract status가 `valid`
- contract violations가 0건
- strict 오류가 0건
- implementation 오류가 0건이고 계산된 모든 기능이 ready
- structure migration 후보가 0건
- 프로젝트 브랜치가 원격에 push됨

## 자동화와 CI

비대화형 환경에서는 `--guided`를 사용하지 않는다. 프로젝트를 명시하고 JSON 결과의 status와 violations를 검사한다.

```powershell
rdl init --project <key> --json
rdl contract check --project <key> --json
rdl check --strict --project <key> --json
```

AI 클라이언트는 업데이트된 Rundol 스킬을 설치한 후 `contract show → next → task add → 기능별 create 또는 absorb → contract check → check --strict --implementation → acceptance → save → sync` 순서를 따른다.

## 롤백

0.21.x CLI는 schemaVersion 2 계약을 완전히 이해하지 못한다. 단순히 npm package만 낮추지 말고, 업그레이드 전에 만든 프로젝트·Workspace backup ref도 함께 복원해야 한다.

먼저 현재 상태를 별도 ref로 보존하고 대상 worktree가 깨끗한지 확인한다.

```powershell
git status --short
git branch backup/rundol-after-failed-migration rundol/<key>
```

그다음 backup ref를 원래 Rundol ref로 복원하고 worktree를 갱신한다. 이 작업은 업그레이드 후 변경을 덮어쓰므로 팀과 합의하고 실행한다.

```powershell
git update-ref refs/heads/rundol/<key> refs/heads/backup/rundol-<key>-<date>
git update-ref refs/heads/rundol/workspace refs/heads/backup/rundol-workspace-<date>
npm install --global rundol@0.21.3
rdl attach <key> --json
rdl check --strict --project <key> --json
```

원격 브랜치까지 되돌려야 한다면 강제 push를 바로 사용하지 말고 별도 복구 브랜치로 push해 검토한 뒤 반영한다.

## 문제 해결

### save 또는 sync가 필수 문서 누락으로 실패함

계약을 advisory로 낮춘 뒤 `rdl contract next`의 required 문서와 omission 필수 구성요소를 채운다.

```powershell
rdl contract set --project <key> --profile <현재-profile> --enforcement advisory --json
rdl contract next --project <key> --json
```

### Board에서 계약 설정이 보이지 않음

전역 CLI 버전과 Board를 실행한 프로세스의 버전을 확인한다. 소스 저장소에서 시험할 때는 `node bin/rdl.js board --project <key>`를 사용하고, 다른 컴퓨터에서는 `rundol@0.22.2` 설치가 필요하다.

### contract status가 legacy-unconfigured임

0.21.1 프로젝트 또는 프로필을 설정하지 않은 프로젝트다. `contract plan` 결과를 검토한 뒤 advisory로 `contract set`을 실행한다.

### contract status가 unsupported-schema 또는 invalid임

자동 저장·동기화를 중단한다. `project.md`의 `documentProfile`을 backup ref와 비교하고, 누락 policy, 지원하지 않는 추천 문맥 유형, 잘못된 omission 대상을 수정한 후 다시 검사한다.
