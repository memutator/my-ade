# 통합 도메인 마일스톤 진행 기록

이 파일은 **상태를 중복 관리하지 않는다.** 상세 진행·미완료 항목·재개 순서의 정본은 루트 [HANDOFF.md](../../HANDOFF.md)이고, 구현된 내용의 실제 검증 결과는 [../development/verification.md](../development/verification.md)다.

기준 계획: [milestone-plan.md](../../milestone-plan.md) · 의미 설계: [domain-model-design.md](../../domain-model-design.md) · 기존 구현 이관 지도: [integration-migration-map.md](integration-migration-map.md) · 도메인별 현재 상태: [../architecture/domains/README.md](../architecture/domains/README.md)

## 지금 문서를 읽는 방법

- **현재 동작**: `docs/user/`, `docs/architecture/`, [../integrations/capabilities.md](../integrations/capabilities.md)
- **제안·진행 중**: 이 디렉터리와 루트 제안 문서
- **과거 기록**: `mahas-architecture/{implementation,review,verification}-plan/`, `records/`

## 이전 상태 기록 (역사)

아래는 2026-09-20 중단 시점에 작성된 관찰이며, **현재 상태가 아니다.** 이후 작업으로 대부분 해소되었다. 남겨 두는 이유는 당시 어떤 문제가 있었는지 추적하기 위해서다.

- 중단 시점에 중앙 migration/composition, daemon collection scheduler, 기존 소비자 전환이 미완료였다. 지금은 control migration이 v3까지 도메인 fragment를 조합하고, `mahasd`가 수집 scheduler를 수명으로 돌리며, 데스크톱의 사용량/원장 경로가 저장 데이터 projection으로 바뀌었다 — 근거는 [../architecture/migration.md](../architecture/migration.md), [../architecture/domains/README.md](../architecture/domains/README.md), [../development/verification.md](../development/verification.md).
- 중단 시점의 runtime typecheck 5건·renderer 12건 실패는 이후 해소되었고, 현재 검사 결과는 verification 기록에 있다. 이 문장을 현재 실패 목록으로 인용하지 않는다.
- 당시 워커 실행 경로 문제(`unreadable_encrypted_agent_task`)로 두 워커가 실제 변경을 만들지 못했다. 이는 도구 전달 경로의 문제였고 코드 상태와 무관하다.
- 커밋·패키징·설치는 그 시점에 수행하지 않았다. 릴리스 여부는 `requirements/<version>.md`와 HANDOFF를 본다.

## Pack·수집 관련 서술 주의

초기 초안 단계의 문서 일부는 “scanner가 원본 로그를 읽는다”는 전제로 쓰였다. 현재 데스크톱 원장 경로는 **저장된 원장을 옛 wire shape로 투영**할 뿐 원본을 읽지 않는다(`src/main/ledger.ts`). 수집은 daemon의 Pack이 담당하고, 검증 범위는 합성 fixture다 — [../integrations/authoring.md](../integrations/authoring.md)의 “Verification status”를 본다.
