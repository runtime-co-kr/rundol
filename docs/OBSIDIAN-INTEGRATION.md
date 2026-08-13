# Obsidian 연동

Rundol의 원본은 Markdown, JSON과 Git이다. Obsidian은 선택적 편집 클라이언트이며 프로젝트 하나를 Vault 하나로 취급한다.

## Vault 경로

Obsidian에서 저장소 루트가 아니라 다음 프로젝트 경로를 연다.

```text
<repository>/projects/<project-key>/
```

```text
projects/<project-key>/          # rundol/<project-key> worktree 및 Vault
├─ .obsidian/                    # 공유 가능한 최소 프로젝트 설정
├─ project.md
├─ docs/
└─ tasks/<client-id>/*.json
```

`rdl obsidian init --project <key>`는 `.obsidian` 기본 설정을 해당 Vault에 설치한다. `--force`가 없으면 기존 설정을 보존한다.

## 공용 설정과 개인 상태

프로젝트 브랜치에서 공유할 수 있는 최소 파일은 `app.json`, `core-plugins.json`, `graph.json`, `templates.json`이다. `workspace.json`, 열린 탭, 최근 파일, cache, 개인 hotkey와 plugin data는 Git에서 제외한다.

Graph view는 Obsidian 기본 기능이다. 문서 링크는 실제 파일명을 사용하고 멤버·역할·이해관계자는 `project.md` block ID로 연결한다. 태그는 `rundol/`, `artifact/`, `domain/`, `feature/` namespace를 사용한다.

## 연결과 검증

```bash
rdl attach memo
rdl obsidian init --project memo
rdl check --project memo --strict
rdl check --structure --project memo
```

태스크 원본은 Vault의 `tasks/<client-id>/*.json`이다. 실행 상태와 debug log는 Vault의 Git 비추적 `.rundol/state`, `.rundol/logs`에 저장한다.

Rundol은 Obsidian 실행 파일이나 소스를 포함하지 않는다. Markdown, YAML frontmatter, Wiki link, tag와 설정 JSON만 관리한다.
