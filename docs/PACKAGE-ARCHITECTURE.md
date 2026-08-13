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

## 검증

`npm run version:check`는 다음을 검사한다.

- 루트 private monorepo 이름과 경계
- workspace package name 중복
- `rundol` 이름의 단일 소유권
- 동일 release version
- `postinstall` 부재
- CHANGELOG와 tag 일치

`npm run test:install`은 package를 tarball로 만든 뒤 임시 prefix에서 통합 설치와 개별 설치의 executable을 실행한다. 실제 사용자 홈, 전역 npm prefix 또는 전역 스킬 디렉터리는 변경하지 않는다.
