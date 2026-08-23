# Workspace와 프로젝트 브랜치

Rundol은 제품 코드, Workspace 공통 정보와 프로젝트 정본의 소유권을 분리한다.

```text
main                         # 제품 코드
rundol/workspace             # 프로젝트·Client Registry와 공유 협업 이벤트
rundol/<project-key>         # 프로젝트별 문서와 태스크
```

linked worktree는 저장소 안에 물리 파일을 제공한다.

```text
repository/
├─ projects/
│  ├─ workspace/             # rundol/workspace
│  ├─ crm/                   # rundol/crm
│  └─ tms/                   # rundol/tms
└─ .rundol/worktrees/
   └─ <id8>/                 # session/<id8> — 코드 작업
```

worktree 경로는 제품 브랜치의 `.gitignore`가 숨긴다. 규칙은 둘이다.

```text
/projects/*/
.rundol/
```

`/projects/*/`는 프로젝트 문서와 태스크 정본 worktree를, `.rundol/`은 코드 작업 worktree와 로컬 실행 상태를 숨긴다.

로컬 `.git/info/exclude`에 두지 않는 이유는 clone이다. 그 파일은 복제되지 않으므로 새로 clone한 사람은 `rdl attach`를 지나기 전까지 규칙을 갖지 못하고, 그 사이의 `git add -A` 한 번이 worktree 전체를 커밋한다. `.gitignore`는 clone과 함께 온다.

제품 브랜치에 Rundol loader는 두지 않는다.

Workspace 구조:

```text
projects/workspace/
├─ workspace.yaml
├─ clients/client-<client-id>.yaml
├─ projects/project-<project-key>.yaml
└─ events/lease-<scope-id>-<client-id>-<segment>.jsonl
```

각 프로젝트는 Git에서 제외되는 로컬 실행 경로만 가진다.

```text
projects/<project-key>/.rundol/
├─ state/
└─ logs/
```

`rdl attach`는 `rundol/workspace`를 우선 fetch한다. 없으면 전환 기간 동안 `rundol/settings`를 읽는다. `rdl workspace migrate`는 schema 5 Registry를 schema 6 `rundol/workspace`로 복사하지만 기존 settings 브랜치는 삭제하지 않는다.

`rdl sync`는 Workspace를 먼저 동기화한 뒤 선택 프로젝트를 fetch·병합·검증·push한다. 강제 push는 사용하지 않는다.
