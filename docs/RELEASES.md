# 버전과 릴리스 정책

Rundol은 SemVer `MAJOR.MINOR.PATCH`와 `vMAJOR.MINOR.PATCH` Git tag를 사용한다. 버전 숫자는 배포 횟수가 아니라 호환성의 의미를 전달한다.

## 버전 증가 기준

| 변경 | 1.0 이전 | 1.0 이후 | 예시 |
|---|---|---|---|
| 호환되는 버그 수정, 문서·진단·테스트 보완 | `PATCH` | `PATCH` | `0.17.0 → 0.17.1` |
| 호환되는 새 명령·기능 묶음 | `MINOR` | `MINOR` | `0.17.1 → 0.18.0` |
| 저장 포맷·CLI·API의 호환성 파괴 | `MINOR`와 migration 명시 | `MAJOR` | `0.18.0 → 0.19.0`, `1.4.0 → 2.0.0` |

`0.x`는 아직 public contract가 안정화 중임을 뜻한다. 이 기간에도 호환성 파괴를 CHANGELOG와 migration 문서에 명시한다. `1.0.0`부터는 SemVer의 MAJOR 규칙을 엄격히 적용한다.

## 숫자 크기

SemVer의 각 숫자는 0 이상의 정수이므로 `0.1000.0`도 유효하다. 하지만 minor가 빠르게 커지는 것은 기술적 문제가 아니라 릴리스 분류가 잘못됐다는 신호일 수 있다.

- 같은 기능의 반복 배포·수정은 `PATCH`를 올린다.
- 사용자가 인식할 새 기능 묶음에서만 `MINOR`를 올린다.
- CI build 횟수와 날짜는 package version 숫자에 넣지 않는다.
- 검증 전 배포는 `0.18.0-alpha.1`, `0.18.0-beta.1`, `0.18.0-rc.1`처럼 prerelease를 사용한다.
- 같은 version을 다른 내용으로 다시 배포하지 않는다.

따라서 수백·수천 번 배포해도 문제가 없지만, 대부분은 patch 또는 prerelease 번호로 표현하는 것이 맞다.

## 배포 ref

| 설치 ref | 용도 | 안정성 |
|---|---|---|
| `#vX.Y.Z` | 정식 배포 | 변경되지 않는 권장 방식 |
| `#<commit-sha>` | 특정 검증 결과 재현 | 변경되지 않음 |
| `#main` | 최신 통합 상태 확인 | 새 merge마다 달라짐 |
| `#feat/...` | 개발·검토 | 정식 배포에 사용하지 않음 |

정식 배포는 tag가 필수다. `package.json` version만 바뀌었거나 main에 merge됐다는 이유만으로 release로 간주하지 않는다.

## 릴리스 절차

보호된 `main`을 직접 수정하지 않고 release MR을 사용한다.

1. 변경 유형에 따라 다음 version을 정한다.
2. `package.json`과 `CHANGELOG.md`를 같은 MR에서 갱신한다.
3. `npm run release:check`를 통과시킨다.
4. MR을 `main`에 병합한다.
5. maintainer가 병합 commit에 annotated tag를 만들고 push한다.
6. 배포 tarball 또는 registry package 설치와 `rdl doctor`를 smoke test한다.

```bash
git switch main
git pull --ff-only
git tag -a v0.17.0 -m "Rundol v0.17.0"
git push origin v0.17.0

npm install --global rundol@0.17.0
rdl --version
rdl doctor
```

tag는 package version과 정확히 같아야 한다. tag를 이동하거나 같은 version의 tag를 다시 만들지 않는다. 잘못된 release는 새 patch version으로 수정한다.

## 자동 검증

```bash
npm run version:check
npm run release:check
```

`version:check`는 SemVer 형식, private monorepo 경계, package name 고유성, CHANGELOG 항목, `postinstall` 부재와 CI tag 일치를 검사한다. `release:check`는 여기에 전체 테스트와 통합·개별 package tarball 설치 회귀 테스트를 더한다.

`.gitlab-ci.yml`은 일반 branch와 MR에서 `version:check`와 전체 테스트를 실행한다. 열린 MR이 있으면 같은 commit의 push pipeline을 중복 생성하지 않고 MR pipeline 하나만 사용한다. tag pipeline에서는 `CI_COMMIT_TAG`와 package version 일치를 포함한 `release:check`를 실행한다. pipeline 통과가 tag 생성을 대신하지는 않으며, 정식 배포 ref는 여전히 maintainer가 만든 변경 불가능한 tag다.

현재 자동 npm registry publish는 제공하지 않는다. registry를 사용하게 되면 같은 Git tag와 npm package version을 하나의 release pipeline에서 생성해야 한다.
