# D-RESOURCE — 자원·관측·유지 작업·운영 모델

**소비 시점:** IMP-16/22/23/26~IMP-29의 담당자.

## 1. 자원 객체

| 객체 | 필드 | 계약 |
|---|---|---|
| Workspace | id, projectId, kind: folder/git-worktree, checkoutId, state | 논리 작업 환경; 같은 checkout 가능 |
| Checkout | id, hostId, canonicalPath, filesystemIdentity, repositoryIdentity?, worktreeIdentity?, revision | 실제 디렉터리 identity. unique host+canonical path+birth evidence |
| ResourceClaim | id, checkout/terminal/package/artifact ref, ownerExecution/Dispatch, mode, generation, state | held/transferring/released/unknown; live/unknown writer 중복 배정 거부 |
| ResourceTransfer | id, resourceId, fromOwner, toOwner, expectedClaimRevision, state | 명시 인계. old owner quiescence 확인 필요 |
| ResidualResource | effectId, resourceRef, reason, liveEvidence, cleanupPolicy | 부분 실패의 정리 대상을 숨기지 않음 |
| ContentBlob | digest, mediaType, byteLength, bytes or externalStorageRef, verified | immutable snapshot/cache/artifact; 원본 저작 파일과 다름 |
| RetentionPin | objectRef, reason, holderRef, createdAt | published 구현/활성 실행/인계 결과가 참조 중이면 GC 금지 |

## 2. 관측·개입·projection 객체

| 객체 | 필드 | 계약 |
|---|---|---|
| ObservationFact | id, executionId?, dispatchId?, source, factType, payload, observedAt, identityEvidence, confidenceClass | hook/process/agent 선언 출처를 유지 |
| Intervention | id, run/member/execution ref, kind, evidence, state, responder?, responseNote? | open/claimed/resolved/obsolete. 응답은 실제 permission 승인과 구별 |
| DomainEvent | globalSequence, project/run scope, aggregateId, revision, type, payload | transaction과 같이 저장되는 projection outbox |
| SubscriptionCursor | streamId, epoch, lastSequence, visibilityDigest | epoch/gap/권한 변동 시 snapshot 재요구 |
| ClientViewBinding | clientId, viewId, terminal/execution ref, sizeClaim? | UI 소유 상태. detach는 worker stop 아님 |
| ResumeCandidate | executionId, nativeHandle, source, supportState, verifiedProcessState | native 대화 힌트이며 current authority가 아님 |

## 3. 유지·운영 객체

| 객체 | 필드 | 계약 |
|---|---|---|
| ImpactCandidate | id, changeRef, targetRole/interface/implementation, reason, status, reviewer, resolution | candidate/confirmed/dismissed/resolved. 의미 영향 자동 확정 안 함 |
| MaintenanceBinding | implementationRevision, basisRef, renderedComponentRef | 상위 원본을 자식 runtime context에 넣는 경로가 아님 |
| MigrationReceipt | id, fromSchema/toSchema, stage, fingerprint, backupRef, outcome | 이전 UI 상태를 Task로 발명하지 않음 |
| BackupSet | id, controlDbSnapshot, hostSnapshot?, contentPins, consistencyPoint, manifestDigest | SQLite와 필요한 blob/receipt 일관성 포함 |
| RuntimeShutdown | operationId, mode, targetedExecutions, stages, residuals, outcome | leave-executions 또는 drain-and-stop 명시 |
| SupportAttestation | harnessProfileRevision, installedBinaryIdentity, OS, performedCases, decision, evidenceRefs | documented와 verified를 구별; 문서 확인을 실제 시험으로 부풀리지 않음 |

## 4. 같은 checkout의 쓰기

claim을 프로젝트 이름이나 workspace ID만으로 비교하지 않는다. symlink를 해석한 canonical location과 filesystem/worktree identity를 확인한다. read-only 관측자는 writer와 공존할 수 있으나 쓰기 작업은 기본 배타적이다. 두 worker가 동시에 편집해야 하면 별도 worktree를 생성한다. 권한 있는 operator의 강제 abandon도 '종료 확인'이 아니라 위험 인수임을 남기고 자동 다음 writer를 붙이지 않는다.

## 5. evidence와 state

기존 hook·process 탐지·attention 정책은 관측 입력으로 이관한다. 「ade 실행 아키텍처 분석」 §2.3의 event log는 EOF tail·절단·무재생 채널이므로 이 설계의 Message/Delivery 정본이 아니다. 정상 CLI/RPC만 authoritative accept/report/ack를 처리한다. 화면 복원과 native conversation 복원, 업무 원장 복원은 서로 다른 기능이다.

## 6. 유지관리 이벤트

모델·계약 변경의 before/after 관계를 모두 사용하여 과거 consumer가 사라져 통지에서 빠지지 않게 한다. 부모 변경은 직접 자식의 번역과 parent의 composition view를 재검토한다. horizontal context 변경은 이를 참조한 모든 role implementation 후보를 만든다. agent의 업무 report에서 발견된 문제는 유지 Task 입력으로 전달하며 자기 실행의 bundle을 수정하지 않는다.
