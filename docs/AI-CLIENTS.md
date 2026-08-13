# AI 클라이언트 지원

Rundol 거버넌스 스킬은 Agent Skills 형식의 `SKILL.md` 하나를 정본으로 사용한다. 클라이언트별로 규칙을 복제해 따로 수정하지 않는다.

제품 브랜치 루트에 `.rundol`이 없어도 정상이다. 스킬과 CLI는 Git 저장소의 원격을 식별한 뒤 `rdl attach [project-key]`로 `rundol/workspace` 및 `rundol/<project-key>`를 연결한다. 프로젝트별 `.rundol`은 로컬 실행 상태와 로그만 보관하며 Git에서 제외한다. 문서·태스크 작업 전에는 등록된 멤버, 역할, 이해관계자와 문서 경로를 CLI로 검증한다.

## 스킬 설치

전역 설치 후 `rdl skill install`을 실행하면 같은 스킬 디렉터리를 다음 위치에 설치한다. 개발 저장소에서는 `npm run skill:install`도 같은 동작을 한다.

```text
Codex         ~/.codex/skills/rundol-project-governance/
Claude Code   ~/.claude/skills/rundol-project-governance/
Copilot       ~/.copilot/skills/rundol-project-governance/
```

환경 변수로 홈을 바꿀 수 있다.

- Codex: `CODEX_HOME`
- Claude Code: `CLAUDE_CONFIG_DIR`
- Copilot용 Rundol 설치 override: `RUNDOL_COPILOT_HOME`

기존 디렉터리에 `.rundol-managed.json`이 없으면 사용자가 관리하는 스킬로 판단해 덮어쓰지 않는다. Rundol이 설치한 디렉터리만 다음 설치에서 갱신하며, 사용자 관리 스킬까지 교체하려면 `rdl skill install --force`를 사용한다.

설치는 npm `postinstall`로 자동 실행하지 않는다. 근거는 [CLI 명세의 거버넌스 스킬 설치](CLI.md#거버넌스-스킬-설치)에 있다.

CLI를 새 버전으로 갱신한 뒤에는 `rdl doctor`로 스킬 버전을 확인하고 `rdl skill install`을 다시 실행한다. Doctor가 사용자 관리 스킬로 판정한 디렉터리는 자동 교체하지 않으므로 내용을 검토한 뒤에만 `--force`를 사용한다.

## 프로젝트 공유

팀이 프로젝트 저장소 자체로 스킬을 공유하려면 동일한 `skills/rundol-project-governance/` 디렉터리 전체를 클라이언트의 프로젝트 스킬 경로에 복사한다.

- Claude Code: `.claude/skills/rundol-project-governance/`
- GitHub Copilot: `.github/skills/rundol-project-governance/`
- 그 밖의 Agent Skills 호환 도구: 해당 도구가 선언한 project skills 경로

Gemini CLI, Cursor 또는 `AGENTS.md` 기반 도구는 [클라이언트 호환성 레퍼런스](../skills/rundol-project-governance/references/client-compatibility.md)의 최소 어댑터를 프로젝트 instruction 파일에 연결한다. 어댑터는 발견 방식만 담당하고 실제 계약은 `SKILL.md`와 `references/governance-contract.md`를 읽는다.

## 검증

어떤 클라이언트에서 작업하더라도 완료 조건은 같다.

```bash
rdl action resolve document.create --json
rdl check --project <project-key> --strict
```

각 작업 전에 표준 action을 resolve하고 CLI 권장이면 해당 명령을 사용한다. LLM 또는 혼합 작업은 완료 뒤 `rdl action record`로 실제 executor와 artifact/task ID를 남긴다. 메타, 역할, 멤버, 이해관계자, 책임, 의사결정, 위험, 협업 리듬과 품질 게이트를 클라이언트별 편의를 이유로 생략할 수 없다.

설치 상태까지 함께 점검하려면 `rdl doctor`를 실행한다.
