# Rundol

Rundol은 IT 프로젝트의 분석·설계 문서, 역할·이해관계자와 태스크 상태를 Git에서 함께 관리하는 로컬 우선 Node.js CLI다. Markdown과 JSON을 실제 파일로 유지하므로 IDE, Obsidian과 AI 코딩 클라이언트가 같은 프로젝트 문맥을 읽을 수 있다.

Rundol은 특정 회사의 문서를 표준화하는 도구가 아니다. 프로젝트가 선택한 업무 내용을 보존하면서 메타데이터, 책임 구조, 문서 연결, 완료조건과 상태 동기화가 빠지지 않도록 공통 계약과 검증 도구를 제공한다.

## 핵심 모델

| 저장 위치 | Git 소유권 | 내용 |
|---|---|---|
| `rundol/workspace` | Workspace 브랜치 | 프로젝트 Registry, Client Registry, 임대 이벤트 |
| `projects/<key>/` | `rundol/<key>` | 프로젝트별 Obsidian Vault, 문서와 태스크 |
| `projects/<key>/.rundol/` | Git 비추적 | 프로젝트별 실행 상태와 진단 로그 |
| 제품 저장소 main | 제품 브랜치 | 제품 코드만 소유하며 Rundol 파일을 요구하지 않음 |

```text
repository/
├─ projects/
│  └─ memo/                        # rundol/memo linked worktree
│     ├─ .obsidian/                # 프로젝트 Vault 설정
│     ├─ project.md
│     ├─ docs/
│     ├─ tasks/<client-id>/000001.json
└─ src/
```

프로젝트별 브랜치는 일반 Git 브랜치이며 linked worktree를 통해 물리 파일로 보인다. 태스크·문서 index는 Watch 메모리에서 관리하고 debug·sync 로그는 프로젝트의 `.rundol/logs/`에 저장한다.

## 설치

Node.js 20+, npm 6+, Git 2.20+가 필요하다.

```bash
npm install --global rundol
rdl --version
rdl doctor
rdl skill install
```

- `rdl`이 기본 명령이며 `rundol`은 같은 실행 파일의 별칭이다.
- 통합 설치는 `npm install -g rundol`, 개별 설치는 `npm install -g @rundol/cli @rundol/node`를 사용한다.
- monorepo Git URL의 전역 설치는 지원하지 않는다. 폐쇄망이나 사전 검증 환경은 release tarball을 설치한다.
- AI 클라이언트 스킬은 npm `postinstall`과 분리되어 있다. CLI 설치 후 `rdl skill install`을 명시적으로 실행한다.
- registry, 폐쇄망 tarball, PATH와 손상된 설치 복구는 [Rundol 설치와 복구](docs/INSTALLATION.md)를 따른다.
- `0.21.1`부터 `0.22.2`를 `0.22.3`으로 올릴 때는 [Rundol 0.22 마이그레이션](docs/MIGRATION-0.22.md)을 먼저 따른다.
- `0.22.x`에서 `0.23.0`으로 올릴 때는 지원 Node가 20 이상으로 바뀌므로 [Rundol 0.23 마이그레이션](docs/MIGRATION-0.23.md)을 확인한다. 데이터 변환은 없다.
- `0.23.x`에서 `0.24.0`으로 올릴 때는 `documentProfile`이 저장하는 범위가 줄어들므로 [Rundol 0.24 마이그레이션](docs/MIGRATION-0.24.md)을 확인한다. 실행할 명령은 없다.

## 5분 시작

기존 Git 저장소 루트에서 첫 프로젝트를 만든다.

```bash
rdl init memo --name "메모 앱" --profile product
rdl check --project memo --strict
rdl board --project memo
```

`rdl init`은 먼저 로컬 manifest·ref·worktree와 원격 `rundol/*`를 읽기 전용으로 발견한다. 결과의 `action`은 `created`, `attached`, `repaired`, `already-connected`, `needs-selection`, `conflict` 중 하나다. 원격에 여러 프로젝트가 있으면 자동으로 첫 항목을 고르지 않으며 `--project <key>`로 다시 실행한다. 대화형 설정은 `--guided`, 자동화는 `--profile <lean|product|service|platform|assured>`을 사용한다.

`rdl init`은 다음을 만든다.

1. `projects/workspace/` Workspace worktree
2. `rundol/workspace`와 `rundol/memo` 브랜치
3. `projects/memo/` 프로젝트 Vault
4. 메타, 역할, 멤버, 이해관계자, 책임, 위험과 완료 정의가 있는 `project.md`

기존 원격 프로젝트는 main 변경 없이 연결한다.

```bash
rdl attach memo
```

문서 프로필은 `project.md`의 schemaVersion 2 계약으로 저장된다. 계약이 갖는 것은 유형별 `policy`와 `enforcement`, `revision`뿐이다. 프로필 프리셋과 유형별 하부 요소는 표시 설정과 같은 `board.json` 상속(내장 기본값 → Workspace → 프로젝트)이 정하므로 프로젝트마다 들고 다니지 않는다. `rdl contract show|next|check`는 CLI·스킬·Board가 공유하는 평가 결과를 제공하고, `rdl contract plan|set`은 영향 검토와 revision 기반 변경을 수행한다. 새 문서는 `docs/prd`, `docs/requirements`, `docs/architecture` 같은 정규 경로에 생성되며, 기존 루트 문서는 `rdl doc migrate` 계획을 검토한 뒤 적용한다.

같은 저장소에 프로젝트를 더 추가할 수 있다.

```bash
rdl project add tms --name "차량 관제"
rdl git init                       # settings와 등록 프로젝트 전체 연결 확인
```

## 일상 작업

```bash
# 프로젝트 문서를 표준 경로와 메타데이터로 생성
rdl doc create PRD "메모 제품 요구사항" --project memo --owner MEMBER-001 --scope "메모 제품의 문제와 성공 기준" --exclude "개별 기능 동작"
rdl doc create REQ "메모 검색" --project memo --owner MEMBER-001 --scope "메모 검색 동작" --exclude "작성과 삭제" --function-id MEM-01 --related PRD-001

# 태스크 생성과 상태 변경
rdl task add "검색 구현" --project memo --owner MEMBER-001 \
  --link REQ-001 --acceptance "제목과 본문으로 검색된다."
rdl task set TASK-... --project memo --status doing --owner MEMBER-001
rdl task acceptance TASK-... AC-001 --project memo --done

# 실행 주체 결정과 LLM·혼합 작업 기록
rdl action resolve document.edit --json
rdl action record document.edit --actual-executor hybrid --artifact-id REQ-001

# 로컬 검증·저장·원격 동기화
rdl check --project memo --strict
rdl save --project memo
rdl sync --project memo
rdl sync watch --project memo --interval 60

# 충돌과 설치 상태 확인
rdl conflict list --project memo
rdl doctor --json
```

`rdl board`는 `127.0.0.1`에서만 동작하는 로컬 웹 UI다. 태스크 검색·생성·편집·drag/drop, 역할·멤버·이해관계자 조회·수정과 3초 주기 외부 변경 감지를 제공한다.

## 명령 지도

| 목적 | 명령 |
|---|---|
| Workspace 연결·생성 | `rdl attach`, `rdl detach`, `rdl init`, `rdl project add` |
| 브랜치 연결·저장 | `rdl git init`, `rdl refresh`, `rdl save` |
| 문서·태스크 | `rdl doc create`, `rdl doc migrate`, `rdl project profile`, `rdl task add`, `rdl task set`, `rdl task acceptance`, `rdl task migrate` |
| 검증·정리 | `rdl check`, `rdl check --strict`, `rdl check --structure`, `rdl cleanup`, `rdl doctor` |
| 동기화·충돌 | `rdl sync`, `rdl sync watch`, `rdl conflict list|resolve|clear` |
| UI·연동 | `rdl board`, `rdl obsidian init`, `rdl skill install` |
| 진단·라우팅 | `rdl action resolve|record`, `rdl debug record`, `rdl debug summary` |

전체 인수와 출력 계약은 [CLI 기능 명세](docs/CLI.md)를 정본으로 사용한다.

## 문서 지도

| 문서 | 답하는 질문 |
|---|---|
| [Git 저장소 설치와 복구](docs/INSTALLATION.md) | 어떻게 설치·인증·진단·복구하는가? |
| [CLI 기능 명세](docs/CLI.md) | 어떤 명령과 옵션이 실제로 제공되는가? |
| [Board와 협업 API](docs/BOARD-API.md) | 멀티 프로젝트 UI와 Client·임대·동기화 API를 어떻게 사용하는가? |
| [Workspace 브랜치 규칙](docs/WORKSPACE-BRANCH.md) | main, settings와 프로젝트 브랜치는 무엇을 소유하는가? |
| [태스크 저장과 동기화](docs/TASK-STORAGE.md) | 1만 건 태스크를 어떻게 분할·병합하는가? |
| [문서 표준](docs/DOCUMENT-STANDARD.md) | PRD, REQ, ARC, SCR, MOD, API 등은 언제 만드는가? |
| [프로젝트 거버넌스](docs/PROJECT-GOVERNANCE.md) | 왜 역할·멤버·이해관계자와 책임을 생략하지 않는가? |
| [Obsidian 연동](docs/OBSIDIAN-INTEGRATION.md) | 팀 설정과 개인 Vault 설정은 어떻게 분리하는가? |
| [AI 클라이언트 지원](docs/AI-CLIENTS.md) | Codex, Claude Code, Copilot이 같은 규칙을 어떻게 쓰는가? |
| [버전과 릴리스](docs/RELEASES.md) | 버전을 언제 올리고 어떤 tag를 배포하는가? |
| [변경 이력](CHANGELOG.md) | 릴리스별로 무엇이 달라졌는가? |
| [패키지 아키텍처](docs/PACKAGE-ARCHITECTURE.md) | 통합·개별 패키지는 어떻게 나뉘는가? |

## 버전과 배포

Rundol은 SemVer `MAJOR.MINOR.PATCH`를 사용한다. 배포 횟수는 `PATCH`, 호환 기능 묶음은 `MINOR`, 호환성을 깨는 변경은 `MAJOR`로 표현한다. `0.1000.0`도 유효하지만 배포할 때마다 minor를 올리지 않는다.

```bash
npm run version:check
npm run release:check
```

정식 배포는 package version, CHANGELOG와 `vX.Y.Z` Git tag가 일치해야 한다. GitHub Actions가 main push와 pull request에서 테스트를, `v*` tag에서 전체 릴리스 검사를 실행한다. 상세 정책은 [버전과 릴리스](docs/RELEASES.md)를 따른다.

## 개발과 검증

```bash
node bin/rdl.js check --root test/fixtures/workspace --strict
npm link
npm test
npm run test:install
npm run release:check
```

Rundol은 외부 runtime dependency 없이 동작한다. 현재 제공하지 않는 기능과 명령별 종료 코드는 [CLI 기능 명세](docs/CLI.md#현재-제공하지-않는-기능)에서 관리한다.
