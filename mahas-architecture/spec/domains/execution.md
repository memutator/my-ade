# D-EXEC — 실행면·소유권·identity·프로세스 상태

**소비 시점:** IMP-16~IMP-23/IMP-28. 실행 담당자는 이 문서와 C-HOST/C-LAUNCH/C-RECOVERY를 함께 읽는다.

## 1. 객체

| 객체 | 필드 | 의미 |
|---|---|---|
| RuntimeInstance | id, controllerEpoch, processIdentity, endpointIncarnation, state | mahasd의 현재 제어 주체 |
| ExecutionHost | hostId, hostIncarnation, protocolVersion, endpoint, processIdentity, state | 로컬 execution-host; v1 remote 미지원 |
| ControllerLease | hostId, epoch, ownerProcessIdentity, nonce, expiresAt, reconciliationState | expiry만으로 이전 owner dead를 추정하지 않음 |
| Execution | id, memberId, generation, hostId, launchPlanId, processIncarnation?, terminalId?, nativeConversation?, state | 논리 실행. Task와 별도 |
| ProcessIncarnation | hostId, spawnNonce, pid, birthEvidence, bootId?, processGroupIdentity, observedExit? | PID 재사용 방지. OS별 증거 강도를 기록 |
| Terminal | terminalId, hostIncarnation, ptyId, processIncarnation, outputEpoch, lastSequence, state | pane/tab과 독립. bounded terminal screen/history |
| NativeConversation | harnessProfileId, nativeId, capturedBy, capturedAt, resumeSupport | native history의 재진입점. 권한·생존 증거 아님 |
| LaunchPlan | id, assignmentRevision, dispatchReservation?, executionReservation, role/interface/implementation/bundle pins, surface/grant pins, input bindings, processSpec, purpose: work/verification, effects | prepared/committed/expired/superseded |
| EffectIntent / EffectReceipt | stable key, kind, fingerprint, stage, state, evidence, residualResources | 파일·workspace·spawn·stop·input side effect 추적 |
| InjectionReceipt | executionId, phase, contentDigests, route, attachedAt, evidenceLevel | materialized/attached/worker_joined 구분 |
| WorkerJoin | executionId/generation, packageDigest, surfaceDigest, envelopeDigest, credentialId | agent 프로토콜 선언. 의미 이해 증명 아님 |
| WakeRequest | member, deliverySetDigest, continuationGrant?, route, operationId, status | stored 메시지와 별도. 무조건 새 turn 생성 안 함 |
| InputLease | terminalId, principalId, revision, expiresAt | operator terminal input/resize의 현재 소유권 |

## 2. 실행 상태는 한 줄의 성공/실패가 아니다

`Execution.state = preparing|starting|start_unknown|awaiting_join|ready|stopping|stop_unknown|exited|abandoned`.
`liveness = live|unverifiable|exited`; `agentActivity = working|idle|needs-input|unknown`는 observation projection이다. `Task outcome`은 D-MAIL에서 정산한다. process live가 agent working을 뜻하지 않고, idle이 task complete를 뜻하지 않는다.

정상 순서는 prepared→starting→awaiting_join→ready→stopping→exited다. 시작 호출 응답 유실은 start_unknown, 종료 확인 유실은 stop_unknown이다. confirmed negative evidence로만 실패/종료를 확정한다. active attempt는 unknown에서도 자원과 권한 조정 대상을 유지한다.

## 3. controller와 execution-host

mahasd가 DB를 열 때 단일 writer lock을 얻고 새 epoch를 기록한다. execution-host와 mutual local authentication 후 이전 controller의 pid+birth identity를 probe한다. 긍정적인 dead 증거 또는 기존 controller의 명시 handoff가 있어야 lease takeover한다. TTL 만료와 socket disconnect만으로 두 controller를 허용하지 않는다.

execution-host는 모든 mutation의 expected hostIncarnation/leaseEpoch를 확인한다. stale 요청은 effect를 실행하지 않는다. 새로운 mahasd는 host의 process inventory와 primitive receipt를 대조하여 기존 execution을 연결한다. matching spawnNonce/host/process identity가 없는 orphan은 자동 입양하지 않는다.

worker의 credential은 controller의 일시적인 transport session과 분리하되 현재 executionGeneration에 바인딩한다. mahasd 재시작 후 동일 process 재부착이 증명되면 credential의 유효성을 재확인하고 control epoch를 서버가 재결정한다. worker에게 이전 epoch 숫자를 영구 하드코딩하지 않는다. 새로운 process resume은 generation을 증가시키고 새 credential이 필요하다.

## 4. PTY와 일반 프로세스

기본 primitive는 executable+argv array+cwd+env allowlist로 새 PTY 또는 pipes process를 직접 spawn한다. role 본문을 shell string에 보간하거나 현재 TUI에 타이핑하지 않는다. headless는 pipes 경로이며 native provider API가 아니다. process exit와 stdout final text로 업무 성공을 정산하지 않는다.

Terminal output은 epoch/sequence와 bounded buffer를 갖는다. gap이면 snapshot/replay 가능 범위를 알려준다. 출력 backpressure 때문에 control ack/stop event를 무한 대기시키지 않는다. user input은 InputLease로 직렬화한다. 자동 wake는 준비된 안전 경로가 없으면 미지원이다. 화면 상태로 permission prompt의 의미를 추측하지 않는다.

## 5. 종료와 잔여 자원

stop은 특정 process incarnation과 process group에 대해 graceful request 후 권한 있는 escalation을 적용한다. PID 하나만으로 kill하지 않는다. 종료 증거가 없으면 resource claim을 해제하지 않는다. process 생존은 끊겨도 worktree·bundle·terminal archive·artifact 참조는 남을 수 있다. resource release와 task settlement는 다른 operation이다.

controller revoke는 API mutation을 막지만 이미 실행 중인 프로세스의 파일 수정을 물리적으로 중단하지 못한다. 새 writer를 같은 checkout에 배정하기 전 실제 정지 확인이 필요하다. 재부착/재개/재시도 구분은 C-RECOVERY의 표를 따른다.
