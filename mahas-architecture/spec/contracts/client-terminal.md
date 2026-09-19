# C-CLIENT — Desktop·터미널 사용 표면


**소비 시점:** IMP-28/IMP-31/IMP-32. mahasd가 C-HOST를 proxy하기 전에 read scope/InputLease를 집행한다. renderer는 mahas DB나 execution-host socket의 직접 client가 아니다. 상태 snapshot과 구독은 C-OBSERVATION을 사용한다.

자동 agent 협업은 C-MAIL이고 아래 terminal input은 사용자 사용 표면이다. 두 경로를 통합하여 terminal write receipt를 Delivery ack로 만들지 않는다. 각 client 연결은 protocol/capability를 협상하며 다른 socket의 지원 기능을 가정하지 않는다.

관리 Execution이 붙은 탭의 close는 `terminal.detach` / `client.view.unbind`다. process 종료는 `worker.stop`이다. Restart는 자동 새 spawn이 아니다. unmanaged PTY만 기존 앱 소유 세션으로 탭과 함께 죽는다.


## 연산별 계약

### `terminal.attach`

**주체/범위:** operator 또는 terminal.read scope

**입력:** terminalId, outputEpoch?, lastSequence?, viewId, inputIntent: observe|claim (기본 observe), expectedInputLeaseRevision?

**반환:** scoped stream/snapshot with gap metadata; claim 성공 시 inputLeaseId/revision/expiry

**전제·인가:** observe는 terminal/execution 읽기 권한만 확인하고 InputLease를 발급하지 않는다. claim은 명시적인 사용자 제어 요청이며 terminal.input 권한, 실제 terminal incarnation, expectedInputLeaseRevision을 확인한다. 기존 owner의 미만료 lease를 임의 선점하지 않는다. 현재 owner의 갱신과 명시적으로 해제/만료된 lease의 새 claim만 허용한다.

**저장·실행 효과:** C-HOST attach proxy와 ClientViewBinding 저장. inputIntent=claim이면 같은 transaction에서 단일 InputLease를 CAS로 생성/갱신한다. 이는 UI 초점·구독 수와 무관한 입력 권한이다.

**거부·불명:** unknown terminal 또는 stale epoch에는 snapshot fallback 명시

### `terminal.input`

**주체/범위:** operator terminal.input scope

**입력:** terminalId, inputLeaseRevision, inputBytes

**반환:** admission receipt

**전제·인가:** current input owner, exact terminal incarnation

**저장·실행 효과:** C-HOST input proxy; turn/업무 수락 아님

**거부·불명:** stale lease, CONTROL_UNAVAILABLE

### `terminal.resize`

**주체/범위:** 현재 input/size owner

**입력:** terminalId, inputLeaseRevision, columns, rows

**반환:** size revision

**전제·인가:** passive viewer 거부

**저장·실행 효과:** host resize proxy

**거부·불명:** STALE_REVISION

### `terminal.snapshot`

**주체/범위:** terminal.read scope

**입력:** terminalId, expectedEpoch?

**반환:** current terminal state/bounded history

**전제·인가:** read 권한

**저장·실행 효과:** host snapshot proxy

**거부·불명:** truncation과 unavailable 명시

### `terminal.detach`

**주체/범위:** 해당 구독 client

**입력:** subscriptionId

**반환:** detached

**전제·인가:** subscription 소유자

**저장·실행 효과:** 구독과 해당 client가 소유한 input lease만 해제한다. 다른 client의 lease는 바꾸지 않으며 process stop은 하지 않는다. 소유 client 단절 시 lease는 만료되며 명시적으로 다시 claim해야 한다.

**거부·불명:** 동일 요청 반복 허용

### `client.view.bind`

**주체/범위:** UI client 본인

**입력:** viewId, executionId?, terminalId?

**반환:** binding revision

**전제·인가:** 연결 대상 읽기 권한, cross-client binding 변조 금지

**저장·실행 효과:** ClientViewBinding 저장; domain authority 없음

**거부·불명:** SCOPE_DENIED

### `client.view.unbind`

**주체/범위:** UI client 본인

**입력:** viewId, expectedRevision

**반환:** unbound

**전제·인가:** binding owner

**저장·실행 효과:** UI binding 삭제/이력, 실행/자원 소유 유지

**거부·불명:** STALE_REVISION
