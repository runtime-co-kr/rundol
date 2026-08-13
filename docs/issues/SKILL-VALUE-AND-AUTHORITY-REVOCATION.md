# Rundol 핵심 안전 구조 — 스킬 경유 AI 변경과 Git 권한 회수

## 문서 정보

| 항목 | 값 |
|---|---|
| 상태 | Draft |
| 목적 | AI가 원본 Git을 직접 변경해 발생하는 사고를 방지하고, 스킬을 통해서만 검증된 변경 제안을 생성·반영하는 구조 정의 |
| 담당자 | 미정 — 제품 책임자가 구현 이슈 등록 시 지정 |
| 리뷰어 | 미정 — Git, Skill Runtime, Security 담당자가 지정 |
| 결정권자 | 미정 — 제품·기술 책임자가 안전 경계와 적용 정책 승인 |
| 주요 이해관계자 | 로컬 사용자, 저장소 관리자, 폐쇄망 운영자, AI Client 운영자, 보안 담당자 |

## 핵심 요구

> AI는 원본 Git 저장소를 직접 건드리지 않는다. AI가 만드는 모든 변경은 Rundol 스킬이 제공하는 제한된 작업공간에서 생성되고, 검증된 제안으로만 원본에 반영된다.

여기서 중요한 것은 AI에게 “조심해서 Git을 사용하라”고 프롬프트로 지시하는 것이 아니다. AI 프로세스가 실수하거나 지시를 무시해도 원본 저장소를 변경할 수 없도록 기술적으로 권한을 제거해야 한다.

## 전역 허용보다 스킬 제한 우선

호스트 사용자나 AI Client에 전역 Git 실행 허용이 있더라도, Rundol Skill Run에는 그 권한을 자동 상속하지 않는다. 최종 권한은 합집합이 아니라 교집합으로 계산한다.

```text
EffectivePermission
  = Host가 제공할 수 있는 권한
  ∩ Rundol 시스템 정책이 허용한 권한
  ∩ 프로젝트 정책이 허용한 권한
  ∩ Skill manifest가 요구·허용한 권한
  ∩ 현재 Run에서 사용자가 승인한 권한
  - 어느 계층에서든 명시적으로 deny한 권한
```

정책 우선순위는 다음과 같다.

1. `deny`는 모든 `allow`보다 우선한다.
2. 하위 범위는 상위 허용을 확대할 수 없고 축소만 할 수 있다.
3. 전역 승인과 과거 승인은 새 Skill Run에 암묵적으로 상속되지 않는다.
4. 스킬에 `git: deny`가 있으면 전역에서 Git이 허용돼도 해당 Run에서는 Git 실행과 `.git` 접근을 차단한다.
5. 스킬이 Git을 요구해도 시스템 또는 프로젝트 정책이 거부하면 실행하지 않는다.
6. 정책 충돌이나 해석 실패는 `fail-closed`로 처리한다.

단, 이 우선순위를 AI Client의 승인 설정이나 프롬프트만으로 구현하면 안 된다. Skill Broker가 별도의 제한된 OS 보안 주체로 AI를 실행하고 파일 시스템, 프로세스, 자격증명과 네트워크 권한을 실제로 제거해야 한다.

## 보호 대상

- 원본 working tree와 index
- `.git` 디렉터리, refs, HEAD, config, hooks와 object database
- 보호 브랜치와 원격 저장소
- GitLab/GitHub 토큰, SSH key와 credential helper
- Rundol 정본 문서, 태스크, 결정 및 검증 기록
- 사용자의 미커밋 변경과 stash

## 방지하려는 사고

- AI가 원본 파일을 덮어쓰거나 삭제
- 의도하지 않은 `git add`, `commit`, `merge`, `rebase`, `reset`
- 강제 push 또는 잘못된 브랜치로 push
- 사용자의 미커밋 변경 유실
- `.git/config`, hooks 또는 refs 변조
- 다른 프로젝트나 저장소까지 탐색·수정
- 검토되지 않은 AI 결과가 정본 문서나 태스크 상태로 확정
- 권한 회수 후에도 기존 세션이 계속 파일을 수정하거나 Git 명령 실행

---

# 1. 신뢰 경계

## 신뢰하는 구성요소

- Rundol Node의 Skill Broker
- 정책 평가기와 권한 집행기
- Snapshot Builder
- Patch Collector와 Validator
- 사용자 승인 UI/CLI
- 승인된 변경을 원본에 적용하는 Apply Service

## 신뢰하지 않는 구성요소

- Codex, Claude Code, Gemini CLI 등 AI Client 프로세스
- AI가 생성한 셸 명령과 스크립트
- 외부에서 가져온 스킬 본문과 종속 도구
- AI가 생성한 패치, 파일과 Git 메시지

AI Client는 유용하지만 권한 관점에서는 비신뢰 실행기로 취급한다. 스킬도 설치되었다는 이유만으로 신뢰하지 않고 manifest, 출처, version, 요구 권한과 실행 정책을 검증한다.

---

# 2. 권장 실행 구조

```text
원본 Git 저장소
  │  AI 직접 접근 금지
  │
  ├─ Snapshot Builder ── 읽기 전용 입력 스냅샷
  │                          │
  │                    격리 작업 디렉터리
  │                          │
  │                    AI + 승인된 Skill
  │                          │
  │                    변경 파일/패치 출력
  │                          │
  └─ Apply Service ← Validator ← Proposal Bundle
          │              │
          │              └─ 테스트·정책·범위·비밀정보 검사
          │
          └─ 사용자 승인 후 원본에 원자적 반영
```

## 원칙

1. AI 프로세스에는 원본 저장소 경로를 mount하지 않는다.
2. 원본 `.git`은 AI의 파일 시스템 namespace에서 보이지 않아야 한다.
3. AI에게 Git 원격 자격증명과 SSH agent를 전달하지 않는다.
4. AI의 출력은 commit이 아니라 Proposal Bundle이다.
5. 원본 반영 권한은 AI가 아니라 신뢰된 Apply Service만 가진다.
6. Apply 직전에 원본 revision과 사용자 변경 여부를 다시 검사한다.
7. 반영은 사용자 승인, 자동 정책 또는 둘의 조합으로 결정한다.

## 전역 권한 비상속 구현

- AI 프로세스를 Rundol Node와 다른 제한 사용자, restricted token 또는 sandbox identity로 실행한다.
- 원본 저장소 ACL은 해당 실행 identity에 거부하거나 원본 자체를 namespace 밖에 둔다.
- 부모 프로세스의 Git credential 환경변수, credential helper, SSH agent socket과 인증서 저장소 접근을 전달하지 않는다.
- 환경변수와 `PATH`를 allowlist 방식으로 새로 구성한다.
- `git.exe` 이름만 막지 않는다. 다른 바이너리, 라이브러리 또는 직접 파일 쓰기로 `.git`을 변경할 수 없도록 파일 시스템 경계에서 차단한다.
- 전역 도구 승인 상태와 Rundol Skill Run의 capability 저장소를 분리한다.
- Apply Service는 AI 프로세스의 하위 프로세스로 실행하지 않고 별도 신뢰 경계에서 동작한다.
- Windows에서는 제한 토큰·Job Object·ACL 또는 AppContainer 수준의 조합을 검토하고, 단순 셸 wrapper를 보안 경계로 간주하지 않는다.

## Git worktree에 대한 판단

일반 Git worktree는 원본 저장소의 object database와 refs를 공유한다. 따라서 AI가 `.git` 연결 정보나 Git 명령에 접근할 수 있다면 ref 변경 등 사고 범위가 남는다.

- 낮은 위험의 보조 작업: 별도 worktree와 제한된 명령 allowlist를 사용할 수 있다.
- 원본 Git 보호가 핵심인 기본 모드: 공유 `.git`이 없는 임시 파일 스냅샷 또는 격리 clone을 사용한다.
- 격리 clone을 쓰더라도 remote URL과 credential은 제거하고 push를 불가능하게 한다.

---

# 3. 스킬의 역할

스킬은 AI에게 더 많은 권한을 주는 플러그인이 아니라, AI 작업을 제한된 절차로 바꾸는 실행 계약이다.

## 스킬 manifest 필수 항목

```yaml
id: skill:document-update
version: 1.0.0
inputScopes:
  - docs/**/*.md
outputScopes:
  - docs/**/*.md
operations:
  - read
  - propose-write
commands:
  allow:
    - markdownlint
network: deny
git: deny
secrets: deny
requiresApproval: before-apply
```

## 스킬 실행 단계

1. 태스크와 완료조건을 선택한다.
2. Skill Broker가 manifest와 정책을 평가한다.
3. 필요한 파일만 읽기 전용 스냅샷으로 만든다.
4. 짧은 TTL의 실행 capability를 발급한다.
5. AI를 격리 작업공간에서 실행한다.
6. 선언 범위를 벗어난 읽기·쓰기·명령을 차단한다.
7. 출력 파일과 patch를 Proposal Bundle로 수집한다.
8. 테스트, lint, schema, secret, 경로 및 정책 검사를 수행한다.
9. 사용자에게 diff, 근거, 검증 결과와 위험을 보여준다.
10. 승인된 변경만 Apply Service가 원본에 반영한다.
11. 실행 capability를 폐기하고 작업공간을 닫는다.

## 스킬 활용성 증명

스킬의 활용성은 “호출 성공”이 아니라 Git 사고 방지와 결과 품질로 증명한다.

- AI가 원본 `.git`과 원격 자격증명에 접근하지 못했다.
- 선언된 파일과 명령 범위 밖의 작업이 차단됐다.
- 결과가 원본에 자동 확정되지 않고 검토 가능한 diff로 생성됐다.
- 완료조건과 검증을 통과한 변경만 적용됐다.
- 어느 스킬과 정책이 어떤 변경을 만들었는지 추적할 수 있다.
- 스킬 없이 AI가 원본을 직접 다루는 방식보다 사고 가능성과 검토 비용이 감소했다.

---

# 4. 권한 부여와 회수

## 권한 모델

AI에게 저장소 권한을 부여하지 않는다. Skill Broker가 다음 범위의 일회성 capability만 발급한다.

- 특정 Run
- 특정 스킬 version
- 특정 입력 파일 집합
- 특정 출력 경로 패턴
- 허용된 명령 목록
- 만료 시간
- CPU, 메모리, 실행 시간과 출력 크기 제한

`요청 → 정책 평가 → capability 발급 → 실행 → 만료/회수 → 차단 검증`

## 회수 시 실제로 해야 하는 일

권한 회수는 상태값 변경만으로 완료되지 않는다.

1. 신규 Skill Run 생성을 거부한다.
2. 활성 AI 프로세스와 하위 프로세스를 종료한다.
3. 파일 handle과 IPC 채널을 닫는다.
4. 실행 capability와 세션 키를 폐기한다.
5. 임시 작업공간을 읽기 전용으로 전환하거나 격리한다.
6. 미적용 Proposal을 `revoked` 상태로 바꾸고 적용을 금지한다.
7. 승인 대기 중이던 diff의 승인 토큰을 무효화한다.
8. Apply Service가 Run 상태와 capability를 재검증하게 한다.
9. 회수 이후 쓰기·명령·apply 시도를 감사 로그에 남긴다.

## 오프라인·폐쇄망 정책

- capability는 로컬에서 검증 가능한 서명 또는 MAC을 가진다.
- 짧은 TTL을 기본으로 하고 갱신은 Skill Broker가 있을 때만 허용한다.
- 회수 이벤트를 받지 못한 Client도 TTL이 지나면 fail-closed로 중단한다.
- 시스템 시간 조작을 고려해 monotonic clock과 발급 세션 상태를 함께 사용한다.
- 중앙 서버가 없어도 각 Rundol Node가 자신이 발급한 capability와 실행 프로세스를 회수할 수 있어야 한다.

## 회수의 한계

이미 외부로 유출된 Secret이나 네트워크로 전송된 데이터는 로컬 권한 회수만으로 되돌릴 수 없다. 그래서 기본 정책은 처음부터 AI에 Secret과 외부 네트워크 권한을 주지 않는 것이다. 꼭 필요한 경우에는 범위가 좁고 수명이 짧은 대체 자격증명을 사용한다.

---

# 5. Proposal Bundle

AI 결과는 다음 구조로 보관한다.

```text
proposal/<run-id>/
├─ manifest.json
├─ changes.patch
├─ files/
├─ validation.json
├─ provenance.json
└─ approval.json
```

## 필수 메타데이터

- 원본 repository ID와 base commit
- task ID와 완료조건
- skill ID, version과 출처
- AI Client와 model 식별 정보
- 입력 파일 목록과 hash
- 요구 권한, 승인 권한과 실제 사용 권한
- 변경 파일, patch와 삭제 목록
- 실행한 검증과 결과
- 생성, 승인, 회수 및 적용 시각
- 담당자, 리뷰어와 최종 승인자

## 적용 전 검증

- base commit이 현재 원본과 같은지 확인
- 사용자의 미커밋 변경과 충돌 여부 확인
- 허용된 output scope 밖 변경 거부
- `.git`, credential, hook과 정책 파일 변경 거부
- symlink, path traversal과 대소문자 우회 검사
- Secret 및 악성 명령 삽입 검사
- schema, lint, test와 프로젝트 완료조건 검증
- 승인 이후 patch가 바뀌지 않았는지 hash 확인

---

# 6. MVP 완료조건

## 기능 증명

- [ ] AI 프로세스에서 원본 저장소 경로와 `.git`이 보이지 않는다.
- [ ] AI 프로세스에 Git 원격 자격증명과 SSH agent가 전달되지 않는다.
- [ ] AI는 원본 commit·branch·tag·remote를 변경할 수 없다.
- [ ] 모든 AI 변경은 Proposal Bundle로만 생성된다.
- [ ] 허용 범위 밖 파일 변경과 명령 실행이 차단된다.
- [ ] 사용자가 diff와 검증 결과를 승인해야 원본에 반영된다.
- [ ] 원본 revision이 바뀌면 기존 승인이 무효화되고 재검토를 요구한다.
- [ ] 호스트와 AI Client 전역에서 Git 실행을 허용해도 `git: deny` Skill Run은 Git과 원본 `.git`에 접근하지 못한다.
- [ ] 전역에서 승인된 `git push`, 셸 및 파일 쓰기 권한이 새 Run에 자동 상속되지 않는다.
- [ ] 스킬 또는 Run이 시스템·프로젝트 정책보다 넓은 권한을 요청하면 실행 전에 거부된다.

## 회수 증명

- [ ] 스킬, Agent 또는 Run 권한을 각각 회수할 수 있다.
- [ ] 회수 시 활성 프로세스와 하위 프로세스가 종료된다.
- [ ] 회수된 Run의 Proposal은 Apply Service가 거부한다.
- [ ] TTL 만료 후 오프라인 Client가 fail-closed로 동작한다.
- [ ] 회수 직전 발급된 승인 토큰과 capability의 재사용이 거부된다.
- [ ] 회수 후 발생한 모든 접근 시도가 감사 기록에 남는다.

## 사고 주입 테스트

- [ ] AI가 `git reset --hard`, `git push --force`, `.git/config` 수정을 시도해도 원본에 영향이 없다.
- [ ] AI가 `../` 경로, symlink와 junction으로 원본에 접근하려는 시도가 차단된다.
- [ ] AI가 하위 프로세스를 남긴 상태에서 회수해도 이후 쓰기가 불가능하다.
- [ ] 사용자가 원본을 수정한 뒤 오래된 Proposal을 적용하면 안전하게 거부된다.
- [ ] Apply 도중 실패해도 원본이 부분 적용 상태로 남지 않거나 복구 가능하다.
- [ ] AI Client의 전역 승인 목록에 Git 명령을 추가한 뒤에도 Skill Run의 deny 정책이 유지된다.
- [ ] 부모 프로세스에 SSH agent와 Git credential이 있어도 자식 AI 프로세스에서 사용할 수 없다.
- [ ] `git.exe` 이외의 프로그램으로 `.git/refs`와 원본 파일에 직접 쓰려는 시도가 차단된다.
- [ ] 정책 파일 누락, 손상 또는 버전 불일치 시 권한을 확대하지 않고 실행을 중단한다.

---

# 7. 구현 우선순위

## 1단계 — 원본 Git 비접근 보증

- Snapshot Builder
- 격리 작업 디렉터리
- Git/credential/network deny
- Patch Collector

## 2단계 — 스킬 계약과 검증

- Skill manifest
- 입력·출력 scope 집행
- Proposal Bundle
- Validator와 사용자 diff 승인

## 3단계 — 권한 회수

- TTL capability
- 프로세스 트리 종료
- 미적용 Proposal 무효화
- Apply 시점 재검증
- 감사 이벤트

## 4단계 — 폐쇄망 멀티 노드

- Node별 capability 발급과 회수
- 오프라인 TTL과 fail-closed
- 회수 이벤트의 Git 기반 전파는 보조 신호로만 사용
- 원격 Node가 응답하지 않아도 만료 후 실행이 지속되지 않도록 보장

---

# 8. Go/No-Go 기준

- Go: AI가 원본 Git에 직접 접근하지 못하고, 모든 변경이 검증된 Proposal로만 반영되며, 회수 E2E와 사고 주입 테스트가 통과한다.
- Conditional Go: 원본 보호는 증명됐지만 특정 OS의 프로세스 종료 또는 오프라인 회수에 한계가 있어 지원 범위를 축소한다.
- No-Go: AI가 원본 `.git`, 자격증명 또는 Apply 권한 중 하나라도 직접 가질 수 있거나, 회수된 Proposal이 적용될 수 있다.

## 후속 결정 필요

- Windows 기본 격리를 Job Object, 제한 토큰, Sandbox 또는 컨테이너 중 무엇으로 구현할지 결정
- Snapshot을 단순 파일 복사, archive 추출 또는 remote 없는 격리 clone 중 무엇으로 만들지 결정
- Apply Service의 자동 승인 허용 범위와 반드시 사람이 승인할 변경 유형 결정
- Proposal Bundle의 보관 위치, 보존 기간과 서명 방식 결정
- 원본 반영을 patch apply, 임시 branch 또는 별도 통합 저장소 중 어떤 방식으로 수행할지 결정
