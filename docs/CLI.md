# RDL CLI 기능 명세

Rundol CLI의 기본 명령은 `rdl`이며 `rundol`은 같은 실행 파일의 별칭이다. 외부 runtime dependency 없이 Node.js 20 이상과 Git에서 동작한다.

## 명령 요약

아래 블록은 `rdl --help`의 Usage와 항상 일치해야 한다.

<!-- rdl-help:start -->
```text
  rdl init [project-key] [--name <project-name>] [--project <key>] [--remote <name>] [--new] [--guided]
           [--profile <name>] [--defaults] [--questions] [--primary-branch <name>] [--trait <name>] [--root <path>] [--json]
  rdl attach [project-key] [--remote <name>] [--root <path>] [--json]
  rdl detach <project-key> [--remote <name>] [--root <path>] [--json]
  rdl project add <project-key> --name <project-name> [--profile <name>] [--root <path>] [--json]
  rdl project profile --project <key> --profile <lean|product|service|platform|assured> [--trait <name>] [--required <TYPE,...>] [--recommended <TYPE,...>] [--on-demand <TYPE,...>] [--disabled <TYPE,...>] [--json]
  rdl contract show|next|check|trace --project <key> [--json]
  rdl contract diagram --project <key> [--write] [--json]
  rdl contract plan|set --project <key> --profile <name> [--enforcement <advisory|checkpoint>] [--task-enforcement <advisory|checkpoint>] [--json]
  rdl check [ARTIFACT-ID] [--root <path>] [--project <key>] [--json] [--strict] [--implementation]
  rdl check --links [--root <path>]
  rdl check --tasks [--root <path>]
  rdl git init|boundary [--root <path>] [--project <key>] [--json]
  rdl refresh [--root <path>] [--project <key>] [--json]
  rdl save [--root <path>] [--project <key>] [--task <TASK-ID> | --no-task <reason>] [--run <RUN-ID>] [--expect-head <sha>] [--json]
  rdl obsidian init [--root <path>] [--project <key>] [--force] [--json]
  rdl check --structure [--root <path>] [--project <key>] [--json]
  rdl cleanup [--root <path>] [--project <key>] [--apply] [--json]
  rdl skill install [--force] [--json]
  rdl settings migrate [--root <path>] [--json]
  rdl workspace show|check|sync|migrate [--root <path>] [--json]
  rdl member add <이름> --role <ROLE-ID> --organization <소속> --account <업무 계정> --responsibility <책임 영역> [--member <MEMBER-ID>] [--project <key>] [--json]
  rdl member set <MEMBER-ID|STAKEHOLDER-ID> [--name <이름>] [--role <ROLE-ID>] [--organization <소속>] [--account <계정>] [--responsibility <책임>] [--status <상태>] [--project <key>] [--json]
  rdl member list [--project <key>] [--json]
  rdl watch --project <key> [--remote] [--once] [--json]
  rdl task add <제목> --acceptance <완료조건> [--summary <설명>] [--owner <MEMBER-ID>]
                   [--reviewer <MEMBER-ID>] [--stakeholder <STAKEHOLDER-ID>]
                   [--priority <high|mid|low>] [--kind <normal|test>] [--round <n>] [--link <ARTIFACT-ID>] [--json]
  rdl task set <TASK-ID> [--project <key>] [--status <state>] [--owner <MEMBER-ID|null>]
                 [--result <pass|fail|blocked|skipped|none>]
                 [--link <ARTIFACT-ID>] [--unlink <ARTIFACT-ID>]
                 [--external-ref <branch|pr|issue>=<값>] [--json]
                 반려는 --status cancelled --reason <사유> [--decided-by <MEMBER-ID>]
  rdl task list [--project <key>] [--kind <normal|test>] [--round <n>] [--status <state>] [--open] [--json]
  rdl test rounds [--round <n>] [--project <key>] [--json]
  rdl task acceptance <TASK-ID> <AC-ID> (--done|--undone) [--project <key>] [--json]
  rdl task commits [TASK-ID] [--project <key>] [--branch <name>] [--max-items <n>] [--json]
  rdl task identity [--project <key>] [--apply] [--json]
  rdl task migrate [--project <key>] [--client-id <id>] [--max-items <n>] [--json]
  rdl context [--root <path>] [--project <key>] [--json]
  rdl help [--json]
  rdl doc create <TYPE> <제목> --owner <MEMBER-ID> --scope <단일-책임> --exclude <제외-범위>
                 [--function-id <기능-ID>] [--grouped --reason <합침-사유>] [--exclude <제외-범위>] [--related <ARTIFACT-ID>] [--project <key>] [--json]
  rdl doc migrate [--project <key>] [--apply] [--json]
  rdl doc identity [--project <key>] [--apply] [--json]
  rdl doc status [--project <key>] [--status <approved|stale|unapproved>] [--json]
  rdl doc approve <ARTIFACT-ID> --member <MEMBER-ID> --basis <read|verdict|check|delegated>[=<상세>]
                  --client-id <id> [--reason <사유>] [--project <key>] [--json]
  rdl doc history <ARTIFACT-ID> [--project <key>] [--json]
  rdl doc analyze [--project <key>] [--orphans] [--unexplained] [--json]
  rdl doc diff <ARTIFACT-ID> --since-approval [--project <key>] [--json]
  rdl sync --client-id <id> [--root <path>] [--project <key>] [--remote <name>] [--no-push] [--share-unverified <사유> --approved-by <human-client-id>] [--request-id <REQ-ID>] [--json]
  rdl sync watch --client-id <id> [--interval <seconds>] [--project <key>] [--no-push] [--once] [--request-id <REQ-ID>] [--json]
  rdl conflict list [--project <key>] [--json]
  rdl conflict resolve --strategy <ours|theirs> [--project <key>] [--json]
  rdl conflict clear [--project <key>] [--json]
  rdl doctor [--git-url <url>] [--json]
  rdl board [--root <path>] [--project <key>] [--port <number>] [--no-open] [--json]
  rdl --version
  rdl --help

  rdl advanced [--json]   실행 원장, 어댑터, 검증, 결정, 위임 등 내부 명령을 나열합니다
```
<!-- rdl-help:end -->


## 고급 명령

아래는 `rdl advanced`가 나열하는 내부 표면이다. 실행 원장, 어댑터 호출, 검증, 결정과 위임은 절차와 에이전트가 쓰는 명령이며 사람이 매일 칠 일이 없다. 사람 표면에서 내린 것은 은닉이지 삭제가 아니므로 기존 자동화와 스크립트는 그대로 동작한다.

은닉과 삭제는 다르다. `rdl lease`는 여기에도 없다 — 내린 것이 아니라 0.36에서 폐기했기 때문이며, 호출하면 근거를 가리키는 오류로 끝난다.

이 블록도 `rdl advanced`의 Usage와 항상 일치해야 한다.

<!-- rdl-advanced:start -->
```text
  rdl client register <client-id> --name <name> --type <device|agent|service|human> --owner <MEMBER-ID> [--json]
  rdl client list|show <client-id>|enable <client-id>|disable <client-id> [--json]
  rdl run start <절차이름> --project <key> --client-id <id> [--artifact-id <ARTIFACT-ID>] [--task <TASK-ID>] [--goal <목표>]
                [--request-id <REQ-ID>] [--json]
  rdl run next --run <RUN-ID> --project <key> [--json]
  rdl run step --run <RUN-ID> --project <key> --client-id <id> [--step <id>] [--exit <n>] [--artifact-id <ID>] [--commit <sha>] [--force --reason <사유>] [--request-id <REQ-ID>] [--json]
  rdl run gate --run <RUN-ID> --project <key> --client-id <id> [--step <id>] [--force --reason <사유>] [--request-id <REQ-ID>] [--json]
  rdl run approve --run <RUN-ID> --project <key> --client-id <id> --reason <사유> [--step <id>] [--request-id <REQ-ID>] [--json]
  rdl run halt|complete --run <RUN-ID> --project <key> --client-id <id> [--request-id <REQ-ID>] [--json]
  rdl run resume --run <RUN-ID> --project <key> --client-id <id> [--grant-attempts <step[,step]> --reason <사유>] [--json]
  rdl run takeover --run <RUN-ID> --project <key> --client-id <id> [--force --reason <사유>] [--request-id <REQ-ID>] [--json]
  rdl run ownership resolve --run <RUN-ID> --project <key> --conflict <digest> --select <event-id> --client-id <id> --reason <사유> [--force] [--request-id <REQ-ID>] [--json]
  rdl run drive --run <RUN-ID> --project <key> --client-id <id> [--scheduled] [--request-id <REQ-ID>] [--json]
  rdl run operation resolve --run <RUN-ID> --project <key> --operation <operation-id> --conflict <digest> --select <event-id> --client-id <id> --reason <text> [--force] [--request-id <REQ-ID>] [--json]
  rdl run requests [--pending] [--json]
  rdl run request resume <REQ-ID> --client-id <id> [--json]
  rdl run list --project <key> [--json]
  rdl run log --run <RUN-ID> --project <key> [--json]
  rdl run procedures [--project <key>] [--json]
  rdl adapter run <name> --project <key> --run <RUN-ID> --step <id> --mode <author|verify> --client-id <id> [--json]
  rdl verify <ARTIFACT-ID> --project <key> --client-id <id> [--adapter <name>] [--adapters <name>]... [--lens <registry-id>]... [--run <RUN-ID>] [--request-id <REQ-ID>] [--json]
  rdl workset list [--project <key>] [--branch <name>] [--json]
  rdl decision list [--project <key>] [--open] [--json]
  rdl decision request --kind <종류> --subject <대상> --question <질문> --option <id=설명>
                       [--supersedes <EVENT-ID>]
                       --recommend <id> --because <근거> --blast <영향 범위> [--irreversible]
                       [--evidence <근거>] --client-id <id> [--project <key>] [--json]
  rdl decision answer <DEC-ID> --select <option-id> --member <MEMBER-ID> --reason <사유>
                      --client-id <id> [--supersedes <EVENT-ID>] [--delegation <DLG-ID>]
                      [--project <key>] [--json]
  rdl decision kinds [--json]
  rdl delegation list [--project <key>] [--active] [--json]
  rdl delegation grant --kind <종류> --delegate <client-id> --member <MEMBER-ID> --reason <사유>
                       [--days <n>] --client-id <id> [--project <key>] [--json]
  rdl delegation revoke <DLG-ID> --member <MEMBER-ID> --reason <사유> --client-id <id>
                        [--project <key>] [--json]
  rdl action resolve <ACTION> [--json]
  rdl action record <ACTION> --actual-executor <cli|llm|hybrid> [--planned-executor <executor>]
                    [--artifact-id <ID>] [--task-id <ID>] [--fallback-reason <reason>] [--json]
  rdl debug record --input-tokens <n> --output-tokens <n> [--model <name>] [--provider <name>] [--unreported] [--json]
  rdl debug summary [--json]

```
<!-- rdl-advanced:end -->

## 공통 탐색과 프로젝트 선택

- `--root`를 생략하면 현재 위치부터 부모 방향으로 Git 저장소 루트와 `projects/workspace/workspace.yaml`을 찾는다.
- Workspace 루트와 Git 저장소 루트는 같아야 한다.
- schemaVersion 6 프로젝트는 `rundol/workspace`의 `projects/project-<key>.yaml`에 등록된다.
- 각 프로젝트는 `rundol/<key>` 브랜치를 `projects/<key>/`에 linked worktree로 연결한다.
- `check`, `git init`, `refresh`, `save`, `sync`는 `--project`를 생략하면 등록 프로젝트 전체를 각각 처리한다.
- `task add`, `task set`, `task acceptance`, `board`는 프로젝트가 하나면 자동 선택하고 여러 개면 `--project <key>`가 필요하다.
- `--json`은 자동화와 AI 클라이언트가 사용할 안정된 JSON 결과를 출력한다.
- 사람이 읽는 출력은 `키: 값`과 목록을 찍고 중첩 객체는 생략한다. 목록은 건수와 항목별 요약을 함께 보여주므로 `member list`와 `client list`는 `--json` 없이도 내용을 확인할 수 있다.

`rundol/*`는 하나의 Git 브랜치나 wildcard 작업 단위가 아니다. CLI의 전체 처리 기준은 Workspace의 프로젝트 Registry이며 각 프로젝트 브랜치를 독립적으로 처리한다.

## 기능 목록

| 명령 | 핵심 기능 | 로컬 변경 | 네트워크 |
|---|---|---|---|
| `rdl init` | Workspace와 첫 프로젝트 등록·브랜치·worktree 생성 | `rundol/workspace`, 프로젝트 브랜치 | 로컬 ref가 없고 `origin`이 있으면 fetch |
| `rdl attach` | 원격 Workspace·프로젝트 브랜치를 연결 | `projects/*` linked worktree | fetch |
| `rdl detach` | 선택 프로젝트 linked worktree 연결 해제 | linked worktree | 없음 |
| `rdl project add` | 기존 Workspace에 독립 프로젝트 추가 | settings·프로젝트 브랜치 | 대응 로컬 ref가 없고 `origin`이 있으면 fetch |
| `rdl check` | 문서·메타·링크·거버넌스·태스크·Obsidian 설정 검사 | 없음 | 없음 |
| `rdl git init` | 등록 프로젝트 브랜치 복구 또는 생성, worktree 연결, push 경계 설치 | ref·worktree·`.git/hooks/pre-push` | 로컬 ref가 없고 `origin`이 있으면 fetch |
| `rdl git boundary` | 코드·Workspace·프로젝트 branch/worktree 및 pre-push 경계 진단 | 없음 | 없음 |
| `rdl refresh` | worktree와 태스크 합본을 materialize하고 엄격 검증 | 프로젝트 `.rundol/state` 갱신, 커밋 없음 | 없음 |
| `rdl save` | 직접 편집한 프로젝트 자료 검증·커밋 | 선택 프로젝트 브랜치 커밋 | 없음 |
| `rdl obsidian init` | 팀 공통 Obsidian 설정을 개인 Vault 설정으로 복사 | `.obsidian/*.json` | 없음 |
| `rdl skill install` | 거버넌스 스킬을 AI 클라이언트 개인 skills 폴더에 설치 | 클라이언트 `skills/` 디렉터리 | 없음 |
| `rdl settings migrate` | 기존 schemaVersion 3 등록·Obsidian 설정을 settings 브랜치로 이전 | 기존 Workspace와 settings 브랜치 | 없음 |
| `rdl task add` | 완료조건이 있는 태스크 생성 | 태스크 샤드, operation 기록, 프로젝트 브랜치 커밋 | 없음 |
| `rdl task set` | 태스크 상태·담당자·문서 링크 변경, 사유를 남기는 반려 | 태스크 원본, operation 기록, 프로젝트 브랜치 커밋 | 없음 |
| `rdl task acceptance` | 완료조건의 완료·미완료 상태 변경 | 태스크 원본, operation 기록, 프로젝트 브랜치 커밋 | 없음 |
| `rdl task identity` | 옛 26자 태스크 식별자를 8자로 이관하고 옛 식별자를 태스크에 보존 | 태스크 샤드와 태스크를 가리키는 문서 | 없음 |
| `rdl task migrate` | 단일 `tasks.json`을 클라이언트 샤드로 전환 | settings와 프로젝트 브랜치 커밋 | 없음 |
| `rdl doc create` | 등록 멤버와 실제 관련 문서로 표준 문서 생성 | 프로젝트 브랜치 작업 트리 | 없음 |
| `rdl sync` | save, fetch, fast-forward/3-way 병합, 검증, push | 프로젝트 브랜치 커밋·병합 | fetch, 기본 push |
| `rdl sync watch` | 지정 주기로 Sync 반복 | `rdl sync`와 같음 | fetch, 기본 push |
| `rdl watch` | 프로젝트 진단을 안정된 스냅샷 단위로 관찰 | 무시되는 로컬 캐시와 프로세스 락만 변경 | 기본 없음; `--remote`일 때 tip 관계 확인용 fetch만 수행 |
| `rdl run drive` | 고정된 멱등 절차를 명시적 중단 경계까지 실행 | run·driver 이벤트와 로컬 런타임 상태 | lease 유지에 필요한 제한된 sync; human/sync gate에서 자동 중단 |
| `rdl run operation resolve` | 충돌한 operation outcome 중 기록된 후보 하나를 명시적으로 선택 | `run.operation_resolved` 이벤트 | 없음 |

`rdl watch`는 진단 관찰 명령이며 저장·병합·push를 반복하는 `rdl sync watch`와 별개입니다. `rdl watch --remote`의 `--remote`는 원격 이름을 받지 않는 boolean 플래그이고, 프로젝트·Workspace tip 관계만 관찰합니다. 스캔·원격 관찰 주기는 `harness.json`의 runtime settings를 사용합니다. `--once`에서도 문서 진단의 존재는 종료 상태를 바꾸지 않지만, 설정·락 오류 또는 안정된 스캔을 만들지 못한 경우에는 종료 코드 2를 반환합니다.

`rdl run drive`는 `idempotent:true`로 pin된 절차만 실행합니다. 모든 실행 스텝은 `operation-id` 또는 `gate-recheck` 재시도 계약을 가져야 하고, 모든 gate는 닫힌 read-only `check` 인자 계약을 통과해야 합니다. 이 preflight가 실패하거나 client·ownership·scheduler 조건이 맞지 않으면 journal, lock, lease, event, child process를 만들기 전에 종료 코드 2로 거부합니다. `--scheduled`는 daemon을 시작하지 않으며 runtime settings의 scheduler client 일치 여부만 추가로 검사합니다. 사람 승인 또는 sync gate 앞에서는 성공 상태 `waiting_human`으로 멈추고 sync/push를 자동 실행하지 않습니다.

Operation 결과가 서로 다른 digest로 충돌하면 drive는 후보를 임의로 선택하지 않습니다. 현재 owner는 `rdl run operation resolve`로 기존 candidate event를 선택하며, 다른 active project-member agent/service는 `--force`가 있어야 합니다. 이 명령은 이미 기록된 결과를 적용할 뿐 작업을 다시 실행하지 않습니다.
| `rdl conflict` | pending 충돌 조회·전략 해결·기록 정리 | 해결 커밋 또는 pending | 없음 |
| `rdl debug` | 명령 진단과 클라이언트 제공 토큰 사용량 기록·요약 | 로컬 JSONL 로그 | 없음 |
| `rdl action` | CLI·LLM·혼합 실행 주체 권장, 실제 선택과 fallback 기록 | 로컬 JSONL 로그 | 없음 |
| `rdl doctor` | 설치·PATH·버전·스킬과 선택적 Git URL 진단 | 없음 | `--git-url`일 때 ls-remote |
| `rdl board` | 로컬 태스크·협업 보드 실행 | UI 작업에 따라 프로젝트 파일 변경 | 서버 자체는 없음; Sync 버튼은 원격 사용 |

## Workspace와 프로젝트 생성

### `rdl init`

기존 Git 저장소 루트에서 Rundol 상태를 먼저 발견하고 필요한 bootstrap 동작만 수행한다. JSON 결과의 `action`은 `created`, `attached`, `repaired`, `already-connected`, `needs-selection`, `conflict` 중 하나다. 발견 단계는 manifest, Rundol ref, worktree, exclude를 변경하지 않는다.

```bash
rdl init memo --name "메모 앱" --profile product
rdl init --project memo --json
rdl init --guided
```

원격 프로젝트가 여러 개인 비대화형 실행은 `needs-selection`과 프로젝트 목록을 반환한다. `--json` 또는 비대화형 터미널에서는 질문하지 않는다. 새 프로젝트의 문서 정책은 `lean`, `product`, `service`, `platform`, `assured` 중 하나이며 `project.md`의 `documentProfile`에 저장된다. 프로필 선택은 빈 문서를 만들지 않는다.

생성 대상은 제품 브랜치가 아니라 Rundol 전용 브랜치와 linked worktree다.

```text
projects/workspace/           # rundol/workspace linked worktree
├─ workspace.yaml
├─ clients/
├─ projects/
└─ events/
projects/memo/                # rundol/memo linked worktree
├─ project.md
├─ tasks/<client-id>/000001.json
├─ docs/
└─ .obsidian/*.json           # 로컬 개인 설정, Git 비추적
```

프로젝트 브랜치는 main에서 분기하지 않는 orphan commit으로 시작한다. `origin`에 `rundol/memo`가 이미 있으면 새 브랜치를 만들지 않고 원격 커밋을 사용한다. 인증·DNS·TLS·연결 오류는 “원격 브랜치 없음”으로 취급하지 않고 초기화를 중단한다.

제품 저장소의 `.rundol`, `.gitignore`, 제품 파일은 만들거나 수정하지 않는다. `projects/*/` 숨김 규칙은 로컬 `.git/info/exclude`에만 기록한다.

### `rdl project add`

```bash
rdl project add tms --name "차량 관제"
```

Workspace의 `projects/project-tms.yaml`, `rundol/tms`, `projects/tms/`를 추가한다. 프로젝트 키는 영문 소문자·숫자·하이픈만 허용하며 `workspace`는 예약어다.

## 검사

```bash
rdl check
rdl check --project memo --strict
rdl check REQ-001
rdl check --links
rdl check --tasks
rdl check --json
```

검사 범위:

- `project.md`와 일반 Markdown의 필수 frontmatter
- 3자리 문서 코드, 번호, 한글 중심 제목과 파일명
- `rundol/`, `artifact/`, `domain/`, `feature/` 태그
- 실제 Obsidian 파일명·heading·block을 대상으로 하는 Wiki link
- `project.md`의 미션, 목표, 범위, 역할, 멤버, 이해관계자, RACI, 의사결정, 위험, 협업 리듬, 완료 정의
- ROLE·MEMBER·STAKEHOLDER block 필드
- 프로젝트별 태스크 샤드 또는 기존 `tasks.json`의 필드, 상태, 할당, 의존성, blocker, 완료조건과 문서 연결
- 프로젝트 Vault의 로컬 `.obsidian/` 설정

본문의 미해결 Wiki link는 기본 경고이며 `--strict`에서는 오류다. canonical metadata와 태스크 참조 오류는 항상 오류다. `ARTIFACT-ID`, `--links`, `--tasks`는 출력 진단을 필터링한다.

## Git 상태 명령

### `rdl settings migrate`

구형 schemaVersion 3을 settings 구조로 전환하는 호환 명령이다. 신규 전환은 `rdl workspace migrate`를 사용한다.

### `rdl workspace migrate`

schemaVersion 5의 `rundol/settings` Registry를 schemaVersion 6 `rundol/workspace`로 복사하고 `projects/workspace/` worktree를 만든다. 프로젝트 파일은 `project-<key>.yaml` 패턴으로 변환한다. 기존 settings 브랜치는 자동 삭제하지 않는다.

### Client

```bash
rdl client register laptop-a --name "업무 노트북" --type device --owner MEMBER-001
rdl client list
```

Client는 사람 자체가 아니라 장치·Agent·Service 실행 주체다.

`rdl lease`는 0.36에서 폐기했다. 다른 명령을 사람 표면에서 내린 것은 은닉이지 삭제가 아니지만 이것은 삭제이며, 호출하면 폐기를 알리는 오류로 끝난다. 문서를 동시에 고쳤을 때의 판정은 Git 병합이 하고, 같은 곳을 건드리는 작업이 겹치는지는 할당을 낼 때 수정 가능 경로로 걸러진다. 폐기 근거는 ADR-015에 있고 옮겨가는 순서는 [0.36 마이그레이션](MIGRATION-0.36.md)에 있다.

### `rdl git init`

등록된 각 프로젝트에 대해 다음 순서를 적용한다.

1. 로컬 `rundol/<key>` ref가 있으면 재사용한다.
2. 로컬 ref가 없으면 `origin`의 같은 ref를 fetch한다.
3. 원격 ref가 명시적으로 없고 로컬 seed가 있을 때만 orphan branch를 만든다.
4. `projects/<key>/`에 linked worktree를 연결한다.
5. `push.default=simple`과 같은 이름의 upstream을 설정하고 관리형 `pre-push` hook을 설치한다.

관리형 hook은 로컬 ref와 원격 ref 이름이 다른 교차 push 및 브랜치 삭제를 차단한다. 기존 `pre-push` hook은 `pre-push.rundol-user`로 보존하고 먼저 실행한다. 반복 실행해도 기존 ref와 커밋을 바꾸지 않는 멱등 명령이다.

### `rdl git boundary`

루트 worktree의 코드 브랜치, `projects/workspace`의 `rundol/workspace`, `projects/<key>`의 `rundol/<key>` 연결을 확인한다. worktree 경로·브랜치·관리형 push hook 중 하나라도 어긋나면 종료 코드 1과 `violations`를 반환한다.

### `rdl refresh`

원격 통신 없이 worktree 상태와 프로젝트 연결을 엄격 검사한다. 호환용 태스크 합본은 프로젝트 `.rundol/state/tasks.json`에 materialize하며 자동 커밋하지 않는다.

### `rdl save`

선택한 프로젝트의 `project.md`, 설계문서와 태스크 원본 변경을 `rdl check --strict` 수준으로 검사한 뒤 `rdl: update workspace` 커밋을 만든다. 변경이 없으면 커밋하지 않는다.

### `rdl sync`

```bash
rdl sync --project memo
rdl sync --project memo --no-push
rdl sync --project memo --remote upstream
```

동작 순서:

1. `save`
2. 원격 `rundol/<key>` fetch
3. fast-forward 또는 공통 base 기반 3-way 병합
4. 문서와 태스크 전체 검증
5. `--no-push`가 아니면 같은 ref로 push

샤드 태스크와 문서는 Git으로 병합한다. 기존 단일 `tasks.json` 프로젝트는 태스크 필드 단위 의미 병합을 유지한다. 충돌하면 push하지 않고 다음 파일에 기록한다.

```text
projects/<project-key>/.rundol/state/pending/merge-conflicts.json
```

강제 push와 공통 이력이 없는 브랜치의 자동 병합은 수행하지 않는다. `--project`를 생략한 전체 sync는 등록 목록을 순차 처리하는 독립 연산이며 하나의 원자적 Git 트랜잭션이 아니다.

Rundol이 실행하는 HTTP Git 명령은 자체 호스팅 GitLab reverse proxy의 HTTP/2 reset을 피하기 위해 명령 단위로 `http.version=HTTP/1.1`을 사용한다. 사용자 전역 Git 설정은 바꾸지 않는다.

## 태스크

### `rdl task add`

```bash
rdl task add "검색 구현" \
  --project memo \
  --summary "메모 본문을 검색한다." \
  --owner MEMBER-001 \
  --reviewer MEMBER-002 \
  --stakeholder STAKEHOLDER-001 \
  --priority high \
  --link REQ-001 \
  --acceptance "제목으로 검색된다." \
  --acceptance "본문으로 검색된다."
```

- 초기 상태는 `todo`다.
- `--acceptance`는 하나 이상 필요하며 반복 지정할 수 있다.
- `--reviewer`, `--stakeholder`, `--link`도 반복 지정할 수 있다.
- 담당자·검토자·이해관계자는 선택 프로젝트의 `project.md`에 등록돼야 한다.
- 변경 검증 후 클라이언트 태스크 샤드와 operation 기록을 쓰고 프로젝트 브랜치에 즉시 커밋한다. 기존 프로젝트는 `tasks.json`을 계속 지원한다.

#### 태스크 종류

`--kind`는 `normal`과 `test` 중 하나이며 기본값은 `normal`이다. 값이 없는 옛 태스크도 `normal`로 읽는다.

```bash
rdl task add "검색 회귀 실행" --project memo --owner MEMBER-001 --kind test \n  --link TST-004 --acceptance "TST-004의 시나리오를 수행한다."
```

테스트 태스크는 `--link`로 TST 문서를 **정확히 하나** 연결하고 `--round`로 차수를 받아야 한다. 무엇을 검증했는지 가리키지 않으면 모아 세도 답이 나오지 않고, 여럿을 묶으면 판정이 하나뿐이라 어느 것이 실패했는지 알 수 없다.

#### 차수

차수는 실행 회차를 가리키는 **프로젝트 전역 정수**이며 1부터 시작한다. `(TST 문서 × 차수)` 하나에 태스크 하나이고, 같은 조합의 태스크를 또 만들면 거부한다(`RDL-TASK-032`). 반려한 태스크는 자리를 비우므로 잘못 만든 것을 반려하고 다시 만들 수 있다.

정수 하나로 두는 이유는 표기가 갈리지 않게 하려는 것이다. 문자열이면 `2차`, `2차 `, `R2`가 서로 다른 회차가 되어 모아 세는 일이 불가능해진다. 정수는 정렬과 비교도 자명해서 회귀 판단이 그냥 되고, "지금 몇 차인가"를 따로 저장하지 않아도 태스크들의 최댓값이 답한다.

재실행은 새 태스크가 아니다. 같은 차수에서 실패했다가 수정 후 통과하면 같은 태스크의 판정이 바뀐다. 발견한 결함은 별도의 일반 태스크로 만들어 그 테스트 태스크의 선행으로 연결한다 — 결함 목록이 보고서의 알맹이인데, 테스트 태스크를 둘로 나누는 방식으로는 무슨 결함이었는지가 남지 않는다.

구현 준비도(`atomic-v1`) 표식은 테스트 태스크에 붙지 않는다. 준비도는 "이 태스크가 구현을 시작해도 되는가"를 묻는 게이트라 REQ와 TST 계약을 함께 요구하는데, 실행 태스크는 구현하지 않고 이미 있는 TST의 시나리오를 밟을 뿐이다.

### `rdl task set`

```bash
rdl task set TASK-AWM8ZS3N --project memo --status doing --owner MEMBER-001
rdl task set TASK-AWM8ZS3N --project memo --owner null
rdl task set TASK-AWM8ZS3N --project memo --status cancelled --reason "다른 방향으로 결정"
```

현재 직접 변경 가능한 필드는 `status`, `owner`, 문서 `links`와 테스트 태스크의 `result`다. 허용 상태는 `todo`, `doing`, `waiting`, `review`, `done`, `cancelled`이며 상태별 owner·blocker·검토·완료조건 규칙을 전체 검사한다. 같은 값이면 새 커밋을 만들지 않는다.

#### 문서 링크 편집

```bash
rdl task set TASK-AWM8ZS3N --project memo --link TST-004 --link REQ-012
rdl task set TASK-AWM8ZS3N --project memo --unlink REQ-020
```

`--link`는 더하고 `--unlink`는 뺀다. 한 호출에 여러 번 쓸 수 있고 같이 쓸 수도 있으며, 제거가 먼저 적용되므로 같은 호출로 교체가 된다. 이미 있는 링크를 다시 더해도 중복되지 않고 기존 순서가 앞에 남는다. 태스크에 없는 링크를 빼려 하면 거절한다 — 조용히 넘기면 오타로 지운 줄 알고 넘어가고 정작 끊긴 참조는 그대로 남는다.

이 경로가 필요한 이유는 `done` 게이트가 TST 링크를 요구하기 때문이다(`RDL-TASK-019`). 링크를 생성 시점에만 정할 수 있으면 링크 없이 만든 태스크는 명령줄로 영원히 닫히지 않고, 가리키던 문서가 폐기되면 그 참조를 지울 방법도 없어 검사가 계속 실패한다.

`done`과 `cancelled`는 둘 다 종료 상태지만 게이트가 반대다. `done`은 모든 수용조건 완료와 TST 문서 연결을 요구하고, `cancelled`는 그 증거가 없다는 것을 전제로 `--reason`을 요구한다. 하지 않기로 한 일을 `done`으로 닫으면 기록이 완료로 남아 뒤에 읽는 사람이 없는 산출물을 찾게 되므로 두 상태를 나눈다.

#### 테스트 판정

```bash
rdl task set TASK-... --project memo --status done --result fail
rdl task set TASK-... --project memo --result none
```

판정은 진행 상태와 **다른 축**이다. 실패한 테스트도 수행은 끝난 것이므로 상태는 `done`이고 판정이 `fail`이다. 한 필드에 섞으면 "실패를 확인한 테스트"와 "아직 돌리지 않은 테스트"가 같은 값이 되어, 테스트만 모아 성공 여부를 묻는 일이 처음부터 불가능해진다.

판정은 `pass`, `fail`, `blocked`, `skipped` 중 하나이며 `none`은 판정을 지운다. 테스트 태스크가 아닌 태스크에는 둘 수 없다(`RDL-TASK-027`). 완료하는 테스트 태스크에는 판정이 필요하다(`RDL-TASK-028`). 반려는 수행하지 않기로 한 것이므로 요구하지 않는다.

`--decided-by`를 생략하면 태스크의 현재 owner가 결정한 것으로 기록한다. 반려를 되돌려 다른 상태로 바꾸면 반려 사유는 자동으로 지워진다. 종료 상태가 된 태스크는 선행 태스크로서 후행 태스크를 더 이상 막지 않는다.

태스크 변경 operation은 다음 위치에 기록된다.

```text
projects/<project-key>/.rundol/state/pending/OP-*.json
```

### `rdl task acceptance`

```bash
rdl task acceptance TASK-AWM8ZS3N AC-001 --done --project memo
rdl task acceptance TASK-AWM8ZS3N AC-001 --undone --project memo
```

등록된 수용조건 하나의 `done` 값만 변경하고 operation과 commit을 남긴다. 모든 수용조건을 완료한 뒤 `rdl task set --status done`을 실행한다. 존재하지 않는 태스크나 수용조건은 변경하지 않는다.

### `rdl task list`

```bash
rdl task list --project memo --kind test --json
```

`--kind`는 목록을 종류로 좁히고, `--round`는 **범위를 좁힌다**. 둘의 성격이 다르다 — `--kind`는 표시 필터라 집계에 영향을 주지 않지만, `--round`는 `--project`처럼 범위여서 집계도 그 차수 안에서 센다. 2차를 물었는데 전체 차수의 집계가 돌아오면 답이 질문과 어긋나기 때문이다. 차수를 물으면 차수를 갖지 않는 일반 태스크는 애초에 범위 밖이다.

`--kind`는 목록을 종류로 좁힌다. 응답의 `results`는 테스트 태스크의 판정별 집계이며, 상태 집계와 같은 규칙을 따른다 — 선택된 프로젝트 범위에서 세고 필터 이전 값을 쓴다. 아직 판정이 없는 테스트는 `pending`, 반려한 테스트는 `cancelled`로 센다. 둘을 나누는 이유는 돌릴 예정인 것과 돌리지 않기로 한 것이 다르기 때문이다.

### `rdl test rounds`

```bash
rdl test rounds --project memo --json
rdl test rounds --project memo --round 2 --json
```

차수 없이 부르면 존재하는 차수 목록과 차수별 요약(태스크 수, 판정 집계, 범위)을, `--round`를 주면 그 차수의 태스크와 **태스크가 없는 TST 목록**을 낸다.

차수 대상 목록은 어디에도 저장하지 않는다. **태스크를 만든 것이 곧 그 차수의 범위**이고, 빠진 것은 TST 문서 전체와 대조해 계산한다. 목록을 파일로 두면 정본이 둘이 되어, 목록에는 다섯인데 태스크는 셋인 상태를 아무도 알아채지 못한다.

```json
{
  "rounds": [1, 2],
  "latest": 2,
  "round": 2,
  "results": { "pass": 8, "fail": 2 },
  "coverage": { "total": 16, "covered": 10, "missing": [{ "id": "TST-004", "title": "알림 검증" }] }
}
```

### 태스크 마이그레이션과 충돌

```bash
rdl task migrate --project memo --client-id laptop-a --max-items 500
rdl conflict list --project memo
rdl conflict resolve --project memo --strategy ours
```

마이그레이션은 단일 `tasks.json`을 클라이언트별 segment로 분리한다. 충돌 해결의 `ours`와 `theirs`는 기록된 충돌 전체에 같은 전략을 적용한다. 문서별·필드별 대화형 선택은 아직 제공하지 않는다. `rdl conflict clear`는 pending 기록만 제거한다.

## 런 실행 관리

```bash
rdl run procedures --project memo --json
rdl run start document.authored --project memo --client-id laptop-a --goal "결제 REQ"
rdl run next --run RUN-... --project memo --json
rdl run step --run RUN-... --project memo --client-id laptop-a --step create --artifact-id REQ-001
rdl run gate --run RUN-... --project memo --client-id laptop-a
rdl run halt --run RUN-... --project memo --client-id laptop-a
rdl run resume --run RUN-... --project memo --client-id laptop-a
rdl run complete --run RUN-... --project memo --client-id laptop-a
rdl run takeover --run RUN-... --project memo --client-id desk-b --force --reason "소유 머신 분실"
rdl run list --project memo --json
rdl run log --run RUN-... --project memo --json
```

런은 목표, 단계, 게이트, 결과를 `RUN-ID`로 묶는 실행 단위다. 진행 상태는 저장되지 않고 프로젝트 로컬 `.rundol/runs/<RUN-ID>/events.jsonl` 원장을 읽기 시점에 fold해 재계산한다. 프로세스가 어디에서 중단돼도 다음 읽기가 커서, 시도 횟수, 정지 사유를 복원한다.

절차는 내장 기본값 → Workspace `projects/workspace/procedures.json` → 프로젝트 `projects/<key>/procedures.json` 순서로 상속한다. 오버라이드는 스텝 추가와 파라미터 조이기만 허용하며 게이트 제거, 게이트 명령 변경, 시도 상한 확대, 사람 게이트 제거는 로드 시점에 거부된다. 런은 시작 시점의 절차 정의 전문을 pin하므로 이후 정의가 바뀌거나 삭제돼도 시작 계약으로 완주한다.

`next`는 클라이언트 중립 인터페이스다. 커서 스텝의 실행 방법(명령 argv, 게이트, 사람 게이트 여부)을 반환하고, 일반 스텝은 `step`으로 완료를 보고하며, 게이트 스텝은 `gate`가 rdl 하위 명령을 셸 없이 직접 실행해 종료 코드로만 전진한다. `--force --reason` 우회는 forced 이벤트로 기록을 남긴다. 게이트 실패의 재작업 루프는 절차의 시도 상한이 강제하며, 상한 도달 시 런은 재개 가능한 정지 상태가 된다.

커서를 결정하는 이벤트는 Workspace의 `events/run/` 아래 클라이언트+런 샤드로 복제된다. 다른 머신은 공유 이벤트만 읽어도 같은 커서를 복원한다. 인수(takeover)는 이전 소유자의 정지가 보일 때만 자동이고, 정지 없이 중단된 런은 `--force --reason`으로 사람이 결정한다. 벽시계 시간은 어떤 인수 판정에도 쓰이지 않는다.

`rdl sync`가 성공하면 `completed_local` 런이 `synced`로 전이한다 — 런의 완료는 저장이 아니라 병합 생존이다. sync 실패는 관련 런을 재개 가능한 정지로 전이시킨다. `rdl check`는 run 샤드의 파일명(`RDL-RUN-001`), Client 등록(`RDL-RUN-002`), 파일명과 이벤트 필드의 일치(`RDL-RUN-003`), JSONL 파싱(`RDL-RUN-004`)을 검사한다.

## 문서 생성

문서 1개가 기능 1개를 나르는 것이 기본 계약이다. `--function-id`를 2개 이상 주려면 `--grouped --reason <합침 사유>`로 명시해야 하고, scaffold는 frontmatter에 `groupingReason`과 `groupingFunctions`를 기록한다. REQ와 SCR은 선언이 있어도 다기능을 거부한다 — 분리가 유일한 해소다. TST는 선언으로 허용되고, MOD와 IFC는 허용하되 검사가 사유를 경고로 항상 표면화한다. `rdl check`는 선언 없는 다기능(`RDL-IMPL-013`), 금지 유형의 다기능(`RDL-IMPL-014`), 선언 형식 위반(`RDL-IMPL-015`), 같은 기능 ID가 같은 유형 문서 여럿에 흩어진 것(`RDL-IMPL-016`), 기능의 화면 정본을 검증 문서가 참조하지 않는 것(`RDL-IMPL-018`)을 진단한다. 이 진단들은 일반 검사에서 경고이고 `--implementation` 준비도 게이트에서 오류다 — 기존 문서의 정리가 끝나면 상시 오류로 승격을 검토한다.

`RDL-IMPL-018`은 조건부다. TST의 필수 관계는 REQ로 남고, 그 TST가 선언한 기능 ID를 구현하는 SCR이 실제로 있을 때만 그 SCR을 `related`에 요구한다. 화면이 있는 기능은 화면을 근거로 검증되고, 인증·배치·웹훅·공개 API처럼 화면이 없는 기능은 REQ 관계만으로 통과한다 — 필수 관계를 SCR로 바꿨다면 이 기능들이 검증 대상에서 통째로 빠졌을 것이다. 집계와 원자성의 축은 화면이 아니라 기능 ID로 유지된다.

`rdl init --guided`는 UI, data, API, component, operations, security/regulation, terminology 신호를 질문하고 최종 traits와 policy만 `project.md`에 저장한다. `ui` trait는 SCR을 `required`로 올린다 — 화면이 있다고 선언한 제품에서 화면 정본은 권고가 아니라 전제이고, SCR이 없으면 `RDL-IMPL-018`이 아무것도 잡지 못한다. 같은 설정을 자동화할 때는 `--profile`과 반복 가능한 `--trait`를 사용한다. `rdl project profile --json` 결과에는 revision/history, 누락 required 유형과 다음 `rdl doc create` 명령이 포함된다. 정책을 직접 override할 때는 네 상태 옵션을 모두 지정하고 모든 정규 유형을 정확히 한 번 포함해야 한다.

```bash
rdl doc create PRD "메모 제품 요구사항" --project memo --owner MEMBER-001 --scope "메모 제품의 사용자 문제와 성공 기준" --exclude "개별 메모 작성 동작"
rdl doc create REQ "메모 검색" --project memo --owner MEMBER-001 --scope "저장된 메모를 조건으로 검색하는 동작" --exclude "메모 작성과 삭제" --function-id MEM-01 --related PRD-001
```

지원 유형은 PRD, GLS, ARC, REQ, SCR, MOD, IFC, ADR, TST, RUN, NTE다. CLI는 다음 3자리 번호, 한글 중심 파일명, 실제 등록 멤버 owner, 실제 파일명을 사용한 Wiki link와 필수 태그를 적용한다. NTE를 제외한 새 정규 문서는 `--scope`로 하나의 독립 검토 책임을, 반복 가능한 `--exclude`로 인접하지만 책임지지 않는 범위를 선언한다. 소유자·수용 기준·변경 주기·소비자가 달라지면 같은 유형이어도 별도 문서로 분리한다. REQ·SCR·MOD·IFC·TST·RUN은 `--related`가 필요하다. 본문에서 아직 결정하지 못한 값은 필드를 삭제하지 않고 `작성 필요`로 남긴다.

REQ·SCR·MOD·IFC·TST는 반복 가능한 `--function-id`로 구현 기능을 선언한다. 한 파일에 여러 기능을 둘 수는 있지만 명세를 묶을 수는 없다. `PAY-01~04`, `PAY-01, PAY-02` 같은 범위·통합 행은 오류이며, 모든 기능 ID가 단독 문서일 때와 같은 수준의 독립 섹션, 유형별 필수 구성요소, 수용 기준과 검증 증거를 가져야 한다. 미정 업무 규칙이나 `원본 문서 적용` 같은 위임 문구도 구현 준비 완료로 인정하지 않는다.

```bash
rdl check --project memo --strict --implementation
rdl contract trace --project memo --json
```

`--implementation`은 기능별 구현 계약과 연결된 TST를 완료 게이트로 검사한다. 추적성은 frontmatter의 기능 ID와 직접 문서 링크에서 실행 시 계산한다. `contract trace`의 `persistedIndex`는 항상 `false`이며 별도 INDEX·목록·카탈로그·추적표 문서를 정본으로 만들지 않는다.

## 합성 다이어그램

```bash
rdl contract diagram --project memo --json
rdl contract diagram --project memo --write
```

여러 문서를 합친 다이어그램은 손으로 쓰지 않고 계산한다. 모든 `MOD`의 `erDiagram`이 데이터 관계 뷰로, 모든 `SCR`의 `flowchart`가 화면 전이 뷰로 합쳐진다. 엔티티 속성은 수명주기를 소유한 문서 것을, 화면 이름은 해당 `SCR`의 `title`을 쓴다. 두 문서가 같은 엔티티의 속성을 선언하면 `RDL-COMPOSE-001`, 전이가 존재하지 않는 화면을 가리키면 `RDL-COMPOSE-002`를 보고한다.

`rdl check`도 같은 합성을 시도해 `RDL-COMPOSE-001`·`RDL-COMPOSE-002`를 보고하고, 생성 파일이 현재 정본과 다르면 `RDL-COMPOSE-003`으로 재생성을 알린다. 비교는 다이어그램 본문으로 하므로 commit만 움직인 경우는 stale이 아니고 생성 파일을 손으로 고친 경우는 stale이다. `rdl attach`는 연결하면서 생성 파일을 만들되, `.gitignore`에 `views/`가 없는 기존 프로젝트에서는 연결이 추적 파일을 바꾸지 않도록 건너뛴다.

`--write`는 Vault의 Git 비추적 `views/`에 생성 파일을 만들고 프로젝트 `.gitignore`에 항목이 없으면 한 번 추가한다. Obsidian이 점으로 시작하는 폴더를 인덱싱하지 않으므로 `.rundol/`이 아니라 `views/`를 쓴다. 생성 파일은 정본이 아니며 commit하지 않는다. frontmatter의 `revision`이 현재 프로젝트 commit과 다르면 `stale`로 보고하고, 같은 입력으로 다시 생성하면 항상 같은 바이트가 나오므로 삭제해도 잃는 것이 없다.

## Debug와 토큰 사용량

```bash
rdl check --debug
rdl debug record --provider openai --model gpt-example --input-tokens 1200 --output-tokens 300
rdl debug record --provider openai --model not-reported --input-tokens 0 --output-tokens 0 --unreported
rdl debug summary
```

`--debug` 또는 `RUNDOL_DEBUG=1`은 명령명·소요시간·종료 코드와 성공 여부를 프로젝트 `.rundol/logs/debug.jsonl`에 남긴다. 여러 프로젝트에서는 `--project`가 필요하다. 프롬프트와 문서 본문은 기록하지 않는다. Rundol 자체는 모델 공급자의 토큰을 추정하지 않으며 AI 클라이언트가 보고한 수치만 집계한다.

## CLI·LLM 액션 라우팅

```bash
rdl action resolve document.create --json
rdl action resolve document.edit --json
rdl action record document.edit --actual-executor hybrid --artifact-id REQ-001
rdl action record document.create --actual-executor llm --artifact-id REQ-001 --fallback-reason "기존 비표준 문서 변환"
```

`resolve`는 표준 액션에 대해 `cli`, `llm`, `hybrid` 권장 executor와 command hint를 반환한다. `record`는 권장·실제 executor, artifact/task ID와 fallback 이유를 본문 없이 기록한다. 권장 executor와 다른 방식을 사용하면 `--fallback-reason`이 필수다.

디버그 모드의 `rdl doc create`, `rdl task add`, `rdl task set`, `rdl task acceptance`는 실제 CLI action event를 자동 기록한다. `rdl debug summary`는 planned/actual executor 건수, fallback, 채택 건수와 채택률을 반환한다.

## 설치 진단

```bash
rdl doctor
rdl doctor --json
rdl doctor --git-url https://gitlab.example.com/group/rundol.git
```

Node.js·npm·Git 최소 버전, 패키지 필수 파일, postinstall 격리, PATH launcher, AI 클라이언트 스킬을 확인한다. `--git-url`을 지정하면 credential prompt 없이 읽기 접근을 검사하고 인증·HTTP reset·DNS·TLS·저장소 없음 오류를 구분한다. 상세 설치와 복구 명령은 [Git 저장소 설치와 복구](INSTALLATION.md)에 있다.

## 버전과 릴리스 검사

다음 명령은 Rundol 소스 저장소의 개발·배포 과정에서 사용하며 설치된 `rdl` 하위 명령은 아니다.

```bash
npm run version:check
npm run release:check
```

`version:check`는 SemVer, workspace package name 고유성, private monorepo 경계, 같은 CHANGELOG 항목, `postinstall` 부재와 CI tag 일치를 검사한다. 여기에 잠금 파일 무결성도 함께 본다 — 내부 의존이 선언과 잠금에서 갈리지 않는지, 그리고 서드파티 항목의 잠금 버전이 그 항목이 가리키는 tarball과 같은지다. 뒤엣것이 어긋나면 `npm ci`가 거부하는데, 그 거부는 태그를 단 뒤 릴리즈 워크플로에서 처음 보인다. `release:check`는 여기에 타입 검사와 전체 테스트, 통합·개별 package tarball 설치 회귀 테스트를 더한다. 정책은 [버전과 릴리스](RELEASES.md)를 따른다.

## Obsidian

```bash
rdl obsidian init --project memo
rdl obsidian init --force
```

선택 프로젝트의 `projects/<key>/.obsidian/`에 기본 설정을 설치한다. Obsidian에서는 `projects/<key>/` 자체를 Vault 루트로 연다. 기본 동작은 기존 개인 설정을 보존하며 `--force`일 때만 같은 이름의 파일을 덮어쓴다.

## 거버넌스 스킬 설치

```bash
rdl skill install
rdl skill install --force
```

`rundol-project-governance` 스킬을 Codex, Claude Code와 GitHub Copilot의 개인 skills 폴더에 설치한다. 전역 설치 후 한 번 실행하고, CLI를 갱신한 뒤에도 다시 실행해 스킬을 최신 계약으로 맞춘다.

`.rundol-managed.json` 마커가 없는 기존 디렉터리는 사용자가 관리하는 스킬로 보고 보존하며, 덮어쓰려면 `--force`를 지정한다.

**이 작업을 npm `postinstall`로 연결하지 않는다.** npm 전역 설치가 git URL을 대상으로 할 때 `postinstall`이 있으면 npm이 패키지를 복사하지 않고 캐시의 임시 클론에 링크한다. 그 임시 클론은 곧 정리되므로 `bin/`과 `src/`가 사라진 채 설치가 끝나고, 이어서 실행된 `postinstall`이 실패하면 npm이 롤백하며 기존에 설치돼 있던 정상 버전까지 지운다.

## 로컬 보드

```bash
rdl board --project memo
rdl board --project memo --port 47231
rdl board --project memo --no-open
```

- `127.0.0.1`에만 bind한다.
- 기본값은 사용 가능한 임의 포트이며 브라우저를 자동 실행한다.
- 문서 중심 3패널 Workspace, Markdown 읽기·검증 편집, 조치 필요, 태스크 목록·Board와 People·Operations·Settings 분리 화면을 제공한다.
- 태스크 쓰기는 검증 후 즉시 프로젝트 브랜치에 커밋한다.
- 문서 편집은 base revision을 요구하고 strict 검증 실패 시 원본을 복구한다.
- Refresh는 로컬 검증, Sync는 선택 프로젝트의 원격 동기화를 실행한다.
- 3초마다 Workspace·문서·태스크·사람·Client·Sync·계약·표현 영역별 revision을 확인해 변경된 Snapshot을 반영한다.
- API는 한 요청에서 최대 500개 태스크를 반환하고 쓰기 요청에 로컬 세션 토큰을 요구한다.
- CSP, frame 차단과 64KB 요청 제한을 적용한다.

## 출력과 종료 코드

사람용 출력은 파일, 행, 진단 코드와 조치 대상을 보여준다. `--json`은 CI, LSP, Obsidian adapter와 AI가 사용할 구조화 결과를 출력한다.

| 종료 코드 | 의미 |
|---:|---|
| `0` | 명령 성공 또는 검증 오류 없음. 경고는 있을 수 있음 |
| `1` | `check`가 검증 오류를 발견함 |
| `2` | 잘못된 인자, Workspace 탐색 실패, Git/파일/내부 실행 오류 |

## 현재 제공하지 않는 기능

- Markdown formatter와 자동 `--fix`
- 태스크 삭제와 임의 필드 수정을 위한 범용 CLI
- 충돌을 문서별·필드별로 선택하는 대화형 TUI
- 프로젝트 간 태스크 의존성 qualified reference
- LSP와 전용 Obsidian plugin
- 여러 프로젝트 sync의 원자적 일괄 rollback

이 항목들은 구현 전까지 실제 명령처럼 문서나 도움말에 표기하지 않는다.
