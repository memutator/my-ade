# ReviewRecord — REV-07 (reviewer: grok)

> 본 기록은 grok 병렬 리뷰 산출이다. 검토 대상은 `mahas-architecture` 워킹트리(codeRevision `8f6959457a8fc965c110dea79d533e53cf07326c`, specRevision `99eb5f5`)의 packages 구현체다.

- reviewTaskId: REV-07
- codeRevision: 8f6959457a8fc965c110dea79d533e53cf07326c
- specRevision: 99eb5f5
- scope: Independent operator/UX review of IMP-26/27/28/29/31/32 — desktop workbench widgets (`src/renderer/src/workbench/*`, `WidgetView`), C-CLIENT view/terminal paths (`packages/mahas-runtime/src/client/*`, preload/runtimeClient), C-OBSERVATION snapshot/intervention/attention, IMP-32 inspector library, C-DISCOVERY search/inspect/preview, IMP-27 impact classification, IMP-29 backup/restore/GC, and existing resume/attention UI — against REQ-04/06/21/23/24/27, C-CLIENT, C-OBSERVATION, D-RESOURCE, C-RECOVERY.
- disposition: changes-required

Verified aligned (no findings): C-CLIENT `terminal.detach` / `client.view.unbind` themselves do not stop a process or mint authority (`client/terminal.ts:401-468`, `client/views.ts:4-8,91-140`). `requestRuntimeShutdown` is not reached from any renderer path (`runtimeClient.ts:197-201`). Inspector op allow-list omits `worker.start` (`inspector/ops.ts:30-33`). `responsibility.search` does not assign — queueing is not `team.assign`, and assign is a second explicit click after preview (`ResponsibilityView.tsx:137-140`, `TeamView.tsx:319-328`). `responsibility.inspect` does not synthesize a missing coordination view and does not ship child context bodies (`inspect.ts:11-13,219-233`; `types.ts:268-299`). Native resume stays a typed CLI command into an unmanaged tab and is not converted into a Task/accepted outcome (`resume.ts:1-12,125-142`; `ResumePrompt.tsx:11-15`; `operations/migration.ts:423-448` inserts unbound `observations` with `execution_id NULL`). `backup.restore` marks stored `live` executions `unverifiable` and returns `runtimeState: 'restored-unconfirmed'` (`restore.ts:253-324,362`).

## Findings

**1. [implementation] 탭·페인 close와 Restart가 곧 process kill이다 — view detach와 worker stop이 한 버튼이다**

- Location: `src/renderer/src/components/LeafPane.tsx:207,232-236` (`closeTab` drops the tab record; `restartTab` calls `window.mahas.pty.kill` then clears `pty` so remount spawns); `src/renderer/src/components/TerminalPane.tsx:523-538` (unmount kills the session iff the tab record no longer owns that `pty` id); `src/renderer/src/store.ts:776-785` (detached `closePane` kills every term pty); `src/renderer/src/types.ts:49-54` (`binding?: ExecutionBinding` exists but is never set); renderer never calls `window.mahas.exec.bindView` / `unbindView` or `terminal.attach`/`detach` (only the IPC stubs in `src/preload/index.ts:212-217` and `src/main/runtimeClient.ts:255-275`).
- Contract: REQ-12/REQ-23; C-CLIENT `terminal.detach` / `client.view.unbind` (“구독과 해당 client가 소유한 input lease만 해제 … process stop은 하지 않는다”, “UI binding 삭제 … 실행/자원 소유 유지”); D-RESOURCE ClientViewBinding (“detach는 worker stop 아님”); S-ARCH §5 (“UI close = detach”); IMP-28 §4.2–4.5·§5 (“managed tab close는 view detach, worker stop은 별도 명령”, “구독 해제와 실행 종료를 같은 버튼으로 묶지 않는다”, “retry 버튼이 새 worker를 자동 만드는 경로를 제거”).
- Evidence: 닫기 경로의 유일한 부작용은 탭 레코드 삭제 → xterm unmount → `pty.kill`. `tab.binding`을 검사하는 분기는 없다. Restart는 명시적 kill 후 같은 탭에 새 spawn이다. 서버 쪽 unbind/detach는 process를 건드리지 않으나, 데스크톱 화면은 그 연산을 호출하지 않는다. `runtime.shutdown`은 창 닫기와 분리되어 있어(검증됨) 모순은 **탭 단위 close/restart**에 있다.
- Consequence: 운영자가 탭 X를 누르면 관측 구독이 아니라 셸/에이전트 프로세스가 죽는다. 나중에 `binding`이 붙어도 같은 버튼이 managed worker를 죽인다. Restart는 IMP-28이 금지한 “retry → 새 worker 자동 생성”이다. 권한(InputLease)·실행 소유와 UI 초점이 한 제스처로 묶여 오판된다.
- Requested correction: managed 탭의 close는 `client.view.unbind` / `terminal.detach`(observe 구독만 해제)로 두고, process stop은 별도 명령(라벨·확인 포함)으로 분리한다. unmanaged pty 탭도 그 구분을  entangle하지 말 것. Restart는 managed Execution에 대해 새 spawn이 아니라 명시 `worker`/`host` stop+start여야 한다.
- Target: IMP-28

**2. [implementation] live / unverifiable / needs-input / report / accepted / released가 운영 화면에서 서로 다른 증거가 아니다**

- Location: Operator chrome — `src/renderer/src/utils.ts:54-70` (`TabStatus = working | input | error | news`); `src/renderer/src/components/AgentsPanel.tsx:10-16,115`; `src/renderer/src/attention.ts` (hook/pty-idle만). Control-plane projection that is never rendered — `packages/mahas-runtime/src/observation/projection.ts:131-216,422-447` (`liveness` vs `storedLiveness` vs `activity` vs Task outcome 분리); `src/renderer/src/workbench/ops.ts:93-94` (`runtimeSnapshot` 정의만 있고 workbench 뷰에서 호출 없음). Intervention/residual UI 없음. `exec:subscribe`는 스트리밍 미협상으로 `CONTROL_UNAVAILABLE` (`runtimeClient.ts:302-315`) — 정직한 거절이나 snapshot poll도 화면에 없다.
- Contract: REQ-11/REQ-23/REQ-24; C-OBSERVATION (hook/process fact와 Task/Delivery 정본을 섞지 않음); D-RESOURCE §2·§5; IMP-26 §4.2 (“stored status는 restored-unconfirmed, live/working/Task outcome을 각각 유지”); IMP-28 §4.5 (“control unavailable, start/stop unknown, residual resource, permission intervention을 서로 다른 상태로 표시”).
- Evidence: 탭/에이전트 리스트는 로컬 hook 알림과 pty `working`만 본다. `news`(읽지 않은 turn-complete)와 Task `report`/`accepted`는 구별되지 않는다. Observation `activity: 'unknown'`과 execution `liveness: 'unverifiable'`(에포크 증거 없는 stored-live, restore 후 포함)을 그리는 위젯이 없다. ResourceClaim `released`·Intervention `open/claimed/resolved`·ResidualResource는 데스크톱에 표면이 없다. 권한 prompt는 여전히 해당 터미널로 점프하는 레거시 경로이며 `intervention.resolve` 화면이 아니다.
- Consequence: 운영자는 “에이전트가 일을 끝냈다”(탭 점)를 업무 수용으로, restore된 unverifiable writer를 live로, permission 개입을 하네스 내부 승인으로 읽을 수 있다. IMP-26이 분리해 둔 증거가 화면에서 다시 한 점으로 접힌다.
- Requested correction: `runtime.snapshot` 엔티티를 운영 화면에 바인딩하고, 최소한 execution `liveness`/`storedLiveness`/`activity`, Task/Dispatch 국면(`reported`/`accepted`는 별 칩), claim `released`, Intervention 상태, residual을 서로 다른 라벨로 표시한다. 로컬 hook 점등은 observation fact이지 settlement가 아님을 명시한다. control unavailable은 빈 목록이 아니라 현재 `OpError` unavailable과 같은 정직한 상태여야 한다.
- Target: IMP-28 (표시·바인딩; IMP-26 projection은 이미 분리되어 있음)

**3. [implementation] 팀장 작업대는 C-DISCOVERY/C-WORK 와이어와 어긋나 책임·배정·계획을 잘못 보여주거나 아예 호출하지 못한다**

- Location:
  - Context never bound: `workbench/store.ts:27-32,61-69` (`projectId`/`modelVersion`/`runId` 기본 `''`, 주석은 workspace project를 기본값이라 하나 `setContext` 호출처 없음); `ResponsibilityView.tsx:356` (search는 `!projectId`면 disabled); `TeamView.tsx:369` / `PlanView.tsx:161` (`runId` 없으면 load/assign 불가).
  - Search/inspect/locate/collaborators/implementations 필드: UI `contracts.ts:147-153,170-180,192-205,231-233,247-254` (`candidates`, 평탄 `responsibility`/`viewStatus`/`coordinationView?: string`, locate `results`+`assigned`, collaborators `collaborators[]`+`memberId`/`relationReason`, `implementationRevision`); 서버 `discovery/search.ts:655-661` (`items`), `inspect.ts:219-233` (`boundary` + `coordinationView: {status, clauses}`), `types.ts:287-299,325-357,382-399,412-423` (`items`, locate `resolved`, `Collaborator.role`/`members[]`, `ImplementationAvailability.revision`). 뷰: `ResponsibilityView.tsx:38-46,184-194,410,452-475,491-507`; `TeamView.tsx:102-117,238-264`.
  - Plan patch / CAS (REV-04 #3·#4, 이 revision에서 재확인): `PlanView.tsx:60-90` (`inputBindings`/`outputSlots`, `disposition: 'keep'|'stop'`); `ops.ts:110-116,133-138` (`expectedPlanRevision`을 payload에서 제거하고 envelope `expectedRevisions.plan`); 서버 `coordination/plan.ts:76-82,178-210,527-573` (`action ∈ keep|revoke|replace`, `inputs`/`outputs`, payload `expectedPlanRevision`); `coordination/index.ts:60-75` (`resolveRevisions` 없음); `api/admission.ts:343-364`.
  - Plan hydrate: `PlanView.tsx:110-118,186-188` (`loadRun`은 `planRevision`만 채움, `setTasks`/`setEdges` 없음; 빈 draft에 `wbNoTasks` = “No tasks in this plan revision”); 서버 `coordination/run.ts:212-231` (`planTasks`/`planEdges`/`eligibility`).
  - Screen identity: `utils.ts:32-33` (non-usage widget 탭 라벨이 전부 `widgetAgents`); `i18n.ts:298` (`wbRoleOnly` = “Role only — no implementation” — 실제로는 Member 없음).
- Contract: REQ-04/REQ-06/REQ-17; C-DISCOVERY (`CandidateCard[]`, inspect 해상도, no-match/ambiguous/stale을 다른 상태); C-WORK `assignment.preview`/`team.assign`/`plan.prepare`/`plan.commit` (`expectedPlanRevision`은 payload, PlanPatch `action`/`inputs`/`outputs`); IMP-31 §4.1–4.4.
- Evidence: 정적 경로만으로도 search 버튼은 영구 disabled이거나, 호출되어도 `resp.candidates`가 `undefined`라 카드가 비고 서버 `status: 'no-match'|'ambiguous'|'unassigned'`는 버려진다. Inspect는 `coordinationView` 객체를 문자열로 그려 `[object Object]`가 되고 `responsibility`/`criteria`/`viewStatus`는 비어 있다 — missing-view 분기도 타지 않는다(`coordinationView == null`이 아님). Locate/collaborators는 `results`/`collaborators`를 읽어 서버 `items`를 놓친다. `role.implementations`의 `revision`은 UI `implementationRevision`에 안 들어가 preview/assign payload가 `< 1`로 거절된다. Preview의 `contextBlockers`가 있어도 Assign은 `phase === 'previewed'`만 보면 활성화된다 (`TeamView.tsx:321-324`). Plan commit은 envelope STALE + handler `expectedPlanRevision ?? 0`으로 이중 실패. 기존 태스크를 화면에 올리지 않은 채 “이 revision에 태스크 없음”이라고 말한다.
- Consequence: 팀장은 빈 검색을 “담당 역할 없음”으로, inspect 공백을 “책임 없음”으로, 빈 Plan 에디터를 “빈 DAG”로 읽는다. 배정 preview의 구현 핀·blocker를 신뢰할 수 없고, commit은 UI가 성공처럼 보여도 서버가 거절한다. REV-04 finding 3·4는 이 code revision에서도 그대로다.
- Requested correction: workbench에 project/modelVersion/run 컨텍스트 입력을 두고 활성 workspace와 연결한다. UI 필드를 서버 envelope에 맞춘다(`items`, `boundary.*`, `coordinationView.status/clauses`, locate `resolved`, collaborator `members`, `implementationRevision`←`revision`, PlanPatch `action`/`inputs`/`outputs`, payload `expectedPlanRevision`). no-match/ambiguous/stale/implementation-missing을 성공 envelope의 `status`로 구분 표시한다. `run.get`의 `planTasks`/`planEdges`/`eligibility`를 에디터에 로드하고, 빈 로컬 draft를 “이 plan revision에 태스크 없음”으로 부르지 않는다. Preview blocker가 있으면 assign을 막거나 위험 인수로 재확인한다.
- Target: IMP-31 (envelope/resolver를 서버가 소유한다면 IMP-13 보조)

**4. [implementation] IMP-32 역할·context·권한·spawn Inspector 화면이 없고, 있는 projection도 context.inspect 봉투와 어긋난다**

- Location: Desktop mount — `src/renderer/src/types.ts:10` (`WidgetKind`에 inspector 없음); `src/renderer/src/components/WidgetView.tsx:189-201` (responsibility/team/plan/agents/usage만); `src/renderer/src/components/LeafPane.tsx:455-481` (동일 메뉴). Library only — `packages/mahas-runtime/src/inspector/{ops,protocol,views}.ts` (renderer/CLI import 0건). Envelope mismatch — `inspector/protocol.ts:220-230` (`attachedReceipt: InjectionReceipt | null`); `inspector/views.ts:328-361` (planned / single-receipt evidence / `hasReceipt` / `workerJoined` — materialized 레인이 없음); 실제 op — `realization/effective-context.ts:77-105,196-213` (`planned` + `attached[]` phases including `materialized` + `inherited` + `unknowns`).
- Contract: REQ-05/REQ-06/REQ-07/REQ-13; C-REALIZATION `interface.get`/`context.inspect`; IMP-32 §4.1–4.5·§6 (interface→component coverage 편집, CommandSurface vs 실제 grant 분리, planned/materialized/attached/worker_joined/inherited unknown 나란히, worker.prepare pins/blockers와 start receipt stages/residuals; “manifest가 존재한다고 주입 완료를 단정하지 않음”).
- Evidence: 데스크톱에 coverage editor, surface-vs-grant inspector, injection inspector, spawn-ladder 화면이 없다. `inspector/views.ts`의 5레인 주석은 `projectContextInspect`가 단일 `attachedReceipt`만 걸어 구현하지 못하며, 그 함수는 실제 `context.inspect` 결과(`attached` 배열)를 받으면 `hasReceipt=false`로 주입 증거를 숨긴다. 구현 본문 자동 펼침은 검색 쪽에 없으나(검증됨), Inspector 부재로 운영자/구현자는 파일·숨은 문서로 coverage와 실제 주입을 추적해야 한다 (검토 지시 5).
- Consequence: “인터페이스 조항을 구현한 구성품”과 “실제로 argv/config에 붙은 바이트”를 화면에서 구별할 수 없다. requiredActions 편집을 권한 부여로 오인할 표면도, 막은 표면도 없다. worker.prepare blocker와 start residual을 보지 못한 채 spawn했다고 판단할 수 있다. 이후 이 라이브러리를 그대로 붙이면 materialized receipt가 “미주입”으로 보인다.
- Requested correction: IMP-32가 명시한 데스크톱 화면을 마운트하고, view model을 `context.inspect`의 planned / attached.phase(`materialized` 포함) / join / inherited / unknowns에 맞춘다. surface.describe와 access.inspect를 별 섹션으로 둔다. worker.prepare pins/blockers와 worker.inspect stage/residuals를 표시하되 start는 호출하지 않는다 (현재 allow-list는 유지).
- Target: IMP-32

**5. [implementation] stale 후보 분류와 backup/restore/GC 정본이 작업대에 증거로 나타나지 않아, 로컬 resume·탭 상태와 구분되지 않는다**

- Location: Classification ops exist (`maintenance/classification.ts:31-45,65-70` — `confirmed|dismissed|resolved` + rationale + resolutionRef; `impact-service.ts`) but no workbench/widget calls `model.impact.list`/`classify`. Restore receipt is honest (`operations/restore.ts:75-87,313-324`) but unused in UI. Desktop resume (`ResumePrompt.tsx`, `resume.ts`) continues to offer native CLI reopen of unmanaged sessions. Tab lights (Finding 2) remain the only “is it alive?” signal after restore.
- Contract: REQ-21/REQ-27; D-RESOURCE ImpactCandidate / MigrationReceipt / BackupSet; C-RECOVERY `backup.restore` (“모든 과거 실행은 reconciliation 필요”); IMP-27 §4.3–4.4 (분류는 책임자 작업, runtime이 Task를 발명하지 않음); IMP-29 §4.4 (restore 후 unconfirmed).
- Evidence: 레거시 import·resume가 Task를 만들지 않는 것은 정직하다(검증됨). 문제는 **표시**: restore 이후 제어면은 `unverifiable`/`restored-unconfirmed`인데 데스크톱은 같은 탭을 이전과 같이 working/news로 보여 준다. ImpactCandidate `candidate` vs `resolved`(실제 resolution ref)를 고르는 UI가 없어, 운영자는 파일 해시나 검색 카드의 구현 availability를 “이미 유지 반영됨”으로 오해할 수 있다. GC가 published/live-or-unknown/accepted/backup pin을 보존하는 것은 서버 로직이며(`gc.ts:1-7,291`) 운영 화면의 dry-run/residue 표시는 없다.
- Consequence: 전환·복구 뒤에 운영자가 로컬 세션 복구 성공을 live writer 권한·관리 Task 복원으로 읽거나, 미분류 stale 구현을 현재 지침으로 배정할 수 있다. API는 정직하나 작업대 경로가 그 정본을 가린다.
- Requested correction: 최소한 운영 표면(작업대 또는 연결된 operator 뷰)에 restore/reconciliation 국면(`restored-unconfirmed` vs live evidence), ImpactCandidate 상태+rationale+resolutionRef, GC residue를 로컬 resume 후보와 나란히 표시한다. ResumePrompt에 unmanaged native resume임을 명시하고 managed Execution으로 승격하지 않는다 (현재 변환은 없으나 라벨이 “agent sessions”만으로는 부족하다).
- Target: IMP-28 (표시·이관 라벨; 분류 연산은 IMP-27, receipt는 IMP-29)

## Limitations

- 정적 UI-경로 검토다. Electron 작업대를 클릭하거나 `runtime.snapshot`/`backup.*`/`model.impact.*`를 실행하지 않았다. 실패는 코드 경로와 계약 불일치로 추론했으며 관측된 런타임 예외로 쓰지 않았다.
- IMP-21 outcome 파이프라인 부재(REV-04)는 재검토하지 않았다. `report`/`accepted` 표시 부재는 그 파이프라인이 살아 있어도 화면이 구독하지 않는다는 점까지만 다룬다.
- IMP-27/29의 서버 보존 규칙(pin, unconfirmed mark, 분류 전이)의 저장 정확성은 REV-01/05 범위에 가깝다. 여기서는 운영자가 그 정본을 화면에서 오판하는지만 보았다.
- CLI 일반 동사 표면(`mahas <op>`)이 backup/impact의 의도된 운영 UI인지는 실행해 확인하지 않았다. 있어도 데스크톱 작업대 경로의 오판은 남는다.
- `exec:subscribe` 미협상은 정직한 unavailable로 기록했고, snapshot poll 부재와 합쳐 Finding 2의 일부로만 취급했다.
