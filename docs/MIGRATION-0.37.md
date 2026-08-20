# Rundol 0.37 마이그레이션

이 문서는 `0.36.x`에서 `0.37.0`으로 올릴 때 필요한 작업을 다룬다. **저장 파일을 바꾸는 마이그레이션 명령은 없다.** 문서와 태스크와 이벤트 파일은 이 판올림으로 바뀌지 않는다.

바뀌는 것은 진단 출력의 필드 이름 셋과, 아직 제품 흐름에 연결되지 않은 워커 계약의 값 형태다.

## 변경 요약

| 항목 | 0.36.x까지 | 0.37.0 |
|---|---|---|
| `rdl debug summary`의 `humanInterventions.tasks[].humanTurns` | 있음 | **`humanActions`로 이름 변경** |
| `rdl debug summary`의 `humanInterventions.medianHumanTurns` | 있음 | **`medianHumanActions`로 이름 변경** |
| `humanInterventions.measures`·`lowerBound` | 없음 | **추가.** 무엇을 세는지와 그것이 하한이라는 사실 |
| `Report`의 `schema` | 없음 | **필수.** 보고가 따른 스키마 이름 |
| `ReportRejectionCode` | 다섯 | **일곱.** `wrong-assignment`, `schema-mismatch` 추가 |
| `verifyReport(할당, 보고)` | 미언급 수용 조건만 거부 | **접수 계약 전체를 먼저 본다.** 갖추지 못하면 `ContractViolation` |
| `rdl task set --link` | 한 호출 안의 중복이 통과 | **한 번만 남음** |
| `rdl sync`·`rdl sync watch`의 `--client-id` | 필수인데 usage에 없음 | **usage에 표기** (동작은 그대로) |
| `npm run release:check` | 버전·테스트·설치 회귀 | **타입 검사 추가** |
| `npm run version:check` | 버전·경계·CHANGELOG | **잠금 파일 무결성 추가** |

## 실행할 명령

없다. 다만 아래 둘은 확인이 필요하다.

### 1. `rdl debug summary`를 읽는 자동화가 있다면

필드 이름이 바뀌었다. `humanTurns`와 `medianHumanTurns`를 읽던 곳을 `humanActions`와 `medianHumanActions`로 고친다.

이름을 바꾼 이유는 세는 것이 사람의 개입 횟수가 아니라 사람이 실행한 행위의 수였기 때문이다. 한 번 마음먹고 명령을 셋 치면 개입은 한 번이고 행위는 셋이므로 두 값은 같지 않다. 재고 싶은 이름을 붙여 두면 그 차이가 지워진 채로 편익 판단에 들어간다.

같은 이유로 `measures`와 `lowerBound`가 값에 실려 나온다. 이 계측은 명령을 거치지 않은 개입 — 보드나 편집기에서 직접 손댄 경우 — 을 보지 못하므로 실제 개입의 **하한**이다. 이 수치로 편익을 주장할 때는 하한이라는 사실을 함께 말한다.

### 2. `src/worker-contract`를 직접 부르는 코드가 있다면

`verifyReport`가 이제 접수 계약을 먼저 본다. 다음에 해당하면 판정 대신 `ContractViolation`을 던진다.

- 필수 항목 누락 (`id`, `assignmentId`, `worker`, `outcome`, `claims`, `procedureDigest`, `schema`, `changed`)
- 다른 할당을 향한 보고 (`assignmentId`가 할당의 `id`와 다름)
- 닫힌 할당
- 수임자가 아닌 보고자
- 할당의 `reportSchema`와 다른 `schema`
- `blocked`·`rejected`인데 `reason` 없음
- 할당이 선언한 수용 조건을 보고가 언급하지 않음

접수와 검수를 나눈 이유는 둘이 다른 질문이기 때문이다. 접수는 "이 보고를 이 할당에 대해 판정할 수 있는가"를 묻고, 검수는 "판정해 보니 통과인가"를 묻는다. 뭉개면 보고를 잘못 만든 것과 일을 통과시키지 못한 것이 같은 값이 되고, 그러면 워커 종류별 형식 위반율을 잴 수 없다.

거부 사유만 값으로 받으려면 `acceptReport(할당, 보고)`를 부른다. 갖췄으면 `null`, 아니면 `{ code, missing, unclaimed }`를 돌려준다.

`Report`에 `schema`가 필수로 들어갔다. 보고가 따른 스키마를 밝히지 않으면 할당의 `reportSchema`는 아무도 읽지 않는 필수 항목이 되고, 이름만 같고 뜻이 다른 필드를 조용히 판정하게 된다.

이 판정부는 아직 제품 흐름에 연결되지 않았다. 할당 발급과 보고 저장 경로가 없으므로, 이 모듈을 직접 부르지 않는 사용자는 할 일이 없다.

## 하지 않아도 되는 것

- 문서·태스크·이벤트 파일 변환: 없다.
- 재초기화나 재연결: 필요 없다.
- 이미 쌓인 로그 파일 정리: 필요 없다. 상한 판정만 바뀌었고 다음 기록 때 적용된다.

## 함께 읽을 것

- [변경 이력](../CHANGELOG.md)
- [0.36 마이그레이션](MIGRATION-0.36.md)
- [버전과 릴리스 정책](RELEASES.md)
