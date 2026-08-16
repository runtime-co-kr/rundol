# Rundol 0.23 마이그레이션

이 문서는 `0.22.x`에서 `0.23.0`으로 올릴 때 필요한 작업을 다룬다. 데이터 변환은 없다. 바뀌는 것은 **설치 계약 하나**, 지원 Node 버전이다.

## 변경 요약

| 항목 | 0.22.8까지 | 0.23.0 |
|---|---|---|
| `engines.node` | `>=14` | `>=20` |
| 검증되는 Node | 20, 22 | 20, 22 |
| 설치 문서 안내 | 14 | 20 |

Workspace 파일, 문서 계약(`documentProfile` schemaVersion 2), 태스크 저장 형식, CLI 인자, Board API는 바뀌지 않는다. `rdl` 명령을 다시 실행할 필요도 없다.

## 왜 바뀌었나

`engines`는 `>=14`라고 적혀 있었지만 실제로는 지켜진 적이 없다.

- 직접 의존성 `marked`가 Node `>=20`을 요구한다.
- CI는 20과 22만 검증한다.
- 설치 문서는 14라고 안내했다.

셋이 서로 다른 말을 하면 "설치는 되는데 동작하지 않는" 조합이 생긴다. Node 14~19에서 `npm install`은 통과하고 `rdl`을 실행하는 순간 실패했다. `>=20`은 실제 동작 범위를 적은 것이지 기능을 줄인 것이 아니다. 그래도 `npm install`의 성공·실패가 달라지므로 호환성 파괴로 분류한다.

## 잘못 분류된 배포

`0.22.9`와 `0.22.10`은 이 변경을 담고도 PATCH로 배포되었고 CHANGELOG에도 적히지 않았다. [버전과 릴리스 정책](RELEASES.md)이 요구하는 MINOR 승급과 migration 명시를 지키지 않은 것이다. `0.23.0`은 같은 내용을 올바른 분류로 다시 낸다.

- Node 20 이상을 쓰고 있다면 `0.22.9`·`0.22.10`과 `0.23.0`의 동작은 같다. 그대로 `0.23.0`으로 올리면 된다.
- Node 20 미만에서 `0.22.8` 이하를 쓰고 있다면 아래 절차를 따른다.

## 1. 현재 Node 버전 확인

```powershell
node --version
```

`v20.0.0` 이상이면 3번으로 건너뛴다.

## 2. Node 20 이상 설치

Rundol은 Node 20 LTS와 22에서 검증한다. 둘 중 하나를 설치한다.

```powershell
winget install OpenJS.NodeJS.LTS
```

여러 버전을 함께 쓰고 있다면 버전 관리자에서 20 이상을 선택한다.

```bash
nvm install 20
nvm use 20
```

## 3. Rundol 업그레이드

```powershell
npm install -g rundol@0.23.0
rdl --version
```

## 4. 확인

프로젝트에서 검사와 경계를 한 번 돌린다. 데이터가 바뀌지 않았으므로 결과는 업그레이드 전과 같아야 한다.

```powershell
rdl check --strict --project <key>
rdl git boundary --project <key> --json
```

## 문제 해결

### `EBADENGINE` 경고 또는 오류가 난다

Node 20 미만이다. 2번으로 돌아간다. `npm config get engine-strict`가 `true`면 경고가 아니라 오류로 설치가 중단된다.

### 업그레이드 후 `rdl`이 예전 버전을 가리킨다

버전 관리자로 Node를 바꾸면 전역 패키지 경로도 함께 바뀐다. 새 Node에서 다시 설치한다.

```powershell
npm install -g rundol@0.23.0
```

### Node 20으로 올릴 수 없다

`0.22.8`에 머무른다. 그 버전은 `engines`가 `>=14`이지만 Node 20 미만에서 실제로 동작하지 않으므로, 고정하더라도 Node 20 이상에서 실행해야 한다.
