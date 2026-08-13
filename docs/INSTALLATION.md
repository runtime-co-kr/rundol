# Rundol 설치와 복구

## 요구사항

- Node.js 14 이상
- npm 6 이상
- Git 2.20 이상

## 공식 설치

통합 패키지는 CLI와 Node 실행 파일을 함께 제공한다.

```powershell
npm install --global rundol
rdl --version
rundol-node --version
rdl doctor --json
```

CLI와 Node를 따로 설치할 수도 있다.

```powershell
npm install --global @rundol/cli @rundol/node
rdl --version
rundol-node --version
```

스킬 설치는 핵심 CLI 설치와 분리된다.

```powershell
rdl skill install
```

## 지원하지 않는 설치

monorepo Git URL을 `npm install --global git+https://...`에 직접 전달하는 방식은 지원하지 않는다. workspace package가 npm 임시 clone을 가리키는 Junction 또는 symlink로 설치된 뒤 clone이 삭제될 수 있다.

소스 commit을 검증해야 할 때는 CI가 해당 commit에서 생성한 package tarball을 사용한다.

## 폐쇄망 설치

연결된 빌드 환경에서 release tarball과 checksum을 생성하고 반입 승인을 받은 뒤 폐쇄망으로 전달한다. 내부 package는 다음 순서로 pack 또는 publish한다.

```text
@rundol/core → @rundol/protocol → @rundol/cli, @rundol/node → rundol
```

사설 registry를 사용하는 경우:

```powershell
npm config set registry https://registry.example.internal/
npm install --global rundol
```

검증된 통합 tarball을 사용하는 경우:

```powershell
npm install --global .\rundol-0.21.1.tgz
rdl --version
rdl doctor --json
```

통합 tarball이 내부 dependency를 bundle하지 않았다면 모든 `@rundol/*` tarball을 먼저 사설 registry에 게시해야 한다. 단일 tarball만 복사하고 dependency 해결을 생략해서는 안 된다.

## 깨진 이전 설치 복구

다음 오류는 오래된 shim 또는 dangling package link를 의미한다.

```text
Cannot find module '<prefix>\node_modules\rundol\bin\rdl.js'
```

먼저 실제 경로를 확인한다.

```powershell
where.exe node
where.exe npm
where.exe rdl
npm prefix --global
npm root --global
Get-Command rdl -All | Select-Object CommandType, Source
```

그다음 현재 npm prefix의 이전 설치를 제거하고 공식 package를 다시 설치한다.

```powershell
$rundolPrefix = npm prefix --global
npm uninstall --global rundol @rundol/cli @rundol/node

Remove-Item "$rundolPrefix\rdl.cmd" -Force -ErrorAction SilentlyContinue
Remove-Item "$rundolPrefix\rdl.ps1" -Force -ErrorAction SilentlyContinue
Remove-Item "$rundolPrefix\rundol.cmd" -Force -ErrorAction SilentlyContinue
Remove-Item "$rundolPrefix\rundol.ps1" -Force -ErrorAction SilentlyContinue
Remove-Item "$rundolPrefix\rundol-node.cmd" -Force -ErrorAction SilentlyContinue
Remove-Item "$rundolPrefix\rundol-node.ps1" -Force -ErrorAction SilentlyContinue

npm install --global rundol
rdl --version
rdl doctor --json
```

여러 Node.js 배포판이 PATH에 있으면 설치에 사용한 `npm prefix --global`과 `where.exe rdl`이 같은 경계를 가리켜야 한다. PATH 변경 후에는 새 터미널을 연다.

## 진단 범위

`rdl doctor --json`은 다음을 확인한다.

- Node.js, npm, Git 버전
- 설치 package의 핵심 파일
- PATH에서 발견되는 Rundol executable
- 선택적 스킬 상태
- 현재 위치의 Workspace 여부

`rdl` 진입점 자체가 없으면 doctor도 실행할 수 없으므로 `where.exe rdl`, `npm prefix --global`, package 파일 존재 여부부터 확인한다.
