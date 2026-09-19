# ReviewRecord — REV-01

- reviewTaskId: REV-01
- codeRevision: 8f6959457a8fc965c110dea79d533e53cf07326c
- specRevision: 99eb5f5
- scope: IMP-02 도메인 타입(`packages/mahas-contracts/src/{ids,common,rdd,role,work,ops,index}.ts`), IMP-03 SQLite 경계(`packages/mahas-runtime/src/storage/{migrations,database,db,transaction,blob-store,receipt-store}.ts`와 host twin), IMP-04/05 모델 변경·불변식·인덱스(`packages/mahas-runtime/src/model/{repository,change-set,structural-rules,publisher,ops,indices,territory,impact-candidates}.ts`), IMP-06 탐색 API(`packages/mahas-runtime/src/discovery/{search,locate,inspect,collaborators,implementation-availability,selection-token,visibility,model-read,types}.ts`), IMP-07 실현(`packages/mahas-runtime/src/realization/{interfaces,implementation-repository,publisher,component-graph,profile-registry}.ts`), IMP-13/14 협업(`packages/mahas-runtime/src/coordination/{run,plan,member,task-spec,work-envelope,input-resolver,eligibility,index}.ts`)과 composition의 selectionToken 어댑터. REQ-02/03/04/05/17/22와 D-RDD, D-ROLE, D-WORK, S-STORAGE, C-DISCOVERY를 기준으로 읽었다. 앱/DB를 실행하지는 않았다.
- disposition: changes-required

Verified aligned.

- Role / Task / Execution / ModelVersion / ContextBundle / WorkEnvelope / LaunchPlan은 별도 타입·테이블이다. `Execution`에 Task 링크가 없고, `Role.description`은 책무, `TaskSpec.requirementText`는 이번 업무, coordination envelope는 mandate/goal/roleContext만 넣으며 가짜 task/dispatch를 만들지 않는다.
- 활성 RDD 정본은 `projects.active_model_version` → SQLite snapshot이다. `records.json`은 `importLegacyRecords`의 일회성 복사(지문 idempotent)이며 watcher/Git writer로 연결되지 않는다. Context 행은 path만 저장한다.
- 공개 시 `validateCandidate`가 root 1개, connected acyclic tree, dangling FK, boundary당 criterion ≥1, repo-relative path를 거부하고, `casActiveModelVersion` + digest 재계산 후 새 `model_versions` 행을 INSERT한다. published payload를 UPDATE하지 않는다. Plan은 `findCycle`과 cross-run endpoint, active-attempt disposition을 prepare 진단/commit 거부로 막는다.
- `responsibility.search`는 `no-match` / `unassigned` / `ambiguous`와 `staleModel`을 반환하고, `role.implementations`는 `implementation-missing` 결과 상태를 쓴다. inspect coordination view가 없으면 `missing`을 반환하며 자식 본문을 만들지 않는다. split은 부모 responsibility를 남긴다.

## Findings

**1. [implementation] `model.change.prepare` 와이어가 계약 타입 `ModelChangeEdit`와 다르다**

- Location: `packages/mahas-runtime/src/model/change-set.ts:35-170` (`ModelEdit` / `normalizeEdits`), `packages/mahas-runtime/src/model/ops.ts:417`; 계약 `packages/mahas-contracts/src/rdd.ts:190-280`
- Contract: C-MODEL `edits:TypedModelEdit[]`; D-RDD §3; SHARED-APIS가 `ModelChangeEdit`를 정본 이름으로 고정
- Evidence: 계약은 평탄한 판별 유니온이다 (`boundary.create {boundaryId, name, responsibilityStatement, parentBoundaryId}`, `boundary.reparent {newParentBoundaryId}`, `context.register {contextId, path}`). 런타임은 중첩 객체와 다른 필드명을 요구한다 (`boundary: {id, name, responsibility, parentId}`, `newParentId`, `context: {id, path}`). 패치 의미도 다르다 — 계약 `boundary.revise.paths` / `contract.revise.consumerBoundaryIds`는 전체 치환, 런타임은 `setPaths|addPaths|removePaths`와 `addConsumerBoundaryIds|removeConsumerBoundaryIds`. 런타임만 `boundary.retire.remap`과 split의 `contractProviderRemap`/`contractConsumerRemap`/`nonGoalRemap`/`contextRemap`을 갖는다. `change-set.ts:35-36`은 이 형태를 "proposal for IMP-02's ModelChangeEdit"라고 적는다. prepare/commit은 `normalizeEdits`만 사용하므로 계약 클라이언트의 JSON은 `MODEL_INVALID`로 거절된다.
- Consequence: C-MODEL 경계의 정본 타입이 실제 mutation 입력이 아니다. 저장된 `model_changes.edits_json`도 런타임 방언이라 계약 재현이 불가능하다.
- Requested correction: `normalizeEdits`가 `ModelChangeEdit`를 받아들이게 맞추거나, 런타임 방언을 계약에 명시적으로 올리고 버전을 고정한다. split/retire remap과 create 시 criteria/paths 필드를 한쪽으로 통일한다.
- Target: IMP-04

**2. [spec] TypedModelEdit 필수 payload가 D-RDD §3에 고정되어 있지 않다**

- Location: `mahas-architecture/spec/domains/rdd.md:32-36`; `mahas-architecture/spec/contracts/model.md:6-7,53-57`
- Contract: C-MODEL "typed edit의 완전한 종류와 필수 payload는 D-RDD §3"
- Evidence: D-RDD §3은 연산 이름과 split/reparent/retire의 산문 제약(자식 책임·기준·paths·role·계약 remap, reparent touchedTargets, 같은 변경 안 detach/remap)만 적는다. 필드명·중첩·전체치환 vs add/remove 델타를 스키마로 고정하지 않는다. 그 공백에서 IMP-02의 평탄 `ModelChangeEdit`와 IMP-04의 중첩 `ModelEdit`가 동시에 정본처럼 존재한다 (finding 1).
- Consequence: 계약 소유자와 모델 구현자가 각자 와이어를 정의해도 spec 위반으로 판정할 기준이 없다.
- Requested correction: D-RDD §3 또는 C-MODEL에 TypedModelEdit 필드 스키마(필수/선택, 치환 vs 델타, retire remap)를 한 번 적고 IMP-02/IMP-04가 그것을 따른다.
- Target: IMP-02

**3. [implementation] `responsibility.locate` / path-search가 비조상 경로 중첩을 가장 깊은 경계로 침묵 선택한다**

- Location: `packages/mahas-runtime/src/discovery/locate.ts:63-89,180-200`; `packages/mahas-runtime/src/discovery/search.ts:351-370`; 대조 `packages/mahas-runtime/src/model/territory.ts:210-247`
- Contract: D-RDD §2 "비조상 경계의 같은 파일 소유는 모호성으로 반환한다", "임의 한 경계를 우선 선택하지 않는다"; C-DISCOVERY `responsibility.locate` "AMBIGUOUS_TERRITORY 또는 진단; 무작위 tie-break 금지"; IMP-05 locate 알고리즘
- Evidence: IMP-05 `resolveTerritory`는 covering claimant 중 contains 조상 관계가 아닌 쌍이 있으면 깊이과 무관하게 `ambiguous`다. IMP-06 `resolveDeepest`는 `owns` 중 최대 depth만 남기고, 그 집합이 하나면 승자로 확정한다. 비조상인 디렉터리 `packages/`와 파일 `packages/foo.ts`가 같은 경로를 덮으면 locate/search는 더 깊은 쪽을 `resolved`로 돌려 territory와 어긋난다. search의 path 필터도 같은 deepest-wins를 복제했고, `locatePaths`를 호출하지 않는다.
- Consequence: 팀장 탐색이 분할/계약이 필요한 중첩 영토를 담당자 한 명으로 보여 준다. REQ-04의 "미배정 영역·모호성을 읽고 명시 배정"이 깨진다.
- Requested correction: locate/search의 영토 판정을 `territory.resolveTerritory`와 같게 한다. 비조상 overlap은 항상 `ambiguous` + 전원 claimant. 같은 깊이 동률도 숨기지 않는다.
- Target: IMP-06

**4. [implementation] selectionToken이 implementation 후보 digest를 묶지 않는다**

- Location: `packages/mahas-runtime/src/discovery/selection-token.ts:66-96,103-121`; `packages/mahas-runtime/src/discovery/types.ts:429-448`; 발급 `packages/mahas-runtime/src/discovery/search.ts:586-597`; 소비 `packages/mahas-runtime/src/composition.ts:344-356`, `packages/mahas-runtime/src/coordination/member.ts:490-501,283-302`
- Contract: C-DISCOVERY "selectionToken은 project/modelVersion/roleId/roleRevision/implementation 후보 digest와 scope를 묶는 무결성 보호 opaque 값"; IMP-06 §4.4 "model/role/interface/implementation pins"
- Evidence: 발급 claims는 `projectId/modelVersion/roleId/roleDigest`와 선택적 `interfaceDigest`(해당 역할의 interface digest가 정확히 1개일 때만)다. implementationId/revision/digest 필드가 없다. composition 어댑터도 그 claims만 옮긴다. `team.assign` / `assignment.preview`는 payload의 `implementationId`+`implementationRevision`으로 구현을 고르고, `implementationCandidateDigest` 재검사는 토큰에 값이 있을 때만 수행된다.
- Consequence: 검색에 나온 구현이 아닌 다른 구현(미공개 candidate 포함, finding 5–6)을 같은 role token으로 배정할 수 있다. 검색→preview→assign의 version pin이 구현 축에서 비어 있다.
- Requested correction: 카드가 가리키는 구현 후보 digest(또는 후보 집합 digest)를 토큰에 넣고, assign/preview에서 현재 행과 재비교한다. payload가 토큰에 없는 구현으로 넓히지 못하게 한다.
- Target: IMP-06

**5. [implementation] 미공개 `candidate` 구현이 탐색 가용성으로 나온다**

- Location: `packages/mahas-runtime/src/discovery/implementation-availability.ts:79-83`; 소비 `packages/mahas-runtime/src/discovery/search.ts:563-565`; 상태 기록 `packages/mahas-runtime/src/realization/implementation-repository.ts:38,281-291`
- Contract: D-ROLE RoleImplementation `published revision immutable`; C-DISCOVERY `role.implementations` "공개된 해당 interface 구현만"; REQ-04/05
- Evidence: `storeCandidate`는 `role_implementations.status='candidate'`로 넣는다. `availabilityForRole`은 `status !== 'retired'`만 걸러 CandidateCard와 `role.implementations`에 올린다. `ImplementationAvailability`에 lifecycle/status 필드가 없어 카드의 `support`는 프로필 관측이지 구현 공개 여부가 아니다. 계약 `ImplementationStatus`는 `'draft'|'published'|'retired'`라 `'candidate'` 자체가 계약 어휘가 아니다.
- Consequence: 팀장이 아직 publish 게이트(초기 coverage, semanticDecision)를 통과하지 않은 구현을 배정 후보로 읽는다.
- Requested correction: 새 선택에는 `published`만 노출하거나, 카드에 `status`를 명시하고 candidate는 가용에서 제외한다. 계약 enum과 저장 status를 맞춘다.
- Target: IMP-06

**6. [implementation] `team.assign` / `assignment.preview`가 `candidate` 구현을 통과시킨다**

- Location: `packages/mahas-runtime/src/coordination/member.ts:239-282,1216-1222`; publish 게이트 `packages/mahas-runtime/src/realization/publisher.ts:348-356`
- Contract: D-ROLE publication lifecycle; C-DISCOVERY assignment.preview `IMPLEMENTATION_MISSING`; REQ-05
- Evidence: `recheckImplementation`은 `'retired'|'withdrawn'|'disabled'`만 거부한다. `'candidate'`는 존재하기만 하면 통과한다. `implementationPublish`만이 `uncoveredClauses`를 `MANDATORY_COMPONENT_MISSING`으로 막는다. finding 5와 이어지면 prepare → search → assign이 미공개 구현으로 닫힌다.
- Consequence: Member가 공개되지 않은 구현 revision에 고정된다. 역할 실현의 prepare/publish 분리가 배정 경로에서 무효다.
- Requested correction: 재검사에서 `status === 'published'`를 요구하고 candidate는 `IMPLEMENTATION_MISSING`으로 돌린다.
- Target: IMP-13

**7. [implementation] `plan.prepare`가 query로 등록되어 후보 저장이 idempotency 밖에 있다**

- Location: `packages/mahas-runtime/src/coordination/index.ts:68`; 쓰기 `packages/mahas-runtime/src/coordination/plan.ts:498-519`; 입학 `packages/mahas-runtime/src/api/admission.ts:215-254,293`
- Contract: C-WORK `plan.prepare` "후보만 저장"; S-COMMON §3 mutation의 operationId+fingerprint receipt; IMP-13 §4.4
- Evidence: `memberOp('plan.prepare', false, planPrepare)`로 `mutation: false`. 핸들러는 `plan_candidates` INSERT와 `appendDomainEvent('plan.prepared')`를 수행한다. admission은 query에 operationId/receipt를 요구하지 않고 `BEGIN DEFERRED`로 실행한다.
- Consequence: 같은 prepare를 재시도하면 후보 행과 이벤트가 복제된다. commit이 가리킬 candidate identity가 안정적이지 않다.
- Requested correction: `mutation: true`로 등록해 receipt 키 아래 한 번만 저장되게 한다.
- Target: IMP-13

**8. [implementation] `run.create`의 `coordinatorRoleId`가 저장·배정 재검사에 없다**

- Location: `packages/mahas-runtime/src/coordination/run.ts:139-178`; 배정 `packages/mahas-runtime/src/coordination/member.ts:553-560`; DDL `runs` (`packages/mahas-runtime/src/storage/migrations.ts:460-473`)
- Contract: C-WORK `run.create` 입력 `coordinatorRoleId`, 전제 "coordinator role 범위"; D-WORK 팀장 coordination assignment
- Evidence: 역할이 해당 ModelVersion에 있는지만 확인하고 결과/이벤트 payload에만 남긴다. `runs`에 coordinator role 컬럼이 없다. `team.assign`은 `assignmentKind='coordination'`이면 `coordinator_member_id`가 비어 있기만 하면 어떤 role token이든 팀장으로 심는다. 주석(175-177)이 이 공백을 인정한다.
- Consequence: 공개 모델의 특정 조율 역할로 만든 Run을 다른 역할 구현이 팀장으로 차지할 수 있다. create 시점 인가는 배정에서 사라진다.
- Requested correction: 선언된 coordinator role을 Run에 고정하고, coordination `team.assign`에서 `pins.roleId`와 비교한다.
- Target: IMP-13

**9. [implementation] `role_interfaces.requirements_json`이 계약 `RoleInterfaceRequirements`가 아니다**

- Location: 기록 `packages/mahas-runtime/src/realization/interfaces.ts:378-395`; 실현 읽기 `:354-356`; 탐색 읽기 `packages/mahas-runtime/src/discovery/model-read.ts:537-557`; 계약 `packages/mahas-contracts/src/role.ts:55-73`
- Contract: D-ROLE RoleInterface; S-STORAGE "payload JSON의 구조는 domains 문서와 각 C-* 계약을 따른다"
- Evidence: `storeInterfaceSnapshot`은 `canonicalJson(derived.contextRequirements)` — `DerivedRequirement[]` — 를 `requirements_json`에 넣는다. 계약 객체 `{responsibilityRefs, contextRequirements}`가 아니다. `responsibilityRefs`는 `judgment_scope_json`에만 있다. discovery `interfaceRequirementsForBoundaryRoles`는 배열이 아니면 `[]`로 삼킨다. 실현 쪽은 배열을 `DerivedRequirement[]`로 파싱한다. 추가로 `requiredMeaning`은 기준/지침 본문이 아니라 리터럴 `'required'`이고 `readerPerspective`는 항상 `'performer'`라 inspect의 coordination 절 필터(`coordination|coordinator|parent|팀장`)는 저장된 인터페이스에서 항상 `missing`이다.
- Consequence: 같은 컬럼을 경계마다 다른 모양으로 해석한다. 팀장 inspect의 authored coordination view는 인터페이스 저장 형식상 채워질 수 없다(자식 책임/계약 긴장은 inspect의 다른 필드로만 보인다).
- Requested correction: 저장 JSON을 `RoleInterfaceRequirements`(또는 명시적 storage DTO)로 고정하고 모든 독자가 그것을 파싱한다. coordination perspective 절을 둘 거면 derivation/authoring 경로를 만들고, 없다면 inspect가 RDD 상위 view만 쓴다는 점을 계약에 적는다.
- Target: IMP-07

**10. [implementation] `harness.profile.admit`의 attestation revision과 소비 경로가 어긋난다**

- Location: 기록 `packages/mahas-runtime/src/realization/profile-registry.ts:526-559`; 탐색 `packages/mahas-runtime/src/discovery/model-read.ts:593-607`, `implementation-availability.ts:86-123`; 배정 `packages/mahas-runtime/src/coordination/member.ts:304-318`
- Contract: D-ROLE HarnessProfile `draft/documented/verified/disabled`, 설치 evidence 보존; C-DISCOVERY availability는 관측이지 미래 성공 보장이 아니지만 documented≠verified는 유지해야 한다
- Evidence: admit은 attestation을 **원본** `profileRevision`에 INSERT하고, `state=decision`인 **새** revision을 mint한다. 원본 행의 state는 그대로다. 구현은 prepare 때 고른 `(profile_id, profile_revision)`에 고정된다. (a) 원본 rev에 붙으면 `latestAttestation`은 verified인데 `profileState !== 'verified'` blocker가 동시에 뜬다. (b) mint된 rev에 붙으면 그 rev의 attestation 행이 없어 host-scoped `attestation.decision==='verified'` 검사가 실패한다. (c) `recheckImplementation`은 `support_attestations.decision='admitted'`와 profile state `'admitted'|'active'`를 찾는데, admit이 쓰는 값은 `verified|documented|disabled`뿐이라 attestation 분기는 죽은 코드다.
- Consequence: 정상 admit 경로로는 "verified 프로필을 골라 배정"과 "host-scoped availability"를 동시에 만족하는 revision이 없다. 탐색의 implementation-availability가 실제 공개 상태와 모순된다.
- Requested correction: attestation을 mint된 revision에도 남기거나 family-latest로 resolve한다. 결정 어휘를 한 세트로 맞추고, blocker는 effective support와 같은 값을 본다.
- Target: IMP-07

**11. [implementation] TaskSpec `inputs_json` 형태가 파서마다 다르고, dispatch pin은 producer Run을 검사하지 않는다**

- Location: 기록 `packages/mahas-runtime/src/coordination/task-spec.ts:143-163`; 계약 형태 `packages/mahas-contracts/src/work.ts:167-188`; eligibility `packages/mahas-runtime/src/coordination/eligibility.ts:170-229`; dispatch pin `packages/mahas-runtime/src/coordination/input-resolver.ts:83-111,141-182`; S-STORAGE §1 same-project/run scope
- Contract: D-WORK InputBinding; C-WORK "모든 endpoint는 같은 Run에 속한다"; S-STORAGE §1 JSON identity와 same-run scope는 SQL이 아니라 service가 검사
- Evidence: DDL은 `json_valid(inputs_json)`만 본다. `insertSpecRow`는 `inputBindings`를 검증 없이 `JSON.stringify`한다. 계약 InputBinding은 평탄 필드(`taskId`, `outputSlot`, `artifactId`)다. `eligibility.resolveInputBindings`는 중첩 `identity.taskId` / `identity.artifactId`를 읽는다. `input-resolver.parseBinding`은 평탄 필드를 읽는다. eligibility의 artifact 경로는 `artifacts.run_id`를 비교하지만 task-output 경로는 producer task의 run을 보지 않고, `pinInputs`/`resolveTaskOutput`도 `o.task_id`만 조인한다.
- Consequence: 같은 저장된 spec이 plan eligibility에서는 pending, dispatch pin에서는 pinned(또는 반대)가 될 수 있다. 다른 Run의 수락 output을 task id만으로 소비할 수 있어 Run 범위 불변식이 비어 있다.
- Requested correction: 하나의 InputBinding 코덱으로 기록·eligibility·pin을 맞춘다. task-output/artifact resolve에 consumer Run(및 필요 시 가시성) 검사를 넣는다.
- Target: IMP-14

## Limitations

- 정적 코드 대조만 했다. 앱 기동, 실제 SQLite migration/concurrency, crash injection, 하네스 호환, e2e는 수행하지 않았다. 실행 실패를 관측 사실로 쓰지 않았다.
- IMP-10 grant 해석, IMP-11 admission의 모든 분기, IMP-08/09 bundle compile, IMP-20 `assignment.show`, IMP-21 settlement writer는 이 Task 범위에서 전부 읽지 않았다. finding 10의 admit 소비와 finding 11의 outcome/settlement 조인은 저장·조회 코드에 근거하며, 실제 admit→pin 왕복은 돌리지 않았다.
- `packages/mahas-runtime/src/model/indices.ts`의 미사용 discovery backbone, desktop UI, execution-host process ops는 저장 경계(별도 DB, 단일 writer) 확인 외에는 깊게 보지 않았다.
