# mahas-architecture 진행 리포트 — 2026-09-19

## 최신 상태 — 코드 기준 `24c983f` + 후속 수정 WIP

이 절이 현재 상태의 정본이다. 아래 §1~6은 커밋 전 조사·수정 이력이며,
`미커밋`, `fixed-in-wip`, Claude 로그인 blocker 등 과거 표기는 이 절로 대체한다.

### 현재 판정: 최소 task lifecycle 검증 완료 — 이번 후속 작업 종료

사용자의 “최소 동작을 보장하는 방향으로 문제를 먼저 닫기” 지시에 따라,
이번 종료 기준을 다음으로 고정한다. 전체 architecture RELEASE 수락과는 구분한다.

| 고정된 종료 조건 | 판정/증거 |
|---|---|
| 유효한 task assignment를 준비하고 정상 workspace에서 실제 worker를 실행한다 | PASS — prepare 권한 회귀 + 실제 host 통합 |
| 초기 입력이 실제 프로세스에 전달되고 worker 인증 → join → accept가 커밋된다 | PASS — stdin 원문 일치 및 worker RPC receipt |
| worker가 전달된 작업을 수행하고 결과 보고 → 완료·정산에 도달한다 | PASS — stdin의 `17 + 25` 계산 → `42` 보고, outcome 1건 및 accepted settlement 1건, dispatch settled |
| 종료 후 인증·실행 바인딩·자원과 실제 checkout을 정리한다 | PASS — worker.stop 후 credential 폐기/member 해제, worker.release 후 claim 해제/workspace released/checkout 디렉터리 없음 |
| 준비 실패/불명확 상태에서는 spawn하지 않고, 검증한 실패·재호출 경로에서 중복 실행하지 않는다 | PASS — workspace gate 2건 + 복구 5건 + 실제 start/accept replay |

`npm run test:launch`를 종료 시 다시 실행해 전체 PASS를 확인했다.
**F-062/F-063/F-064 및 workspace 준비 gate 문제는 이 검증 범위에서 닫는다.**
새 발견을 자동으로 이번 완료 조건에 추가하지 않는다. 재개 조건은 위 경로의
재현 가능한 회귀, 또는 사용자의 별도 범위 확대 요청뿐이다.

**검증 형태:** task assignment와 controller epoch는 테스트 fixture에서 seed한다.
worker는 실제 OS 프로세스이며 stdin 지시의 계산·RPC 보고·owner-declaration 정산을 수행한다.
전체 team.assign 흐름·LLM 활용 품질·UI·모든 provider·crash/restart 조합은 이번 기준에 넣지 않는다.
확정 실패 후 **같은 입력으로 새 plan을 발급하는 복구(F-065)는 지원 보장 밖**이다.
해당 문제는 해결로 표시하지 않고 별도 backlog로 보존한다. Claude 검증은 제외한다.

- **커밋 완료:** `24c983f` (`fix: checkpoint architecture integration and launch recovery`).
  기존 WIP를 포함한 142개 파일을 커밋했다. 아래 후속 구현·테스트·문서 수정은 아직 미커밋이다.
- **Claude 검증 제외:** 사용자 지시에 따라 VER-09는 이번 작업 범위에서 제외한다.
  Claude 로그인은 현재 작업의 blocker가 아니다. Claude 지원은 미검증으로 남기며
  pass로 집계하지 않는다. 기존 VER DAG의 VER-09 의존성과 최종 수락 범위는
  VER-12에서 이 제외 결정을 명시해야 한다.
- **현재 spawn 실패 원인 확정:** 테스트 프로젝트 경로
  `/tmp/mahas-ver-11/repo`가 없어 host가 workspace.prepare를 거부했다.
  해당 operation receipt는 `workspace.state=failed`, `effect.state=rejected`,
  reason=`INPUT_NOT_READY: projectRoot is not an existing directory: /tmp/mahas-ver-11/repo`다.
  그런데 `stageResourcesClaimed`는 상태를 검사하지 않고 checkout 경로와 ID만 보고
  `resources_claimed=confirmed`로 기록했다. 생성되지 않은 cwd
  `/tmp/mahas-ver-11/worktrees/w5`로 spawn하여 ENOENT가 발생했다.
  Node 실행 파일은 존재한다. **fixture 디렉터리 누락 + 준비 실패를 무시하는 코드 버그**이며,
  후속 WIP에서 ready/confirmed gate를 추가했고, 실패/불명확 응답 모두
  materialize/spawn 호출 0회 및 잔여 claim 보존을 자동 검증했다.
  증거: `/tmp/mahas-ver-11/config/mahas.sqlite`의 `operation_receipts`,
  operation_id=`internal:workspace.prepare:8f232c93-e3db-49b5-8d9d-c26cab4d4cfa`.
- **F-062:** 새로 migrate한 격리 DB의 결정적 스크립트가 통과했다. run-scoped
  worker.prepare-only member grant로 prepare 성공, 내부 context.build는 service principal로
  인가, 다른 run assignment는 거부, 직접 member context.build는 비노출을 확인했다.
  실행: `node packages/mahas-runtime/src/access/f062-assignment-service.smoke.ts`.
- **F-063 및 실제 통합:** 초기 입력에 실행별 join/accept pins를 추가했다.
  실제 host/runtime/OS worker에서 task/initial.txt와 수신 stdin 원문 일치,
  worker credential 인증, execution.join·task.accept 성공, start/accept replay의
  중복 방지를 확인했다. 이후 task.report와 report replay, accepted 정산,
  worker.stop/release 및 물리적 checkout 제거까지 같은 통합 테스트로 확인했다.
  결정적 Node worker이며 LLM/provider 동작 검증은 아니다.
- **F-064:** coordinator 오류 주입 스크립트 5개 시나리오가 통과했다. 재시도 가능
  materialize 실패는 동일 실행 바인딩 유지 후 1회 spawn; 확정 materialize/spawn 실패는
  member 해제·dispatch fence·credential 폐기 후 replay만 허용; spawn 응답 유실은
  바인딩/dispatch 보존 및 중복 spawn 금지; 구버전의 확정 실패 receipt는 잔류 member
  바인딩을 회수한다. host/materializer는 이 테스트에서 대역이며 실제 OS 통합은 별도다.
  실행: `node packages/mahas-runtime/src/launch/f064-recovery.smoke.ts`.
- **검증:** `npm run test:launch` 4개 스크립트 통과, registry 회귀 40개 통과.
  루트 typecheck 및 runtime/host 개별 타입체크와 변경 TS 파일 ESLint 오류 검사 통과. 기존 REV/VER는
  새 커밋의 전체 수락 증거가 아니며, 잔여 findings 집계도 재검증 후 갱신해야 한다.
- **이번 후속 3개 묶음 완료:** F-062 권한 경계 자동 검증, workspace 준비 gate 및 실제
  spawn→join→accept 통합, F-064 실패·재시도 안전성 수정/자동 검증.
  범위와 한계: [launch-regression.md](../verification/launch-regression.md).
- **별도 backlog — 이번 작업의 후속 의무 아님:** F-065(동일 입력으로 실패 plan 대체 불가),
  잔여 host/인가/UI/복구 findings의 최신 코드 대조 및 전체 RELEASE용 영향 REV/VER.
  자동 착수하지 않는다. 최소 task lifecycle 검증은 완료이며 전체 RELEASE는 미수락이다.

---

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

## 6. 후속 진행 — 2026-09-19

- F-062 **fixed-in-wip / reverified**: `assignment → member/run` 실제 타겟 조상을
  추가하고 launch 내부 cross-domain 호출을 좁은 `service:mahasd` grant로 분리했다.
  기존 member credential과 수정하지 않은 member grant로 `worker.prepare`가 blockers
  없이 커밋됐다.
- F-063 **fixed-in-wip / reverified**: pinned WorkEnvelope의 content blob과 bindings를
  읽어 materializer에 전달한다. 실제 실행 루트에 `task/initial.txt` 1,390 bytes와
  `task/envelope.json`이 생겼고 host spawn 호출까지 도달했다.
- F-064 **fixed-in-wip / reverified**: 확정적인 pre-spawn 실패만 dispatch/credential을
  fence하고 execution을 `exited`로, member `current_execution_id`를 `NULL`로 되돌린다.
  claim은 숨겨서 지우지 않고 receipt residual 및 `worker.release` 후속 동작으로 남긴다.
  모호한 spawn 결과에는 이 회수를 적용하지 않는다.
- 표적 실행의 다음 실패는 fixture host의 `spawn <absolute-node> ENOENT`였다. 이는
  F-063의 materialization 단절과 별개이며, full spawn→join→accept 재검증 전에 host
  실행환경/fixture를 정리해야 한다.

### 커밋 전 증거 한계 정정

- F-062 재실행은 앞선 검증에서 assignment scope 및 service action 우회가 추가된
  기존 fixture를 사용했다. 이번 호출 성공만으로 우회 없는 member 인가까지 검증했다고
  판정할 수 없다. 수정은 존재하지만 깨끗한 fixture로 재검증해야 한다.
- spawn 대상 Node 실행 파일은 존재한다. 반면 cwd인
  `/tmp/mahas-ver-11/worktrees/w5`는 존재하지 않는다. ENOENT의 원인을 실행 파일로
  단정하지 않으며 workspace.prepare의 물리 디렉터리 준비/완료 판정을 우선 조사한다.
- F-064는 확정 spawn 거부의 member 해제를 관측했다. 같은-operation retry가 허용되는
  실패에서도 admission을 해제하는 현재 로직과 receipt 재실행의 정합성, 기존 실패 실행
  회수, task dispatch fence 및 ambiguous spawn 보존은 추가 검증이 필요하다.
- 루트 `npm run typecheck`는 Electron 진입점 기준이다. 독립 runtime/host 패키지
  타입체크와 전체 spawn→join→accept 성공을 대신하지 않는다. 커밋 전 추가 실행한
  `tsc --noEmit -p packages/mahas-runtime/tsconfig.json` 및 execution-host의 동일
  패키지 타입체크는 모두 통과했다.
- 따라서 위 fixed/reverified 표기는 해당 관측 범위로 한정하며, F-062/F-064 전체
  수락이나 RELEASE 완료를 뜻하지 않는다.
