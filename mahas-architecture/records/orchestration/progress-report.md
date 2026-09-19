# mahas-architecture 진행 리포트 — 2026-09-19

대상 워크트리: `/home/pyosechang/projects/ade-wt-mahas-architecture` (branch `mahas-architecture`)
기준: HEAD `71a6cae` + live uncommitted WIP (fix 세션, 121 files / +5115 −1400)
성격: 구현·리뷰·검증·수정 4개 흐름의 결합 상태 정산. 정식 수락 판정 아님.

---

## 1. 목표 구조

`delivery-dag.json` + `acceptance.md` 기준 파이프라인:

```
spec → IMP-01..32 (구현) → REV-01..08 (정적 리뷰) → VER-01..12 (실행 검증) → RELEASE
```

최종 수락 조건 (acceptance.md): **모든 필수 AC(01~28)가 동일 code/spec revision에서
충족** + REV-08 결합 검토 + VER-12 증거 정리 완료. 미실행/미지원은 pass 불가.
결함은 소유 IMP로 되돌리고 영향받는 review/verification을 반복.

## 2. 단계별 도달도

### 구현 (IMP-01..32) — 코드 상 100% landed, 계약 조인은 미완성

- `83a6d21` HANDOFF가 "IMPLEMENTATION COMPLETE" 선언. 모듈과 `register*` 호출은 전부 존재.
- **그러나** 두 리뷰 세션(독립 REV + grok 병렬 리뷰, 동일 revision `8f69594`)이
  일치 판정: 모듈 존재 ≠ 계약 조인. S-ARCH §7 사슬(탐색→배정→구현→주입→협업→정산→정리)이
  여러 경계에서 끊김 — 총 70 findings(59 국소 + 11 조인).
- Fix 세션이 이를 수정 중 — worktree에 **미커밋** 상태 (runtime 19 + host 6 파일 외
  spec/contracts 동반 수정 — spec 자체도 고쳐지고 있음에 주목).

### 리뷰 (REV-01..08) — 완료, 전부 changes-required

- 8건 전부 `changes-required`, 동일 code `8f69594` / spec `99eb5f5`.
- grok 병렬 리뷰(`REV-*-grok.md`)가 같은 결론을 독립 재확인 — 신뢰도 높음.
- **정합성 이슈**: 현재 WIP는 리뷰 대상 revision과 다름 (수정분 미커밋 + spec 수정 동반).
  VER-12는 "같은 code/spec revision의 REV-08 결과"를 요구 → **수정분 커밋 후
  REV 재실행이 필요** (최소 영향받는 항목). 현재로선 REV-08가 가리키는 revision의
  코드가 이미 아님.

### 검증 (VER-01..11) — 10/11 실행, 10 failed + 1 passed + 1 blocked

| VER | 범위 | verdict |
|---|---|---|
| 01 | 모델/RDD/배정 | failed (5 findings) |
| 02 | 수명주기 부팅 | failed (2) |
| 03 | 인가/비노출 | failed (7) |
| 04 | META DAG/직접통신/정산 | failed (4) |
| 05 | role-impl/주입 | failed — **worker.start가 resources_claimed에서 사망** (F-046) |
| 06 | spawn 단절점/host | failed (F-052~F-056) |
| 07 | UI detach/재부착 | failed (8) |
| 08 | shutdown/인계/복구 | failed (4) |
| 09 | claude 주입 | **blocked** — `claude auth status` loggedIn:false |
| 10 | codex 실구동/주입/resume | **passed** (유일) |
| 11 | grok×codex 협업 E2E | failed (F-058~061, 이후 재검증으로 전부 fixed 확인) |

### 수정 (fix 세션, 진행 중)

- fix-progress 스냅샷 기준 10 fixed / 4 addressing / 10 untouched (F-001..F-024 범위).
- 이후 독립 재검증(내 세션)으로 추가 확인: **F-022, F-024, F-046, F-051, F-055,
  F-058, F-059, F-060, F-061 fixed-in-wip (reverified)**.
- 대장 집계(65 findings): open 44 / fixed-in-wip 10 / reverified 7 / partial 4.

## 3. 현재 막고 있는 것 (release blocker 계열)

### A. 발사 경로 — shipped `worker.start`가 spawn에 도달 불가

오늘 launch leg 실측 (최초로 `process_attempting`까지 진행):

- **F-063 (치명)** — coordinator가 materializer에 envelope를 안 넘김 →
  `task/initial.txt`가 구조상 존재 불가인데 route는 REQUIRED → **모든 recipe에서
  spawn 불도달**. baseline 결함.
- **F-062 (major)** — `worker.prepare` 이중 불능: `assignment` 타겟 kind가
  `expandOne`에 없음 + 내부 `context.build`가 member ctx로 dispatch돼
  service-visibility에 막힘.
- **F-064 (major)** — post-admission 실패 시 member 영구 wedge (stop 거부 /
  release 미해제 / receipt 재생). 복구 op 부재.
- 연쇄 차단: F-047(stdin)·F-048/49/50(join-commit/dispatch phase)은 F-063 하류라
  재검증 불가 → spawn이 살아야 판정 가능.

### B. Host 견고성 — 미검증 잔여

- F-052 (host EPIPE 전체사망), F-053 (attempting wedge), F-054 (dedupe 단일키),
  F-056 (journal 미기록) — open. F-052/53은 A와 같은 host 경로.
- F-006 (dial error 핸들러 부재), F-007 (FK ordering), F-008 (crash-loop throttle),
  F-015 (lock config-dir scope), F-017 (lease epoch) — open.

### C. 인가/비노출 잔여

- F-002 (list-vs-invoke oracle), F-012 (cyclic reparent RangeError),
  F-018 (member↔principal 바인딩 미검사 — in-process 잔여), F-019 (self-revoke
  rollback), F-020 (member access.inspect 부재) — open.
- F-005/14/17 — addressing 상태, 재probe 필요.

### D. VER-04/07/08 잔여 — 대량

- F-025..F-045 전부 open (client-probe/UI/recovery 계열 21건) — 아직 fix 세션이
  안 건드린 영역. 각각 targeted probe로 재현 가능하나 수정 없으면 open 유지.

### E. 절차적 blocker

- **VER-09 blocked** — claude 로그인 필요 (사용자 액션).
- **수정분 미커밋** — fix 세션의 WIP가 커밋되지 않으면 "동일 revision" 요구를
  만족하는 revision이 존재하지 않음. REV 재실행·VER 재실행·VER-12 모두 여기에 의존.
- **REV 재실행 필요** — REV-08는 `8f69594` 기준; 수정 커밋 후 영향 항목 재검토 필요.

## 4. VER-12 / RELEASE까지의 경로

```
1. 잔여 findings 수정 (fix 세션 — F-062/63/64 포함 open 44건 중
   최소 release-blocker 계열: A 발사 경로 + B host + C 인가)
2. WIP 커밋 → 단일 revision 확정
3. 잔여 findings targeted re-verification (finding당 재현 테스트 1개 —
   오늘 4+4건을 이 방식으로 닫음, 전체 VER 재수행 불필요)
4. VER-05/06 재실행 (발사 경로 수정되면 실 spawn→join→accept leg 가능)
5. REV 영향 재검토 (최소 REV-08 결합 검토를 새 revision으로)
6. VER-09 — 사용자가 claude 로그인하면 실행, 아니면 blocked 명시로 진입
7. VER-12 — REQ/AC 추적 + support matrix + blocker 정산 → disposition 제출
```

## 5. 정직한 판정

- **구현**: 완료 선언됐으나 실행 수준에서 launch critical path가 한 번도 동작한 적
  없음 (VER-05 당시 resources_claimed 사망 → 오늘은 process_attempting까지 진전).
  핵심 가치 사슬인 "member 배정 → agent spawn → join → 협업"의 **spawn~join 구간이
  현재 코드로 검증된 바 없음** — F-063이 마지막 문.
- **검증 체계 자체는 작동**: 재현 가능한 증거 + finding→owner 라우팅 +
  targeted re-verification 루프가 실제로 결함을 잡고 fix를 확인했음.
- **리스크**: fix 세션이 spec/contracts 파일도 함께 수정 중 — spec revision이
  움직이면 모든 REV/VER의 revision 정합성이 무너짐. 커밋 시점에 spec diff를
  리뷰 영향에 반영해야 함.
