# 하네스 훅

Rundol의 통제는 다섯 층으로 서 있다. 스킬(지시), 발견 표면(대체), action 원장(감사), CLI 게이트(거부), Git hook(경계). 이 문서는 그 사이에 훅을 놓는 계획과 근거를 적는다.

## 왜 훅인가

이 저장소에서 실제로 측정한 값이 근거다.

| 기제 | 성질 | 사용 곡선 |
|---|---|---|
| `rdl action record` | 따로 부른다 | 515건이 **3일**에 몰림. 나머지 날은 0 |
| 코드 브랜치 커밋 결박 | 따로 붙인다 | 30건이 **하루**에 몰림. 앞뒤로 0 |
| `rdl session` | 따로 연다 | 1건 열고 닫지 않음 |
| 태스크 operation 기록 | `rdl task set`의 **부수효과** | 9일간 545건, 끊김 없음 |

따로 불러야 하는 통제는 전부 버스트 후 침묵했고, 이미 부르는 명령에 얹힌 것만 계속 살아 있었다. `src/state.js`가 그 결과를 미리 적어 놓았다.

> 아는 것을 묻는 통제는 확인이 아니라 요금이고, 요금을 무는 통제는 우회된다.

**훅은 "따로 부르는 것"을 "부수효과"로 바꾸는 유일한 기제다.** 사람의 기억을 하네스의 실행으로 대체한다.

같은 실패가 문서 검사에서 한 번 났고 훅으로 막혔다. `.claude/hooks/rundol-check.js`의 주석이 그 경위를 적고 있다 — 제목 규칙 위반이 검사를 손으로 돌릴 때까지 드러나지 않았고, 고친 직후에 말하도록 바꾼 뒤에 사라졌다.

## 설계 원칙

- **훅은 판정할 사실이 이미 있는 시점에만 건다.** 프롬프트 제출 시점에는 바뀐 것이 없다.
- **되돌릴 수 있는 시점이 앞설수록 낫다.** `PreToolUse` > `PostToolUse` > `Stop` > `pre-commit`.
- **판정은 `rdl`, 훅은 호출자.** 판정을 훅 스크립트에 두면 클라이언트마다 답이 갈린다. `src/worker-contract.js`가 사람 워커와 에이전트 워커를 한 함수로 판정하는 것과 같은 이유다.
- **차단 판정은 10ms급이어야 한다.** `rdl check`는 3초대다. 도구 호출마다 걸 수 없다.
- **못 읽으면 통과시킨다.** 훅이 판정을 지어내면 막지 말아야 할 것을 막고, 그렇게 한 번 겪은 훅은 꺼진다.
- **훅만으로 강제되는 규칙은 강제가 아니다.** `disableAllHooks` 한 줄로 전부 꺼진다. 훅에 거는 모든 규칙은 아래에 CLI 거부나 Git hook이 받쳐야 한다.

## 이벤트 배치

| 이벤트 | 조건 | 판정 | 겨냥 | Claude | Codex |
|---|---|---|---|---|---|
| `SessionStart` | `startup`·`resume` | 주입만 | doing 누적이 안 보이는 것, 세션 충돌 미인지 | ✅ | ✅ |
| `PostToolUse` | `Write\|Edit` | exit 2 | 문서 규칙 위반 | ✅ | ✅ |
| `PostToolUse` | `if: Bash(git commit *)` | 기록만 | 결박 지표의 사각지대 | ✅ | ✅ |
| `Stop` | 항상 | **차단** | 미결박 커밋 | ✅ | ✅ |
| `SessionEnd` | 항상 | 보고만 | 닫히지 않은 세션 worktree | ✅ | ✅¹ |
| `PreToolUse` | `Write\|Edit`, `Bash(git commit *)` | **차단** | 본 트리에 코드가 쌓이는 것 | ✅ | ✅ |
| `SubagentStop` | 코드 쓰는 구성일 때 | 차단 | 위와 같음 | ✅ | ✅ |
| `PreCompact`·`PostCompact` | 항상 | 스냅샷·주입 | 압축 뒤 태스크 상실 | ✅ | ✅ |
| `PostToolUseFailure` | `Bash` | 주입 | 오류 코드에서 다음 수로 | ✅ | ❌ |
| `WorktreeCreate`·`WorktreeRemove` | 항상 | 등록·해제 | `rdl` 밖에서 만든 worktree가 목록에 없음 | ✅ | ❌ |
| ~~`UserPromptSubmit`~~ | — | **걸지 않는다** | 매 제출 동기 실행인데 판정할 사실이 없다 | — | — |

¹ Codex의 `session-end`는 출력 스키마가 없어 차단할 수 없다. 보고 전용이므로 무방하다.

Codex의 네이티브 훅 이벤트는 11종(`PreToolUse` `PermissionRequest` `PostToolUse` `PreCompact` `PostCompact` `SessionStart` `SessionEnd` `UserPromptSubmit` `SubagentStart` `SubagentStop` `Stop`)이고 Claude Code는 31종이다. **Rundol이 필요로 하는 자리는 전부 교집합 안에 있다.** Codex는 Claude Code의 훅 와이어 계약을 그대로 구현했으므로 판정 구현은 하나면 된다.

## `rdl hook` 계약

```
rdl hook <session-start|post-tool-use|stop|session-end> [--client <claude|codex>] [--root <path>] [--json]
  stdin  : 클라이언트 훅 페이로드 JSON
  stdout : 통과 시 주입할 컨텍스트 (`[rdl] ` 접두)
  stderr : 차단 사유
  exit   : 0 통과 · 2 차단 · 그 밖은 비차단 오류
```

`rdl --help`에는 없고 `rdl advanced`에만 있다. 사람이 치는 명령이 아니라 하네스가 부르는 표면이며, `rdl assignment`를 같은 이유로 같은 자리에 둔 것과 같다.

두 클라이언트의 페이로드는 필드 이름이 거의 같다 — `hook_event_name`, `cwd`, `session_id`, `transcript_path`, `permission_mode`. `--client`는 나머지 차이만 흡수한다.

### 이벤트별 판정

**`session-start`** — 주입만 한다. 이 시점에는 판정할 사실이 없고, 막아 봐야 일을 못 하게 할 뿐이다.

```
[rdl] 작업 트리: 본 트리 · 브랜치 main
[rdl] 열린 태스크: cancelled 6 · doing 14 · done 68 · todo 24
[rdl] 주의: doing이 14건이라 저장의 자동 파생이 답하지 못합니다. 커밋마다 --task가 필요합니다.
[rdl] 세션 7fdeb6de: C:\dev\aiworks\rundol-7fdeb6de — 종료됨(미정리)
```

doing 개수를 매번 말하는 이유는 그것이 파생 사다리의 전제이기 때문이다. `single-doing`은 doing이 정확히 하나일 때만 답하므로, 둘 이상이면 저장마다 `--task`가 손으로 필요해진다. 그 사실이 지금은 `rdl task list`를 일부러 쳐야만 보인다.

본 작업 트리라면 추적 제외 규칙도 확인한다. 세션 worktree가 `.rundol/worktrees/`에 서게 되면서 `/projects/*/`와 `.rundol/`은 편의가 아니라 전제가 됐다 — 규칙이 없는 채로 자리를 옮기면 `git add -A` 한 번이 트리를 통째로 담는다. 없으면 채우고 무엇을 채웠는지 말한다. 조용히 고치면 추적 규칙이 언제 어디서 들어왔는지 아무도 답할 수 없다.

세션 worktree에서는 채우지 않는다. 같은 파일이 두 자리에서 갈리면 어느 쪽이 커밋될지가 그때 누가 저장하느냐에 달린다.

여기서 **커서**를 놓는다. `stop`이 "이 턴이 만든 것"을 세려면 지난번에 본 HEAD가 있어야 한다.

**`post-tool-use`** — `git commit`이 실제로 끝난 뒤 그 커밋의 결박 여부를 debug 원장에 적는다. 막지 않는다. `rdl check`의 50건 창은 사후에만 답하지만 이것은 매 커밋을 그 자리에서 센다.

**`stop`** — 완료 주장을 Git으로 재확인한다.

| 검사 | 결과 |
|---|---|
| 커서 이후 새 커밋 중 미결박이 있는가 | **차단** |
| 워킹트리에 미커밋 변경이 있는가 | 보고 |
| 현재 브랜치가 `rundol/*`인가 | 통과 (`rdl save`가 이미 강제한다) |
| `stop_hook_active`가 `true`인가 | **통과하고 커서를 전진** |

마지막 줄이 루프 방지다. 한 턴에 한 번만 되돌리는 것이 이 훅의 계약이며, 이것이 없으면 고치지 않는 모델과 훅이 무한히 주고받는다.

미커밋 변경을 차단하지 않는 이유는 진행 중인 트리가 더러운 것이 정상이기 때문이다. 그것까지 막으면 훅이 소음이 되고, 소음이 된 훅은 꺼진다.

커서가 없으면 아무것도 세지 않는다. 커서를 잃었다고 이력 전체를 한 턴의 결과로 읽으면, 처음 켠 훅이 과거 수백 건을 이 턴의 위반으로 보고한다.

**`session-end`** — 세션별 미커밋·미병합 건수를 보고한다. `rdl session end`를 자동으로 부르지 않는다. 미커밋 변경이 있으면 거부하는 것이 그 명령의 계약인데 훅은 되물을 수 없어, 자동으로 부르면 `--force`로 밀거나 실패하거나 둘 중 하나가 된다.

### 실패 모드

| 상황 | 동작 |
|---|---|
| `rdl`이 실패하거나 시간이 초과됨 | 통과. 판정을 지어내지 않는다 |
| stdin이 비었거나 JSON이 아님 | 빈 페이로드로 본다 |
| cwd가 Git 저장소 밖 | 통과 |
| Workspace 미연결 | 통과. 세션 worktree에는 `projects/`가 없다 |
| 커서 파일 쓰기 실패 | 통과. 다음 턴에 다시 시도한다 |

## 도입 단계

각 단계는 앞 단계의 결과를 승격 조건으로 갖는다.

| 단계 | 내용 | 승격 조건 | 상태 |
|---|---|---|---|
| **0** | 결박 지표를 코드 브랜치까지 넓힌다 | `rdl check`가 코드 브랜치 미결박을 보고한다 | **완료** |
| **1** | 관측 훅 — `SessionStart` 주입, `PostToolUse` 기록. 차단 0건 | doing이 1~2건으로 내려가 파생 사다리가 다시 답한다 | **완료** |
| **2** | `Stop` 차단 | 차단 중 오탐 10% 미만 | **완료** |
| **3** | `PreToolUse` 차단 — 기본 코드 브랜치의 본 트리에서 제품 코드 쓰기 거부 | 오탐이 나오지 않는다 | **완료** |
| 4 | Git `pre-commit` — 훅이 꺼져도 서는 층 | — | 미착수 |

**3단계를 2단계보다 뒤에 두는 이유**는 순서가 아니라 전제 때문이다. doing이 정리되지 않은 상태에서 `PreToolUse` 차단을 켜면, `state.js`가 예언한 "요금을 무는 통제"를 훅으로 강제하는 셈이 되고 그것은 지금보다 나쁘다.

### 0단계가 바꾼 것

`rdl check`가 프로젝트 ref만 재고 있었다. `src/check.js`의 결박 진단이 `project.ref`를 스캔하므로 코드 브랜치는 창 밖이었고, 그래서 저장소 전체의 결박이 무너져도 검사가 초록으로 답했다.

```
  최근 커밋 50건: 결박 48 · 우회 2 · 미결박 0 (결박 밖 4%)
  코드 브랜치 main 최근 50건: 결박 29 · 우회 0 · 미결박 21 · 끊긴 결박 1 (결박 밖 42%)
```

두 줄을 따로 내는 이유는, 한 줄로 합치면 문이 있는 쪽의 높은 결박률이 문이 없는 쪽을 가려 지표가 실제보다 건강해 보이기 때문이다. 새 진단은 `RDL-TASK-041`(코드 브랜치 미결박)이며 경고다 — 코드 커밋은 `rdl save`를 지나지 않으므로 여기에는 막을 자리가 없고, 막을 수 없는 자리에서 오류를 내면 검사 전체가 꺼진다.

## 설치

### Claude Code

`.claude/settings.json`. **이 저장소에서는 `.claude/`가 `.gitignore` 대상이므로 설정이 팀에 공유되지 않는다.** 아래를 각자 복사한다.

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume",
        "hooks": [{ "type": "command", "command": "node",
                    "args": ["${CLAUDE_PROJECT_DIR}/bin/rdl.js", "hook", "session-start", "--client", "claude"],
                    "timeout": 30, "statusMessage": "rdl hook session-start" }] }
    ],
    "PostToolUse": [
      { "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node",
                    "args": ["${CLAUDE_PROJECT_DIR}/bin/rdl.js", "hook", "post-tool-use", "--client", "claude"],
                    "if": "Bash(git commit *)", "timeout": 30 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node",
                    "args": ["${CLAUDE_PROJECT_DIR}/bin/rdl.js", "hook", "stop", "--client", "claude"],
                    "timeout": 30 }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node",
                    "args": ["${CLAUDE_PROJECT_DIR}/bin/rdl.js", "hook", "session-end", "--client", "claude"],
                    "timeout": 30 }] }
    ]
  }
}
```

`command`와 `args`를 나눈 형식을 쓴다. 셸을 거치지 않고 직접 spawn하므로 따옴표·`$`·백틱이 든 경로가 셸 파서에 닿지 않는다. `if`는 권한 규칙 문법이며, 맞지 않는 호출에는 훅 프로세스를 아예 띄우지 않는다.

### Codex

`~/.codex/hooks.json`. 이벤트 이름은 Codex 표기를 따른다.

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node",
                    "args": ["<repo>/bin/rdl.js", "hook", "session-start", "--client", "codex"],
                    "timeout": 30 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node",
                    "args": ["<repo>/bin/rdl.js", "hook", "stop", "--client", "codex"],
                    "timeout": 30 }] }
    ]
  }
}
```

Codex는 훅 설정에 `trusted_hash`를 두므로 파일을 바꾸면 신뢰 확인을 다시 지날 수 있다. 등록 여부는 `~/.codex/hooks.json`의 존재로 판단한다 — 실행 파일이 설치돼 있어도 이 파일이 없으면 훅은 돌지 않는다.

## 걸지 않는 것

| 자리 | 이유 |
|---|---|
| `UserPromptSubmit` | 매 제출 동기 실행인데 그 시점에 판정할 사실이 없다. `SessionStart`와 `PostCompact`가 같은 값을 세션당 1~2회로 준다 |
| `PermissionRequest` | 감사 가치만 있고 Rundol이 답할 것이 없다 |
| `Notification`·`MessageDisplay` | 상태를 바꾸지 않는다 |
| `TaskCreated`·`TaskCompleted` | 하네스 태스크와 Rundol 태스크는 다른 축이다 |
| 셸 래퍼·alias·`PATH` 후킹 | OS 유닛을 설치하지 않는 것과 같은 규율이다. 강한 개입은 사람의 명시적 행위로만 놓인다 |

Rundol CLI는 클라이언트 훅을 **설치하지 않는다.** `rdl skill install`이 스킬만 배포하는 것과 같은 이유이며, 이 문서의 스니펫은 각 저장소가 직접 놓는다.
