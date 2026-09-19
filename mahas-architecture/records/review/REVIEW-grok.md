# Review 취합 — grok

한 파일로 모은 grok 병렬 리뷰 요약. 원본 finding의 위치·계약·근거는 개별 `REV-*-grok.md`가 정본이다. 이 문서는 중복 나열이 아니라 **결합 판단과 잔여 blocker**를 한곳에 둔다.

- 작성: grok 병렬 리뷰 세션 (2026-09-19)
- 대상: `mahas-architecture` 계획의 packages 구현체 (`packages/*`, workbench, mahasd/host 조인)
- revision: code `8f6959457a8fc965c110dea79d533e53cf07326c`, spec `99eb5f5`
- 성격: 정적 의미 검토. 실행·crash injection·실제 하네스 수락은 하지 않았다. 컴파일/스모크 성공은 수락이 아니다.
- disposition: `accepted` / `changes-required` / `blocked`
- 산출: 국소 59 + 조인 11. `REV-01.md` … `REV-08.md`(접미사 없음)는 `-grok`와 본문이 같다.

## 한 줄 판결

**changes-required.** 32 IMP의 모듈과 `register*`는 있다. S-ARCH §7 화살표(탐색 → 배정 → 역할 구현 → 주입 → 협업 → 정산 → 정리)는 닫히지 않는다. HANDOFF의 “implemented”는 모듈 존재이지 계약 조인이 아니다.

| Review | 범위 | n | disposition |
| --- | --- | ---: | --- |
| REV-01 | 도메인·SQLite 정본·모델 | 11 | changes-required |
| REV-02 | 권한·비노출·위임 | 10 | changes-required |
| REV-03 | role + context 해상도 | 8 | changes-required |
| REV-04 | 협업·DAG·전달·정산 | 9 | changes-required |
| REV-05 | 실행·소유권·재부착·복구 | 9 | changes-required |
| REV-06 | API·CLI·하네스 경계 | 7 | changes-required |
| REV-07 | 작업대·운영·유지 | 5 | changes-required |
| REV-08 | 경계 조인 (위 59개를 재나열하지 않음) | 11 | changes-required |

선행 7건 code/spec revision은 모두 동일. 구현 패키지는 지정 revision과 이후 records-only HEAD 사이에 소스 drift 없음.

## 끊긴 사슬 (S-ARCH §7)

1. **책임 탐색** — API는 등록됨(`items`, `no-match`/`ambiguous`). 작업대 `projectId` 기본 `''`라 검색 disabled이거나, UI가 `candidates`를 읽어 서버 `items`를 버린다. 미공개 `candidate` 구현이 가용으로 나온다.
2. **배정** — preview 후 명시 클릭은 맞다. 그러나 (a) `expectedRevisions.plan`은 resolver가 없어 `STALE_REVISION`, (b) `candidate`가 `team.assign`을 통과, (c) 빈 `grantRevisions` + 비-provisioning seed라 operator-local도 `SCOPE_DENIED`. PlanPatch 필드명 불일치로 첫 DAG가 구조 오류/빈 spec.
3. **역할 구현** — 타입 분리는 유지. `deriveInterface`는 `requiredMeaning:'required'`. prepare `activation` JSON vs compiler 문자열 vs materializer `path`/`digest`가 갈라져 publish된 revision이 `context.build`에서 죽는다.
4. **실제 주입** — `mahas-harness-config`가 composition에 없음 → documented recipe는 `INJECTION_UNSUPPORTED`. connection 파일 모양이 CLI와 다름. 부팅 reconcile이 공유 HostSession을 `close()`. hello는 모든 연결을 `operator-local`로 만든다. stdin 바이트는 host spec에 안 실림.
5. **협업** — mail send/ack·generation rebind는 정합. 첫 Dispatch phase `'assigned'`는 join이 승격하지 못해 `task.accept` 실패. `assignment.show`는 stub. `inbox.wait`는 admission tx 안 poll.
6. **정산** — `task.report` / `outcome.decide` / `execution.wake` handler 없음. `task.dispatch`는 `pinInputs`/`reserveDispatch` 우회.
7. **정리** — `worker.release` 미등록. shutdown `caller` null이라 stop 미발행. 탭 close = `pty.kill`. restore는 liveness만 `unverifiable`로 두고 credential은 살린다.

국소적으로 맞는 조각(모델 publish CAS, mail 원자성, host가 `mahas.sqlite`를 안 염, CLI가 정적 업무 사전을 안 복제, packaged desktop이 daemon을 안 띄움)은 위 화살표가 닫힌 뒤에야 제품 흐름이 된다.

## 교차 긴장 (REV-08)

- **중앙 판단:** 논리 API는 분산 판단을 말하지만 hello가 wildcard operator grant로 승격하고, 빈 대상은 scope를 통과한다. 슈퍼유저 아니면 정지.
- **context dump vs 공백:** 인터페이스에 의미가 없고, 맞춰지면 maintenanceBasis가 실행 루트에 떨어진다. 화면은 비고 파일은 장문.
- **하네스 의존이 협업 API보다 앞섬:** recipe 미연결 + report/wake 부재. 에이전트는 unmanaged PTY+hook으로만 산다.
- **이중 실행 소유:** mahasd/host가 process owner인데 데스크톱 탭 X가 `pty.kill`. `tab.binding`은 타입만.
- **이중 정본:** connection writer 둘, bundle manifest 둘, reconciler 둘, Dispatch 생성기 셋, CommandSurface digest 셋.
- **unknown 붕괴:** 확정 host receipt를 필드명 불일치로 unknown에 접고, UI는 unknown을 실패 boolean으로 접는다.

## 조인 finding (REV-08) — 시스템이 한 흐름이 되지 못하게 하는 것만

| # | 제목 | Target IMP | 재검토 |
| ---: | --- | --- | --- |
| 1 | 단일 소켓 + client `principalId` → `operator-local` | 12, 30, 20 | REV-02, 06 |
| 2 | launch `connection/worker` ≠ CLI WorkerConnectionFile | 19, 20, 12 | REV-02, 06, 03 |
| 3 | `resolveTargets` 부재 → 빈 대상 allowlist | 11, 10, 13 | REV-02, 04, 06 |
| 4 | 탐색→배정 pin·작업대 봉투·provisioning이 배정을 닫음 | 06, 13, 31, 30 | REV-01, 02, 04, 07 |
| 5 | RoleInterface→compiler→materializer→LaunchRecipe 네 스키마, harness 미연결 | 30, 07, 08, 09, 19, 24, 25 | REV-03, 06 |
| 6 | materialize adapter가 envelope를 버리고 `service:mahasd`에 grant 없음 | 30, 19, 11 | REV-03, 05, 06 |
| 7 | 공유 HostSession close + C-HOST 필드명 불일치 | 23, 22, 18 | REV-05, 06 |
| 8 | 정산 op 부재, `task.dispatch`가 시도 불변식 우회 | 21, 14, 13 | REV-04, 07, 06 |
| 9 | 첫 Dispatch phase `'assigned'` → `task.accept` 실패 | 19, 20 | REV-04, 05 |
| 10 | release 미등록, shutdown이 stop 안 함, UI close=kill | 22, 23, 28, 30 | REV-05, 07 |
| 11 | **[spec]** TypedModelEdit / PlanPatch / InputBinding / LaunchRecipe / C-HOST 래핑이 한 스키마가 아님 | 명세 + 소비자 IMP | 계약이 움직인 모든 REV |

조인을 **단독으로 막지 않는** 국소 항목(REV-08이 재진술하지 않음): TypedModelEdit 방언(내부 model.change는 런타임 방언으로 동작), `inbox.wait` tx, AuthorizationDecision 누설, CLI 카피, host NUL 가드, `assignment.show` stub 단독, 표시 미연결.

## 경계별 finding 목록

### REV-01 도메인·저장 (11)

1. `model.change.prepare` 와이어 ≠ 계약 `ModelChangeEdit` — IMP-04
2. **[spec]** TypedModelEdit 필수 payload가 D-RDD §3에 없음 — IMP-02
3. `responsibility.locate`가 비조상 중첩을 최심 경계로 침묵 선택 — IMP-06
4. selectionToken이 implementation digest를 안 묶음 — IMP-06
5. 미공개 `candidate`가 탐색 가용 — IMP-06
6. `team.assign`/`preview`가 `candidate` 통과 — IMP-13
7. `plan.prepare`가 `mutation:false`라 멱등 밖 — IMP-13
8. `run.create`의 `coordinatorRoleId`가 저장·재검사에 없음 — IMP-13
9. `requirements_json` ≠ 계약 `RoleInterfaceRequirements` — IMP-07
10. `harness.profile.admit` attestation revision과 소비 경로 불일치 — IMP-07
11. TaskSpec `inputs_json` 파서 불일치, dispatch pin이 producer Run 미검사 — IMP-14

정합: Role/Task/Execution/ModelVersion/ContextBundle 분리. RDD SQLite 정본, `records.json`은 일회 import. publish CAS + Plan cycle 거부. search가 `no-match`/`ambiguous`/`stale`을 반환.

### REV-02 권한 (10)

1. hello가 `principalId` 신뢰, worker secret 미검증, 소켓 하나 — IMP-12/20/30
2. worker CLI env 삭제/`--as operator`로 operator fallback — IMP-12
3. 대부분 op에 `resolveTargets` 없음, 빈 대상 통과 — IMP-11
4. `worker.start`가 외부 spawn을 admission write tx 안 수행, pre-commit deny를 미실행으로 확정 가능 — IMP-19/11
5. bootstrap credential 발급·파일·검증 경로가 서로 다른 계약 — IMP-20/19/12
6. AssignmentGrant의 task/role/boundary가 coverage에 안 쓰여 Run 전체로 열림 — IMP-13/10
7. 인가 거절 영수증이 AuthorizationDecision 전체(실제 대상)를 worker에게 반환 — IMP-10
8. CommandSurface digest가 help/prepare/join 세 갈래 — IMP-11/19/28
9. ProvisioningGrant 한도가 `team.assign`에 없고 placement JSON이 둘 — IMP-13/10
10. CLI/help가 same-user shell 한계를 표시하지 않음 — IMP-12/32

정합: child grant 축소, RDD contains 자동 승격 없음, mailbox는 `ctx.memberId`, `execution.join` 대리 거부(단 F1과 충돌), CLI help는 `surface.describe`, revoke 모듈 자체는 미실행 거짓 확정 안 함.

### REV-03 role/context (8)

1. RoleInterface가 clause-id flags (`requiredMeaning:'required'`) — IMP-07
2. 팀장 해상도(가치·긴장) 공식 저작 경로 없음 — IMP-07
3. IMP-07 저장 DTO를 IMP-08 compiler가 못 읽음 — IMP-08
4. compiler manifest ≠ materializer parser — IMP-09
5. instruction/skill/subagent/tool이 native loading point에 미연결, harness-config 미import — IMP-19
6. WorkEnvelope·source snapshot pin이 materialize에 전달 안 됨 — IMP-19
7. `maintenanceBasis`가 실행 `role/manifest.json`에 실림 — IMP-08
8. IMP-32 inspector 화면 없음, coverage가 첫 binding만 — IMP-32

정합: 네 객체 분리, conditional-only 필수 clause는 publish 거절, reexpressed가 원본 path를 다시 넣으면 거절, envelope는 bundle과 별도 digest, join은 이해 증명 아님, native-resume은 같은 pin, profile `verified`는 docs-only로 승격 안 됨.

### REV-04 협업·정산 (9)

1. `task.report`/`outcome.decide`/`execution.wake` handler 없음 — IMP-21
2. `inbox.wait`가 admission tx 안 bounded poll — IMP-15/11
3. 작업대가 `expectedPlanRevision`을 빼고 `expectedRevisions.plan`만 보냄 — IMP-31/13
4. PlanPatch `disposition`/`inputBindings` vs 서버 `action`/`inputs` — IMP-31
5. `task.dispatch`가 `createDispatch`/`pinInputs`/`reserveDispatch` 우회 — IMP-21
6. outcome 소비가 `task_revision` 맹목, edge settlement는 dispatch 시 미평가 — IMP-13/21
7. 첫 Dispatch phase `'assigned'` → join 미승격 → `task.accept` 실패 — IMP-19/20
8. `plan.prepare` mutation:false, close/retire intent가 `effect_outbox`에 안 실림 — IMP-13
9. **[spec]** PlanPatch/InputBinding/Settlement.decision 어휘 미고정 — C-WORK/D-MAIL

정합: Run은 scheduler 아님. Plan immutable+CAS. peer `message.send`. `replyAndAck` 원자. generation fence. `task.accept`는 pin·join·ack를 한 tx(단 F7 phase 전제). artifact는 digest pin. IMP-14 `reserveDispatch`/`pinInputs` 경로는 엄격.

### REV-05 실행·복구 (9)

1. 공유 HostSession을 reconcile/probe/stop이 `close()` — IMP-23/22
2. C-HOST 요청/응답 모양이 mahasd가 읽는 모양이 아님 (probe/stop/spawn/effect) — IMP-22/18/19
3. boot `runtime.reconcile` ≠ `reconcileExecutions`; inventory pid를 live로 볼 수 있음 — IMP-23/22
4. `worker.release` 구현됐으나 미등록 — IMP-22
5. `runtime.shutdown` drain이 `worker.stop`을 안 보냄 (`caller` null) — IMP-23
6. native-resume/fresh가 새 generation을 admit하나 `worker.start`가 spawn 못 함 — IMP-22/19
7. stdin 첨부 증거를 기록하고 프로세스에는 바이트를 안 씀 — IMP-19/18
8. workspace mutation이 advisory lease TTL로 살아 있는 controller를 거절, mahasd 미갱신 — IMP-17/16/23
9. `backup.restore`가 liveness만 unverifiable, credential/generation은 살아 있음 — IMP-29

정합: mahasd vs host DB writer 분리, OS child는 host만, TTL-takeover 거부, spawn 전 journal, stop은 pid+starttime 재증명, claim exclusivity, InputLease CAS(mahasd 경로), 패키지 desktop은 daemon 미spawn.

### REV-06 API·CLI·하네스 (7)

1. worker/operator endpoint 미분리, hello → `operator-local` — IMP-12/30/20
2. IMP-24/25 recipe가 composition 미연결, `recipe_json` ≠ LaunchRecipe argv — IMP-30/07/19/24/25
3. connection 바이트 ≠ WorkerConnectionFile — IMP-19/12/20
4. `assignment.show` stub이 usable surface에 올라감 — IMP-13/11
5. receipt/retry/목록 의미가 CLI·UI·RPC에서 갈라짐 — IMP-31/12/30
6. `host.process.spawn`이 NUL·인자 한도 미거부 — IMP-18/17
7. `service:mahasd` makeCaller에 grant 없어 내부 op `UNAVAILABLE_OPERATION` — IMP-11/30

정합: C-HOST 15개는 worker registry 밖. 미구현 5개 공개 연산은 surface에서 빠짐(`UNAVAILABLE_OPERATION`). CLI는 `surface.describe`. 모델/access/mail/task는 harness-config를 import하지 않음. profile `verified`는 documented만으로 안 됨. eslint 의존 방향.

공개 77 vs 등록: handler 71 + stub 1 + 미등록 5. C-HOST 15 정합. spec 밖 internal `DISPATCH_OPS` 16이 worker registry에 `visibility:'service'`로 존재.

### REV-07 작업대 (5)

1. 탭/페인 close·Restart = process kill. view detach와 stop이 한 버튼 — IMP-28
2. live/unverifiable/needs-input/report/accepted/released가 화면에 다른 증거가 아님 — IMP-28
3. 작업대 와이어 ≠ C-DISCOVERY/C-WORK (context 미바인딩, 필드명, PlanPatch, hydrate) — IMP-31
4. IMP-32 inspector 화면 없음, 있는 projection도 `context.inspect`와 어긋남 — IMP-32
5. stale 분류·backup/restore/GC 정본이 화면에 없어 로컬 resume과 구분 안 됨 — IMP-28/27/29

정합: 서버 `terminal.detach`/`unbind` 자체는 process를 안 죽임. search는 배정이 아님. inspect는 없는 coordination view를 합성하지 않음. native resume는 unmanaged CLI reopen. restore receipt의 `restored-unconfirmed`는 서버에서 정직.

## IMP owner별 잔여 (조인 blocker만)

| IMP | 할 일 |
| --- | --- |
| 06 | published만 가용; token에 impl digest; locate = `resolveTerritory` |
| 07 | RoleInterface 의미 문장; `requirements_json` 계약 객체; `recipe_json`=LaunchRecipe; admit attestation |
| 08 | compiler 입력 = IMP-07 저장 DTO; maintenanceBasis를 실행 파일에서 제거 |
| 09 | materializer parser = compiler manifest |
| 10 | 빈 대상 deny; AssignmentGrant에 task/role/boundary; grantRevisions를 credential에서 |
| 11 | resolver 없는 mutation 거부; visibility 집행; service principal |
| 12 | 두 소켓; worker hello verify; CLI operator fallback 제거 |
| 13 | candidate 거부; provisioning을 활성 행으로; resolveRevisions/Targets; coordinatorRole |
| 14 | InputBinding 코덱 단일화; outcome을 task_revision으로 pin |
| 16 | workspace `assertLease`가 TTL을 사망으로 쓰지 말 것 |
| 17 | 인증된 세션에 token 없는 hello 금지; lease TTL vs epoch |
| 18 | `expectedProcessIncarnation` alias; spawn/stop/effect 래핑; stdin ContentRef |
| 19 | `writeWorkerConnection`; D-WORK phase; spawn을 닫힌 tx 밖; argv[0]; stdin on spec |
| 20 | authenticateWorkerCredential을 serveRpc에; join이 start phase 승격; assignment.show |
| 21 | report/decide/wake 구현·등록; `task.dispatch` → `createDispatch` |
| 22 | `worker.release` 등록; `reconcileExecutions`를 boot에; native-resume/fresh가 새 start |
| 23 | 공유 session close 금지; shutdown에 caller; inventory pid≠live |
| 24/25 | documented draft가 LaunchRecipe+native routes |
| 28 | managed close=detach; Restart≠자동 spawn; `runtime.snapshot` 화면 |
| 29 | restore 시 credential revoke + join 거부 |
| 30 | authenticator/seed/service grant/harness import/materialize adapter/lifecycle caller |
| 31 | workbench context + C-DISCOVERY/C-WORK 필드명 |
| 32 | inspector 화면 마운트; view model을 `attached[]`에 |

수정은 원래 IMP의 **새 implementation revision**. 계약이 움직이면 소비자 REV를 같은 revision에서 다시 돈다. 과거 review를 새 코드에 자동 승계하지 않는다.

## 이 리뷰가 실행하지 않은 것

mahasd/host 기동, hello 실패 재현, CLI connection 파싱 거절, documented profile `INJECTION_UNSUPPORTED` 호출, `task.report` UNAVAILABLE, 작업대 클릭, tab close → pty.kill, crash injection, lease 120s, restore 후 join, typecheck/lint를 수락으로 쓰는 것, VER-01..12, 실제 하네스 수락(VER-09..11).

## 사용법

- 수정 배정 → 위 IMP 표 + `REV-08-grok.md` Combined findings.
- 상세 근거·줄번호 → 개별 `REV-*-grok.md`. 이 파일만으로 패치하지 말 것.
- 코드가 바뀌면 이 취합을 새 revision에 자동 승계하지 말 것. 영향 받은 REV를 다시 돈다.
