# records — 독립 review·verification·오케스트레이션 기록

이 폴더는 review-plan / verification-plan Task의 출력(`ReviewRecord`/`VerificationRecord`)과
팀장 오케스트레이션 상태를 보관한다. 구현 Task는 `packages/`·`src/`를, 이 폴더는 검토·검증
역할만 쓴다 — 구현 산출물을 여기 두지 않는다.

## 구조

```text
orchestration/
  STATUS.md            landed IMP → unblocked REV/VER 대장 (커밋 단위 추적)
  imp-01-foundation.md 기반 seam 사전 점검 메모 (정식 REV 아님)
review/REV-XX.md       ReviewRecord (계약: review-plan/README.md)
verification/VER-XX.md VerificationRecord (계약: verification-plan/README.md)
```

## 규칙

- 각 record는 `codeRevision`(검토·검증 대상 커밋)과 `specRevision`을 반드시 적는다.
  revision이 바뀌면 새 record를 쓰고 과거 record를 덮어쓰지 않는다.
- `verdict`/`disposition`은 passed/failed/blocked/not-run, accepted/changes-required/blocked
  만 사용한다. 실행하지 않은 것을 passed로 쓰지 않는다.
- finding에는 코드 위치·위반 계약·근거·실제 위험·수정 담당 IMP를 적는다.
- 커밋은 이 폴더 아래 경로만 `git add` 한다 (다른 세션의 WIP를 쓸어 담지 않기 위해).
