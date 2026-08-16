# 프로젝트 거버넌스 계약

Rundol에서 경량화는 코드와 배포 구조의 복잡도를 줄이는 뜻이지, 책임 구조를 삭제하는 뜻이 아니다. CLI는 `rundol/workspace`의 `projects/project-<key>.yaml`을 통해 프로젝트를 발견한다. 제품 브랜치에는 Rundol 로더를 두지 않는다. 각 등록 파일이 가리키는 `rundol/<project-key>` 브랜치의 `project.md`는 규모와 관계없이 아래 계약을 지킨다.

## 축약할 수 없는 문서 메타

모든 정규 문서는 `id`, `type`, `kind`, `title`, `description`, `owner`, `state`, `tags`, `aliases`, `related`를 유지한다. 담당자와 관계는 실제 파일명을 사용하는 Obsidian Wiki link로 기록한다. 정보가 정해지지 않았다면 필드를 제거하지 않고 `미정`과 확인 책임 또는 후속 태스크를 남긴다.

## 축약할 수 없는 프로젝트 구조

각 `project.md`는 다음 섹션을 모두 가진다.

1. 미션과 검증 가능한 목표
2. 포함·제외 범위와 변경 경계
3. 역할별 미션, 결정권, 주요 산출물, 에스컬레이션
4. 멤버별 역할, 소속, 업무 계정, 책임 영역, 상태
5. 내부·외부 이해관계자의 관심, 영향력, 참여 방식, 담당 역할
6. RACI 책임 매트릭스
7. 의사결정과 에스컬레이션 규칙
8. 위험과 제약 및 대응 책임
9. 진행 점검, 산출물 검토, 이해관계자 공유 주기
10. 완료 정의와 품질 게이트

한 사람이 여러 역할을 맡을 수 있고 이해관계자가 한 명뿐일 수는 있지만, 역할·멤버·이해관계자 분류 자체를 생략할 수는 없다. `rdl check --strict`는 이 계약을 오류로 검증한다.

문서 유형과 메타데이터 형식은 [문서 표준](DOCUMENT-STANDARD.md), 브랜치별 소유 범위는 [브랜치 생성과 동기화 규칙](WORKSPACE-BRANCH.md)을 따른다.

프로젝트 성격에 따른 문서 정책은 `project.md`의 versioned `documentProfile`이 소유한다. schemaVersion 2가 정본으로 저장하는 것은 유형별 정책 상태와 `advisory|checkpoint` 강제 수준뿐이다. 프로필 프리셋과 유형별 하부 요소는 `board.json` 상속(내장 기본값 → Workspace → 프로젝트)이 정하므로 프로젝트가 들고 다니지 않는다. guided 인터뷰, CLI, 스킬과 Board는 같은 evaluator를 사용하며, reconfigure는 기존 문서를 보존하고 revision/history를 전진시킨다.
