# 패키지 아키텍처

Rundol은 하나의 npm workspaces 모노레포에서 동일 버전으로 릴리스한다. 저장소 루트는 개발·검증·릴리스 명령만 소유하는 비공개 오케스트레이션 패키지다.

```text
@rundol/monorepo (private)
└─ packages/
   ├─ @rundol/core
   ├─ @rundol/protocol
   ├─ @rundol/cli
   ├─ @rundol/node
   ├─ @rundol/board
   └─ rundol
```

## 경계

- 루트 이름은 `@rundol/monorepo`이고 `private: true`다.
- 루트는 `bin`과 배포용 `files`를 갖지 않는다.
- unscoped package name `rundol`은 `packages/rundol`만 소유한다.
- `rundol`은 `@rundol/cli`와 `@rundol/node`를 묶는 통합 배포 패키지다.
- `@rundol/cli`는 `rdl`, `rundol` executable을 제공한다.
- `@rundol/node`는 `rundol-node` executable을 제공한다.
- 모든 workspace package는 같은 release version을 사용하고 내부 의존성도 그 정확한 버전을 가리킨다.

## 설치 계약

통합 설치:

```bash
npm install --global rundol
rdl --version
rundol-node --version
```

개별 설치:

```bash
npm install --global @rundol/cli @rundol/node
rdl --version
rundol-node --version
```

monorepo 루트의 Git URL 전역 설치는 지원하지 않는다. npm은 workspace와 같은 이름의 package를 임시 Git clone에 연결한 뒤 clone을 제거할 수 있어 dangling Junction 또는 symlink를 남길 수 있다.

폐쇄망에서는 의존 순서대로 tarball을 만들고 사설 registry에 게시하거나 검증된 bundle로 전달한다.

```text
@rundol/core → @rundol/protocol → @rundol/cli, @rundol/node → rundol
```

## 배포물 구성

`@rundol/cli`는 저장소를 그대로 싣지 않고 `prepack`이 `dist/`를 만들어 싣는다. 순서가 중요하다 — 편집기 번들을 먼저 만들고 `src`를 복사한다. 복사한 뒤에 만들면 배포물에는 번들이 빠진 채로 남고, 그 사실은 설치한 사람이 문서를 편집하려 할 때에야 드러난다.

1. `scripts/build-editor.js` → `src/board-ui/generated/`. 보드의 문서·댓글 편집기 번들이다. 없으면 편집이 평문 입력칸으로 떨어진다.
2. `scripts/build-licenses.js` → `THIRD-PARTY-LICENSES.txt`. 번들에 들어간 제3자 코드의 고지다. ProseMirror·remark 계열은 소스에 파일별 라이선스 헤더가 없어 번들러가 옮길 것이 없고, 헤더가 없다는 사실이 고지 의무를 없애 주지는 않는다.
3. `bin`, `src`, `docs`, `skills`, `scripts`를 `dist/`로 복사하고 고지 파일을 함께 넣는다.

두 생성물은 Git에 담지 않는다. 저장소 루트에서도 `npm run build:editor`, `npm run build:licenses`로 같은 것을 만들 수 있고 `prepare`가 그 둘을 부른다. 번들 의존을 바꿨다면 고지도 다시 만들어야 한다 — 목록이 낡으면 배포물이 싣지 않은 것을 고지하거나 실은 것을 고지하지 않는다.

## 검증

`npm run version:check`는 다음을 검사한다.

- 루트 private monorepo 이름과 경계
- workspace package name 중복
- `rundol` 이름의 단일 소유권
- 동일 release version
- `postinstall` 부재
- CHANGELOG와 tag 일치

`npm run test:install`은 package를 tarball로 만든 뒤 임시 prefix에서 통합 설치와 개별 설치의 executable을 실행한다. 실제 사용자 홈, 전역 npm prefix 또는 전역 스킬 디렉터리는 변경하지 않는다.
