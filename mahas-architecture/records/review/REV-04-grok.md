# ReviewRecord — REV-04 (reviewer: grok)

> 본 기록은 grok 병렬 리뷰 산출이다. 검토 대상은 `mahas-architecture` 워킹트리(codeRevision `8f6959457a8fc965c110dea79d533e53cf07326c`, specRevision `99eb5f5`)의 packages 구현체다.

- reviewTaskId: REV-04
- codeRevision: 8f6959457a8fc965c110dea79d533e53cf07326c
- specRevision: 99eb5f5
- scope: IMP-13/14/15/20/21/31의 협업·DAG·전달·정산 의미. `packages/mahas-runtime/src/coordination/*`, `mail/*`, `artifacts/*`, `launch/{acceptance,join}.ts`, `api/{admission,registry}.ts`, `src/renderer/src/workbench/*`를 REQ-01/17/18/19/20 · D-WORK · D-MAIL · C-WORK · C-MAIL과 대조. HANDOFF의 IMP-21 "acceptance + dispatch settlement" 주장은 코드로 재검증했다.
- disposition: changes-required

Verified aligned. Run은 scheduler가 아니다 — `run.create`/`run.get`/`run.close`는 dispatch·process를 만들지 않고, `run.close`는 child accepted의 AND가 아니라 coordinator가 명시한 `RunDecision`을 기록한다 (`run.ts:99-179`, `317-537`). `computeEligibility`는 투영만 한다 (`eligibility.ts:1-6`, `273-276`). Plan은 immutable + CAS이며 edge cycle을 거부하고 active attempt disposition 누락을 구조 오류로 돌린다 (`plan.ts:404-406`, `269-284`, `581-614`). `message.send`는 같은 Run의 recipient mailbox로 직접 enqueue하며 팀장 중계 경로가 없다 (`message-service.ts:164-225`). `message.replyAndAck`는 회신 INSERT와 `applyDeliveryAck`를 한 handler·한 admission tx에서 수행하고, 이미 ack된 Delivery는 INSERT 전에 `OPERATION_CONFLICT`이다 (`message-service.ts:228-360`, `ack.ts:31-123`). consumer generation fence와 outstanding 재바인딩은 메시지를 복제하지 않는다 (`shared.ts:192-205`). `task.accept`는 execution-bound credential, 정확한 taskRevision/envelopeDigest, join 선행, assignment Delivery ack를 한 tx에 묶는다 (`acceptance.ts:101-232`) — 다만 아래 Finding 7의 phase 전제에 의존한다. TeamView는 provider/consumer를 각각 preview→명시 assign하며 검색 순위를 기본 확정으로 쓰지 않는다 (`TeamView.tsx:1-12`, `319-328`). Artifact publish는 live path를 결과로 제출하지 않고 digest를 고정한다 (`publisher.ts:1-16`, `176-268`). IMP-14의 `reserveDispatch`/`pinInputs`/`buildTaskEnvelope`는 정확한 spec revision·assignee·accepted artifact pin을 강제한다.

## Findings

**1. [implementation] IMP-21의 `task.report` / `outcome.decide` / `execution.wake` handler가 없고, accepted outcome을 특정 revision에 붙일 경로가 없다**

- Location: `packages/mahas-runtime/src/coordination/index.ts:56-86` (등록면은 `run.*`/`plan.*`/`team.*`/`assignment.*`/`task.dispatch`뿐); `packages/mahas-runtime/src/api/registry.ts:126-127,144` (`OPERATION_TABLE`은 세 이름을 IMP-21 소유로 나열); `packages/mahas-runtime/src/coordination/member.ts:140-186` (coordination grant에 `execution.wake`/`outcome.decide`, task grant에 `task.report`); `packages/mahas-runtime/src/composition.ts:339-359` (해당 register 호출 없음).
- Contract: C-WORK `task.report`/`outcome.decide` (`spec/contracts/work.md:139-165`); C-LAUNCH `execution.wake` (`spec/contracts/launch.md:137-149`); D-MAIL §4-5; REQ-20; IMP-21 instruction §4·§6 (`coordination/{outcome,settlement,handoff}.ts`, `mail/{wake-service,continuation}.ts`).
- Evidence: 지시된 파일이 트리에 없다. `INSERT INTO outcomes`는 `maintenance/smoke.ts:500` fixture뿐이고 `settlements`/`outcome_outputs`/`handoffs`/`wake_requests`에 대한 runtime writer가 없다. 미등록 이름은 admission이 `UNAVAILABLE_OPERATION`으로 거절한다 (`admission.ts:172-185`). `settleDispatch` (`dispatch-authority.ts:365-394`)와 `dispatch.settle` 내부 op는 있으나 phase를 `reported`로 올리는 공개 경로가 없다. `task.dispatch`만 IMP-21 담당 연산 중 구현되어 있다.
- Consequence: 담당자 report와 지정 수용이 분리되지 못한 채 둘 다 호출 불능이다. Outcome이 없으므로 Settlement·handoff가 없고, `task-output`은 영원히 `INPUT_NOT_READY`이며 후행 Dispatch는 열리지 않는다. owner-declaration이 팀장 병목을 피한다는 REQ-20도, accepted outcome이 자원 cleanup/turn-complete와 섞이지 않고 특정 revision에 붙는다는 지시 5도 구현에서 확인할 수 없다. grant JSON에는 이름이 남아 surface에는 handler가 없어, 권한 목록과 실제 표면이 어긋난다. HANDOFF의 IMP-21 완료 주장은 이 코드와 맞지 않는다.
- Requested correction: 활성 Dispatch의 `(taskId, taskRevision, dispatchId)`에 `checkAttemptAuthority`로 Outcome revision을 기록하고, owner-declaration은 같은 tx에서 자기 Settlement를, designated-acceptance는 해당 outcome revision에만 `outcome.decide`를 적용한다. accepted output은 ArtifactRef handoff로만 후행 input resolver가 쓰게 한다. `execution.wake`는 ContinuationGrant·safe recipe·budget·같은 operation key를 요구하고 실패 시 Delivery를 지우지 않는다. 등록 전까지 grant 어휘에서 빼거나 미구현으로 명시한다.
- Target: IMP-21.

**2. [implementation] `inbox.wait`가 admission 트랜잭션 안에서 bounded poll을 수행한다**

- Location: `packages/mahas-runtime/src/mail/wait.ts:15-19,40-94`; `packages/mahas-runtime/src/mail/index.ts:26-27` (`mutation: false`); `packages/mahas-runtime/src/api/admission.ts:111-119,246-258`; `packages/mahas-runtime/src/mail/inbox.ts:122-132` (`openMailbox` → `rebindOutstandingDeliveries` UPDATE).
- Contract: REQ-19 · D-MAIL §5 · C-MAIL `inbox.wait` — timeout은 empty result이고 Message/Delivery를 바꾸지 않으며, 대기는 wrapping write tx 밖에서 원장을 관찰해야 한다. 파일 주석 자체(`wait.ts:15-19`)가 이 제약을 적고 있다.
- Evidence: admission은 handler 유무와 관계없이 `runInTransaction(..., mutation ? 'IMMEDIATE' : 'DEFERRED', …)`로 모든 dispatch를 감싸고, `executeInTxn`이 handler를 `await`한다. `inbox.wait`는 그 안에서 `openMailbox`/`rebindOutstandingDeliveries`로 UPDATE한 뒤 `maxWaitMs`(기본 60s) 동안 `sleep`한다. 이는 코드 구조와 SQLite “한 연결에 트랜잭션 하나” 규칙에 따른 **추론**이지, 이 검토에서 재현한 런타임 관측이 아니다.
- Consequence: 단일 `DatabaseSync`에서 wait 중 다른 `BEGIN`은 트랜잭션 재진입으로 이어질 수 있고, 재진입을 피하더라도 DEFERRED가 첫 UPDATE에서 write lock으로 승격되면 그 대기 동안 `message.send`/`task.dispatch`가 같은 writer를 얻지 못한다. bounded wait가 새 Delivery를 보지 못하거나 제어면 전체를 막을 수 있어, REQ-19의 명시적 inbox 확인이 전달 원장과 직교하지 못한다.
- Requested correction: long-poll query를 autocommit/별도 연결로 빼는 admission 모드를 두거나, wait handler가 registry tx 밖에서 ledger를 읽게 한다. generation 재바인딩 UPDATE를 poll loop의 열린 tx에 두지 않는다.
- Target: IMP-15 (admission 지원은 IMP-11).

**3. [implementation] 작업대는 `expectedPlanRevision`을 payload에서 빼고 해석 불가한 `expectedRevisions.plan`만 보내, `plan.commit`/`team.assign`이 UI에서 성공할 수 없다**

- Location: `src/renderer/src/workbench/ops.ts:110-117` (`assignTeam`이 `expectedPlanRevision`을 payload에서 제거한 뒤 `expectedRevisions: { plan: N }`); `ops.ts:133-139` (`commitPlan`은 항상 `{ plan: expectedPlanRevision }`); `packages/mahas-runtime/src/coordination/index.ts:60-85` (`memberOp`/`operatorOp`는 `{name, visibility, mutation}`만 등록 — `resolveTargets`/`resolveRevisions` 없음); `packages/mahas-runtime/src/api/admission.ts:343-364,368-376`; handler는 payload의 `expectedPlanRevision`을 읽는다 (`plan.ts:533,566-573`, `member.ts:461,480-488`).
- Contract: C-WORK `plan.commit`/`team.assign` 입력은 `expectedPlanRevision` payload 필드이다 (`spec/contracts/work.md:73,87`). spec/common.md §3 expectedRevisions는 등록된 resolver가 실제 revision을 돌려줄 때만 의미가 있다.
- Evidence: `resolveRevisions`가 없으면 `actuals = {}`이고 키가 하나라도 있으면 `STALE_REVISION`이다. 동시에 빠진 payload 필드는 handler에서 `?? 0`이 되어, 이미 plan이 있는 Run은 `expected 0 vs current ≥ 1`로 거절된다. TeamView의 “From run” 버튼(`TeamView.tsx:143-151`)은 바로 이 필드를 채워 봉투 경로로 보낸다. coordination 등록이 `resolveTargets`를 안 주므로 admission의 실제 대상 authorize와 commit-직전 재검사도 빈 배열로 돈다 — handler가 자체 `authorize`를 호출하므로 열린 구멍은 아니지만, 파이프라인의 독립 검증은 이 경계에서 비어 있다.
- Consequence: META DAG 게시와 팀 배정이라는 IMP-31의 두 핵심 mutation이 작업대에서 항상 거절된다. 빈 계획의 첫 `team.assign`만 payload `expected=0`으로 통과할 여지가 있다.
- Requested correction: C-WORK대로 `expectedPlanRevision`을 payload에 두고, 해석되지 않는 `expectedRevisions.plan`을 보내지 않는다. 봉투 CAS를 쓰려면 coordination op spec에 `resolveRevisions`/`resolveTargets`를 단다. 한 쪽이 계약을 소유해야 한다.
- Target: IMP-31 (주). resolver를 붙인다면 IMP-13.

**4. [implementation] PlanView의 PlanPatch 필드가 서버 validator와 어긋나, 입출력 pin과 신규 task edge가 게시되지 않는다**

- Location: `src/renderer/src/workbench/PlanView.tsx:60-91,154,285-326`; `src/renderer/src/workbench/contracts.ts:303-340`; `packages/mahas-runtime/src/coordination/plan.ts:76-82,176-221,343-356`.
- Contract: C-WORK Plan 문법 (`activeAttemptDisposition.action`, TaskSpec 입출력); D-WORK §2-4 (협의 task는 후행 output에 잠기지 않게 작성); IMP-31 §4.4-4.5; mahas-contracts `InputBinding`은 top-level `taskId`/`outputSlot` (`packages/mahas-contracts/src/work.ts:173-188`).
- Evidence: (a) UI는 기존 task마다 `{ taskId, disposition: 'keep'|'stop' }`를 보낸다. 서버 `validatePatch`는 `reqStr(o, 'action')`으로 `keep|revoke|replace`만 받는다 — 기존 task가 하나라도 있으면 prepare가 `MODEL_INVALID`. (b) UI는 `inputBindings`/`outputSlots`와 `{ name }`을 보낸다. 서버는 `o.inputs`/`o.outputs`만 읽어 둘 다 `undefined` → 신규 task는 빈 입출력, 기존 task는 prior만 이월되어 편집이 조용히 무시된다. identity는 문자열 한 칸인데 eligibility는 `identity` 객체, `pinInputs`는 top-level 필드를 본다. (c) 신규 task의 edge dropdown 값은 `task.taskId || task.key` (로컬 UUID)이고 patch의 `taskId`는 비어 서버가 `newId('tsk')`를 만든다 — `edge-endpoint-not-in-plan`. `loadRun`은 `baseRev`만 채우고 기존 plan task를 편집기로 가져오지 않는다 (`PlanView.tsx:110-118`).
- Consequence: 첫 DAG에서 edge를 잇거나 입출력을 적는 정상 사용이 구조 오류이거나 빈 spec으로 게시된다. 순환 대기를 피하려고 초기 협의 task를 쓰라는 지시는 UI 기본값(required `task-output`)과 깨진 바인딩 때문에 표현되지 않는다. TeamView의 독립 배정만으로는 Plan이 후행 output 대기를 올바르게 고정하지 못한다.
- Requested correction: wire를 서버/계약 이름에 맞춘다 (`action`, `inputs`/`outputs` 또는 명시적 alias, `keep|revoke|replace`, `InputBinding` top-level 필드, output `slot`). 신규 task id를 prepare 전에 안정적으로 고정하거나, 서버가 patch 내부 임시 id를 치환한다. 기존 Plan을 편집기로 로드한다.
- Target: IMP-31.

**5. [implementation] `task.dispatch`가 `createDispatch`/`pinInputs`/`reserveDispatch`를 우회해, 시도 생성 불변식이 경로마다 다르다**

- Location: `packages/mahas-runtime/src/coordination/member.ts:791-1139` (독자 envelope·message·dispatch INSERT, phase `'awaiting_accept'`); 비교 `dispatch-ops.ts:3-17,127-184`, `dispatch-authority.ts:104-137`, `work-envelope.ts:150-176,205-237`, `input-resolver.ts:141-163`, `eligibility.ts:210-234`.
- Contract: C-WORK `task.dispatch` — 선행 output/artifact 재확인, 같은 tx에 WorkEnvelope/Dispatch/current pointer/assignment Delivery, 새 process 없음; D-WORK §3-4; D-MAIL §3. IMP-14는 `createDispatch`를 단일 시도 생성 경로로 적는다.
- Evidence: (a) `ownerRoleId`만 맞추고 `spec.assignedMemberId`는 보지 않는다. `reserveDispatch`는 assignee pin을 강제한다 (`dispatch-authority.ts:128-137`). (b) 최신 assignment `ORDER BY revision DESC LIMIT 1`만 쓰며 `kind='task'`나 해당 `taskId` coverage를 요구하지 않는다. `buildTaskEnvelope`는 그 검사에서 거절한다. (c) 입력은 `resolveInputBindings`로, 최신 outcome의 artifact만 있으면 통과한다. `pinInputs`/`resolveTaskOutput`은 `settlements.decision IN ('accepted')`를 요구한다. (d) `plan_tasks` pin만 확인하고 `tasks.current_revision`은 보지 않는다 (`reserveDispatch:111`은 본다). (e) 손수 만든 envelope (`member.ts:1024-1034`)에는 `buildTaskEnvelope`의 `scope`/`peers`/`reportContract`(outputs+settlementPolicy)가 없다.
- Consequence: IMP-21 재사용 경로는 IMP-14 경로보다 약하다. 미수용·거부 outcome의 artifact로 후행 작업이 열릴 수 있고, member-pinned spec이 같은 role의 다른 member로 라우팅될 수 있으며, 인수한 WorkEnvelope에 보고 조건이 없다. 수명 독립(TaskSpec revision / artifact pin / Dispatch / mailbox)이 경로에 따라 다른 의미로 붕괴한다.
- Requested correction: covering task assignment를 만들거나 요구한 뒤 `createDispatch`/`buildTaskEnvelope`/`reserveDispatch`/`pinInputs`로 구현한다. 우회를 유지한다면 나열한 검사를 모두 이식한다.
- Target: IMP-21.

**6. [implementation] outcome 소비가 `task_revision`에 묶이지 않고, edge `settlementRequirement`는 dispatch 시점에 평가되지 않는다**

- Location: `packages/mahas-runtime/src/coordination/eligibility.ts:64-72` (`latestOutcome`은 `task_id`만, `ORDER BY revision DESC`); `121-149` (`edgeSettlementSatisfied`); `210-234`, `362-370`; `member.ts:968-1018` (`taskDispatch`는 `spec.inputs`만).
- Contract: D-MAIL §4 — TaskSpec이 바뀌면 이전 결과를 새 요구사항의 성공으로 옮기지 않는다; D-WORK §4 — join은 각 edge의 `settlementRequirement`와 정확한 ArtifactRef를 충족해야 eligible; C-WORK `task.dispatch` 전제(선행 output/artifact 재확인).
- Evidence: spec revision이 올라가도 옛 `outcomes.task_revision` 행이 후행 edge·`task-output`을 만족시킨다. `taskDispatch`는 inbound `task_edges`를 읽지 않아, inputBindings가 비어 있고 edge만 `accepted`를 요구하는 후행 task도 명시 dispatch할 수 있다. `computeEligibility`만 그 제약을 표시한다.
- Consequence: Finding 1이 해소된 뒤, 폐기된 요구사항의 결과가 새 spec의 성공으로 소비되고 DAG settlement가 advisory가 된다. 지시 2의 독립 수명(TaskSpec revision vs artifact pin vs Dispatch)이 투영·dispatch 양쪽에서 무너진다.
- Requested correction: outcome lookup을 충족 대상 spec의 `task_revision`으로 한정한다. dispatch 경로에서 inbound edge의 `settlementRequirement`/`requiredOutputNames`를 `pinInputs`와 함께 평가한다.
- Target: IMP-13 (eligibility) · IMP-21 (dispatch gate). Outcome writer보다 먼저 맞춰야 한다.

**7. [implementation] 첫 Task Dispatch의 phase `'assigned'`는 join이 `awaiting_accept`로 올리지 못해 `task.accept`가 실패한다**

- Location: `packages/mahas-runtime/src/launch/start-coordinator.ts:602-605` (`phase='assigned'`); `packages/mahas-runtime/src/launch/join.ts:256-263` (승격 조건 `phase IN ('reserved','starting','awaiting_join')`); `packages/mahas-runtime/src/launch/acceptance.ts:159-243` (`awaiting_accept`만 accept); D-WORK §2 phase 어휘는 `reserved/starting/awaiting_join/awaiting_accept/running/reported/settled/revoked`.
- Contract: D-WORK §2 — worker.start의 첫 tx가 Dispatch와 current pointer를 확정하고, join은 구성 확인, `task.accept`는 그 envelope 인수; C-WORK `task.accept` 전제(join 완료, active Dispatch).
- Evidence: `'assigned'`는 D-WORK 어휘에 없고 join UPDATE 집합에도 없다. join은 `dispatchesAdvanced=0`으로 끝나도 성공한다. 이후 `task.accept`는 `INVALID_TRANSITION` (`phase 'assigned'`). `task.dispatch` 재사용 경로는 처음부터 `'awaiting_accept'`를 넣어 (`member.ts:1105-1107`) 이미 조인된 실행에서만 accept가 가능하다. `reserveDispatch`는 `'reserved'`를 쓴다 — 생성기가 세 개다.
- Consequence: 최초 스폰된 task worker는 초기 지시에 적힌 `task.accept`를 완료하지 못한다. 인수·assignment Delivery ack 원자성(IMP-20)은 재사용 경로에서만 의미가 있다.
- Requested correction: `admitDispatch`가 D-WORK phase(`reserved` 또는 `awaiting_join`)를 쓰게 하거나, join 필터가 start가 실제로 기록한 phase를 승격하게 한다. 가능하면 첫 시도도 `reserveDispatch`를 탄다.
- Target: IMP-19 (phase 기록) · IMP-20 (join/accept 소비자).

**8. [implementation] coordination write가 admission의 mutation/effect 프로토콜을 우회한다 — `plan.prepare`는 저장인데 `mutation: false`이고, `run.close`/`team.retire` intent는 `effect_outbox`에 안 실린다**

- Location: `packages/mahas-runtime/src/coordination/index.ts:68` (`plan.prepare`, false); `plan.ts:498-520` (`plan_candidates` INSERT + `appendDomainEvent`); `admission.ts:215-244,327-337` (mutation일 때만 receipt); `run.ts:410-437`; `member.ts:739-755`; 비교 `admission.ts:473-518` 및 `storage/event-outbox.ts:125-151` (`effect_intents`+`effect_outbox`); pump는 outbox를 읽는다 (`recovery/reconciler.ts:634`).
- Contract: C-WORK `plan.prepare` 저장 효과는 후보 저장; REQ-14 (mutation은 operationId+fingerprint); REQ-20 (Run 결합과 자원 처분은 별도이나 처분 intent는 수행 가능한 effect여야 한다); C-WORK `run.close` “worker 자동 kill/GC는 별도 승인한 effect로만”.
- Evidence: `plan.prepare`는 후보 행과 domain event를 쓰지만 query로 등록되어 receipt가 없다. 같은 `operationId` 재시도는 중복 candidate를 만든다. event는 `txn.emitEvent`가 아니라 `appendDomainEvent` 직호출이라 query handler의 emit 가드를 우회한다. `run.close`/`team.retire`의 `worker.stop`/`claim.release` INSERT는 `effect_intents`만 채우고 outbox 행이 없다 — `txn.intendEffect`를 쓰면 둘 다 채워진다.
- Consequence: prepare는 멱등이 아니고, close/retire가 명시한 정리는 pump가 보지 못해 “별도 effect”가 기록만 되고 실행되지 않을 수 있다 (**추론**: reconciler는 outbox join만 읽는다; 이 검토는 pump를 실행하지 않았다). 지시가 묻는 transaction 경계 결함이다.
- Requested correction: `plan.prepare`를 `mutation: true`로 등록한다. close/retire의 외부 효과는 `txn.intendEffect` 또는 `stageEffectIntent`로 outbox까지 같은 tx에 넣는다.
- Target: IMP-13.

**9. [spec] PlanPatch TaskSpecRevision·InputBinding·Settlement decision 어휘가 고정되지 않아 구현이 세 갈래로 갈라졌다**

- Location: `spec/contracts/work.md:7` (`PlanPatch={… tasks:[TaskSpecRevision] …}` — TaskSpecRevision JSON 필드 없음); `spec/domains/work.md:13` (산문 이름 `inputBindings[]`/`outputSlots[]`); `spec/domains/messaging-outcomes.md:14,31` (decision 값 목록 없음); 구현 `packages/mahas-contracts/src/work.ts:173-205` (top-level `taskId`/`outputSlot`, `SettlementPolicy.mode`); `eligibility.ts:156-174` (nested `identity`); `input-resolver.ts:23-28,46-58` (`ACCEPTING_DECISIONS=['accepted']`, eligibility는 `'accept'`도 허용 `eligibility.ts:143`); `PlanView.tsx:71-80` (세 번째 모양).
- Contract: 같은 검토 범위의 C-WORK/D-WORK/D-MAIL이 한 wire를 가리켜야 한다.
- Evidence: 필드 이름(`inputs` vs `inputBindings`), binding 위치(top-level vs `identity`), output 키(`slot` vs `name`), disposition 키(`action` vs `disposition`), settlement 문자열(`accepted` vs `accept`)이 문서·계약 타입·eligibility·resolver·작업대에서 각각 다르다. Finding 4-6의 일부는 이 공백에서 자란다.
- Consequence: 구현자가 각자 합리적인 별칭을 고르면 DAG pin과 정산 의미가 조용히 달라진다. 자동 검사 범위(필수 필드·dispatch·artifact·revision)만으로는 잡을 수 없다.
- Requested correction: PlanPatch task 항목과 InputBinding, Settlement.decision 열거를 C-WORK/C-MAIL에 한 세트로 적는다. 별칭을 허용하려면 서버가 명시적으로 번역하고 미지 필드는 거절한다.
- Target: 명세 소유 (C-WORK/D-MAIL). 소비자 IMP-13/14/21/31이 한 wire에 수렴.

## Limitations

- 정적 검토다. 빌드·테스트·SQLite 실행·crash injection은 하지 않았다. Finding 2·8의 동시성·outbox pump 결과는 코드와 SQLite 문서에 따른 추론이며 관측된 실패가 아니다.
- Finding 1 때문에 지시 5(accepted outcome ↔ revision, cleanup과 비혼합)와 owner vs designated 실패 경로는 구현 부재로 검증 불가이다. 없는 코드를 오구현으로 단정하지 않았고, 부재 자체를 결함으로 기록했다.
- `assignment.show`는 등록된 stub이 `UNAVAILABLE_OPERATION`을 던진다 (`index.ts:76-84`). bootstrap 허용 목록에 이름이 있어 표면에는 보이나 내용은 없다. 정산 경로보다는 인수 보조 공백이다.
- worker.start envelope 본문·host/resource·CLI 전송은 이 범위의 호출 사슬을 따라가는 데 필요한 만큼만 읽었다.
- 작업대 필드 드리프트는 백엔드/`mahas-contracts` 이름을 정본으로 두었다. 명세가 D-WORK 산문 이름을 정본으로 두려면 서버 validator가 옮겨야 한다 — Finding 9.
