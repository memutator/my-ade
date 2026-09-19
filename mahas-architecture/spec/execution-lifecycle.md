# S-LIFECYCLE — 실행 소유권과 장애 전이 계약

**읽는 시점:** IMP-17~IMP-23, REV-05와 VER-06/07/08. 실제 lifecycle 함수와 recovery 핸들러는 이 표를 전이 정본으로 사용한다.

## 1. 상태별 허용 동작

| 현재 Execution 상태 | 허용 동작 | 성공 전이 | 불명·실패 전이 |
|---|---|---|---|
| preparing | materialize, resource claim, start intent | starting | preparing+blocked 또는 failed receipt/residual |
| starting | 동일 effect 조회, host evidence 확인 | awaiting_join | start_unknown; 명백한 OS reject면 exited+start rejected |
| start_unknown | probe/reconcile, 권한 있는 stop | awaiting_join 또는 exited | unknown 유지; 신규 중복 start 금지 |
| awaiting_join | agent join, operator stop, intervention | ready | stop_unknown/exited; timeout은 join overdue일 뿐 |
| ready | inbox/work, heartbeat, Task accept/report, UI attach, stop | ready 또는 stopping | liveness unverifiable/needs-input은 별도 표시 |
| stopping | 동일 stop receipt 조회/확인 | exited | stop_unknown |
| stop_unknown | probe/reconcile, 명시 escalation | exited | unknown 유지·claim 유지 |
| exited | archive/release 또는 별도 resume generation | 기존 record는 exited 유지 | 새 실행과 identity 섞지 않음 |
| abandoned | 읽기·증거 수집·operator 복구 | 명시 reconciliation만 | cleanup/새 writer 자동화 금지 |

`failed`는 start receipt의 결과 또는 Task Outcome이며 하나의 Execution 상태로 모든 잔여 자원을 덮지 않는다. join 완료 ready가 Task accept를 의미하지 않는다.

## 2. 수명별 권한

ControllerLease는 execution-host mutation 권한, ExecutionCredential은 mahas 협업 API 호출권, Dispatch authority는 이번 Task 결과 제출권, InputLease는 terminal 타이핑/resize권, ResourceClaim은 실제 checkout 소유를 표현한다. 같은 숫자 generation 하나를 모든 계층에 재사용하지 않는다.

한 계층의 revoke가 다른 계층의 물리 완료를 뜻하지 않는다. Task를 revoke해도 old process는 살아 있을 수 있다. input lease가 끝나도 process는 살아 있다. UI 구독이 끝나도 execution과 Member는 유지된다. native session ID를 안다고 API 권한을 얻지 못한다.

## 3. spawn cut points

| 중단 지점 | 복구 근거 | 안전한 후속 |
|---|---|---|
| plan 저장 전 | receipt 부재와 effect 없음 | 같은 request ID로 prepare |
| claim 저장 후 host prepare 전 | reservation과 미시작 intent | 같은 intent continuation |
| worktree effect 중 | host workspace receipt/canonical identity | confirm 또는 unknown residual, 임의 새 path 생성 금지 |
| materialize 중 | manifest/digest/atomic publish marker | 불완전 staging 폐기 가능, published bundle은 검증 후 재사용 |
| spawn intent 후 호출 전후 경계 | 동일 host effect key의 durable receipt/inventory | confirmed negative이면 동일 operation 재개; 아니면 unknown |
| process 확인 후 control DB commit 전 | host spawnNonce/process receipt | 같은 execution reservation에 연결 |
| initial input 후 응답 전 | route-specific receipt, agent join | unknown injection 유지; 같은 prompt를 새 turn으로 중복 제출 금지 |
| join 후 task accept 전 | WorkerJoin, task acceptance record | assignment 재조회 후 같은 accept operation |
| report commit 후 응답 전 | operation receipt와 Outcome | 기존 결과 반환 |

## 4. terminal I/O와 backpressure

output는 per-terminal sequence를 가지며 buffer 한도 초과는 truncation boundary를 보존한다. reconnect에서 lastSequence가 남아 있으면 tail replay, 없으면 current snapshot+gap을 반환한다. screen snapshot은 terminal escape state와 text를 표현하며 provider transcript 복원이 아니다.

control event는 output coalescing 때문에 무한 지연되지 않는다. resize는 가장 최근 유효 InputLease owner만 수행한다. passive client attach는 size owner가 되지 않는다. PTY bytes admitted는 shell/agent가 명령을 실행했다는 영수증이 아니다. nudge/permission 자동 응답은 검증된 별도 의미 경로가 없는 한 사용하지 않는다.

## 5. process identity와 daemon bootstrap

서비스 endpoint 파일에는 protocolVersion, serviceId, pid, start/birth evidence, bootId 가능한 경우, launchNonce, endpointIncarnation을 둔다. exclusive create/lock 후 임시파일+atomic rename으로 공개한다. cleanup은 현재 파일 identity가 자신과 같을 때만 삭제한다. stale PID 파일만 보고 kill하지 않는다. version mismatch는 기존 서비스 진단/명시 upgrade를 요구하고 두 daemon을 무작정 띄우지 않는다.

desktop의 ensure-service는 살아 있는 동일 서비스를 연결하거나, 명백한 부재를 확인한 뒤 생성한다. crash-loop admission은 최근 부팅 실패 횟수에 따른 운영 보호이며 업무 재시도 정책이 아니다. platform별 birth evidence 부재는 unverifiable 처리한다.

## 6. 정상 종료·업데이트

UI close는 client detach다. mahasd drain-and-stop은 신규 배정 중지→worker stop intents→확인/unknown 기록→필요 자원 유지→DB close 순서다. leave-executions는 협업 control API가 unavailable해질 수 있음을 사용자에게 보여주고 execution-host의 소유를 유지한다. service manager가 전체 group을 종료하면 생존 계약이 달라짐을 표시한다.

업데이트는 endpoint protocol compatibility와 DB schema migration을 구분한다. 실행 중 host를 교체할 수 없는 버전이면 먼저 drain을 요구한다. 오래된 runtime이 새 DB에 write하도록 허용하지 않는다. 복구는 backup과 native handle만으로 completion을 발명하지 않는다.
