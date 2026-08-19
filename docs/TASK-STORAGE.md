# 프로젝트 자료와 태스크 저장

제품 개발 브랜치는 Rundol 파일을 소유하지 않는다. 공통 Registry와 협업 이벤트는 `rundol/workspace`, 각 프로젝트의 문서와 태스크는 `rundol/<project-key>`가 소유한다.

```text
rundol/workspace → projects/workspace/
├─ workspace.yaml
├─ clients/
├─ projects/
└─ events/

rundol/crm → projects/crm/
├─ .gitignore
├─ project.md
├─ docs/
└─ tasks/<client-id>/<segment>.json
```

새 프로젝트는 하나의 대형 `tasks.json` 대신 `tasks/<client-id>/<segment>.json`을 사용한다. segment는 기본 500건까지 저장한다. Client ID는 Workspace Registry에서 공유하고 프로젝트 로컬 기본값은 `.rundol/state/client-id`에 보관한다.

- 서로 다른 Client가 태스크를 만들면 서로 다른 샤드를 수정한다.
- 같은 태스크의 동시 변경은 Git 충돌로 드러난다.
- 태스크 ID는 전역 고유 ID이며 Client ID와 별개다.
- 태스크는 `kind`로 종류를 갖는다. `normal`이 기본이고 `test`는 TST 문서의 시나리오를 수행한 실행이다. 값이 없는 옛 태스크는 `normal`로 읽는다.
- 테스트 태스크는 `result`로 판정을 갖는다. 판정은 진행 상태와 다른 축이다 — 실패한 테스트도 수행은 끝났으므로 상태는 `done`이고 판정이 `fail`이다. 두 축을 한 필드에 두면 실패를 확인한 테스트와 아직 돌리지 않은 테스트를 구분할 수 없다.
- 테스트 태스크는 `round`로 실행 차수를 갖는다. 1부터 시작하는 프로젝트 전역 정수이며, `(TST 문서 × 차수)` 하나에 태스크 하나다. 반려한 태스크는 그 자리를 비운다.
- 차수를 정수로 두는 이유는 표기가 갈리지 않게 하려는 것이다. 문자열이면 `2차`, `2차 `, `R2`가 서로 다른 회차가 되어 모아 세는 일이 불가능해진다. "지금 몇 차인가"도 따로 저장하지 않고 태스크들의 최댓값이 답한다.
- 차수의 대상 목록은 저장하지 않는다. 태스크를 만든 것이 곧 그 차수의 범위이고, 빠진 것은 TST 문서 전체와 대조해 계산한다.
- 재실행은 새 태스크가 아니라 같은 태스크의 판정이 바뀌는 일이다. 발견한 결함은 별도의 일반 태스크가 나르고 그 테스트 태스크의 선행으로 연결한다.
- Board index는 Watch 메모리에서 계산한다.
- 현재 구현의 호환 projection은 `.rundol/state/tasks.json`이며 Git에서 제외한다.
- 문서는 Markdown 파일 단위 원본을 유지한다.

프로젝트별 로컬 실행 상태:

```text
projects/<project-key>/.rundol/
├─ state/
│  ├─ client-id
│  ├─ watch.lock
│  └─ pending/
└─ logs/
   ├─ debug.jsonl
   └─ sync.jsonl
```

`.rundol/`은 삭제 가능한 실행 상태와 진단 정보만 포함하며 프로젝트 `.gitignore`에서 제외한다. 문서, 태스크, Client Registry와 공유 임대 이벤트를 넣지 않는다.

```bash
rdl task migrate --project crm --client-id laptop-a --max-items 500
rdl sync --watch --project crm --interval 15
```

미전송 변경은 별도 복제본이 아니라 Git working tree와 로컬 commit에 남는다. Sync는 Workspace를 먼저 동기화한 뒤 프로젝트를 처리하며, 충돌 정보는 프로젝트 `.rundol/state/pending/`에 보존한다.
