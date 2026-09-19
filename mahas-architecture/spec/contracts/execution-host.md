# C-HOST — 재부착 가능한 실행 호스트 프로토콜


**소비 시점:** IMP-17/18/19/22/23/28. 아래 API는 mahasd 서비스 전용이다. worker의 CLI schema에 포함하지 않는다.

## transport와 인증

local socket/named pipe의 versioned framed RPC를 사용한다. `HostEnvelope={protocolVersion,hostId,expectedHostIncarnation,controllerEpoch,leaseProof,effectKey,payloadFingerprint,payload}`. `payload`는 해당 연산의 **평탄 필드**가 정본이다. 첫 연결은 host.hello와 mutually authenticated nonce challenge다. protocol major 불일치는 mutation을 거부하고 지원 정보를 읽기 전용으로 제공한다. 새로운 endpoint 파일을 발견했다고 이전 host의 process를 죽이거나 입양하지 않는다.

호스트와 mahasd가 번역하는 래핑 별칭(미나열 키는 `MODEL_INVALID`/`INVALID_ARGUMENT`):

| 연산 | 정본 | 허용 별칭 |
| --- | --- | --- |
| `host.process.spawn` 입력 | ProcessSpec 필드가 payload 최상위, 또는 `payload.spec` | `initialStdin`: string \| `{bytesB64}` \| ContentRef |
| `host.process.spawn` 반환 | `{processIncarnation, terminalId?, state}` | `spawn.state`, `processIdentity`≡`processIncarnation` |
| `host.process.probe` 입력 | `{processIncarnation}` | `expectedProcessIncarnation` |
| `host.process.probe` 반환 | `{state: live\|exited\|unverifiable, evidence}` | `probe.state` |
| `host.process.stop` 입력 | `{processIncarnation, mode, graceBudget}` | `expectedProcessIncarnation` |
| `host.process.stop` 반환 | `{state, outcome}` | `stop.outcome`, `receipt.outcome`, `effect.state` |
| `host.effect.get` 반환 | `{state, …}` | `effect.state`, `receipt.state` |

execution-host.sqlite는 process identity·primitive receipt·terminal mapping·workspace primitive를 저장한다. mahas.sqlite의 RDD/Grant/Task를 직접 읽거나 수정하지 않는다. process별 lifecycle mutation을 직렬화하고 stdout output와 control receipt의 큐를 분리한다. output는 bounded buffer와 epoch/sequence를 사용하고 truncation/gap을 명시한다.

## launch primitive의 완전한 입력

`ProcessSpec={executable:absolutePath,argv:string[],cwd:canonicalPath,env:allowlisted map,stdio:pty|pipes,terminalSize?,initialStdin?:ContentRef,spawnNonce,executionId,generation,resourceClaimToken,processLifetime:host-owned}`. NUL/크기/인자 수는 실제 OS 한계에 맞게 검사한다. shell interpolation/eval 없음. 계정 secret은 별도 허용된 환경·credential provider를 사용하고 log에 기록하지 않는다.

## primitive receipt의 원칙

host가 effect_started를 저장한 뒤 OS를 호출한다. 동일 effectKey/payload는 기존 receipt. process 생성과 journal commit은 OS와 원자적이지 않으므로 crash gap은 unknown이다. supervisor가 matching child를 직접 소유하는 동안 inventory로 확인할 수 있다. host 자체가 사라져 identity를 입증할 수 없으면 자동 respawn하지 않는다. 안전성과 availability의 교환을 숨기지 않는다.


## 연산별 계약

### `host.hello`

**주체/범위:** mahasd service

**입력:** supportedVersions, controllerIdentity, challenge

**반환:** hostId/incarnation, actual endpoint, capabilities, challenge response

**전제·인가:** endpoint identity와 peer credential 검사

**저장·실행 효과:** handshake only

**거부·불명:** HOST_PROTOCOL_MISMATCH, UNAUTHENTICATED

### `host.acquire`

**주체/범위:** mahasd service

**입력:** controllerEpoch, controllerProcessIdentity, takeoverProof?, priorLeaseRevision?

**반환:** ControllerLease

**전제·인가:** 이전 controller dead 또는 명시 handoff 증거. TTL alone 금지

**저장·실행 효과:** host lease CAS 저장

**거부·불명:** PROCESS_UNVERIFIABLE, SCOPE_DENIED

### `host.inventory`

**주체/범위:** 현재/복구 controller

**입력:** hostId/incarnation, cursor?

**반환:** processes, terminals, resources, effect receipt ids, evidence time

**전제·인가:** recovery read scope 허용, mutation 권한과 구별

**저장·실행 효과:** 현재 보유 자원 조회

**거부·불명:** CONTROL_UNAVAILABLE, stale incarnation

### `host.effect.get`

**주체/범위:** controller

**입력:** effectKey

**반환:** primitive receipt incl unknown/residuals

**전제·인가:** same host/owner scope

**저장·실행 효과:** 조회 only

**거부·불명:** not found는 확실한 negative evidence 조건을 함께 반환

### `host.process.spawn`

**주체/범위:** lease owner

**입력:** ProcessSpec (payload 최상위 또는 `payload.spec`)

**반환:** processIncarnation (`processIdentity` 별칭), terminalId?, state (`spawn.state` 별칭)

**전제·인가:** current lease/fence와 same effect identity. conflicting nonce 거부

**저장·실행 효과:** effect_started journal→spawn→identity commit→receipt

**거부·불명:** START_UNKNOWN, rejected OS errno, residual child

### `host.process.probe`

**주체/범위:** controller

**입력:** processIncarnation (`expectedProcessIncarnation` 별칭)

**반환:** live\|exited\|unverifiable, evidence

**전제·인가:** pid+birth+boot/nonce 일치; 다른 pid 재사용 거부

**저장·실행 효과:** 관측 only, task 상태 변경 없음

**거부·불명:** PROCESS_UNVERIFIABLE

### `host.process.stop`

**주체/범위:** lease owner

**입력:** processIncarnation (`expectedProcessIncarnation` 별칭), mode, graceBudget

**반환:** stop receipt + positive exit or unknown (`stop.outcome` / `effect.state` 별칭)

**전제·인가:** same incarnation, current fence, exact process group 확인

**저장·실행 효과:** intent→signal→reap/probe→receipt; retry는 원래 target만

**거부·불명:** STOP_UNKNOWN; process group ownership 불명시 무차별 kill 금지

### `host.terminal.attach`

**주체/범위:** 허용 controller/client proxy

**입력:** terminalId, outputEpoch?, lastSequence?

**반환:** stream handle, screen/buffer snapshot, replay range

**전제·인가:** terminal access scope, incarnation

**저장·실행 효과:** 뷰 구독만; process 생성 없음

**거부·불명:** gap을 명시하고 full snapshot 요구

### `host.terminal.input`

**주체/범위:** current InputLease proxy

**입력:** terminalId, inputLeaseRevision, inputBytes, expectedHostIncarnation

**반환:** bytes admitted receipt

**전제·인가:** operator input lease 또는 검증된 wake service 경로

**저장·실행 효과:** input enqueue는 처리/turn 수락 증거 아님

**거부·불명:** stale lease, unsupported input mode, unknown write

### `host.terminal.resize`

**주체/범위:** current size owner proxy

**입력:** terminalId, inputLeaseRevision, columns, rows

**반환:** new size revision

**전제·인가:** 관측-only client가 크기 claim 못 함

**저장·실행 효과:** PTY resize effect

**거부·불명:** stale lease, process exited

### `host.terminal.snapshot`

**주체/범위:** 허용 reader

**입력:** terminalId, expectedOutputEpoch?

**반환:** bounded screen/history, epoch, sequence, truncation

**전제·인가:** 읽기 권한

**저장·실행 효과:** snapshot only; native history 아님

**거부·불명:** terminal unavailable

### `host.terminal.detach`

**주체/범위:** 허용 reader

**입력:** subscriptionId

**반환:** detached

**전제·인가:** subscription 소유

**저장·실행 효과:** 구독 해제만; process와 terminal record 유지

**거부·불명:** 이미 해제는 idempotent

### `host.workspace.prepare`

**주체/범위:** lease owner

**입력:** project root, placement folder|worktree, expected repositoryIdentity, target path, claim token

**반환:** canonical checkout identity, receipt

**전제·인가:** approved path containment·target collision·Git base 확인

**저장·실행 효과:** worktree/mkdir primitive intent→effect→identity

**거부·불명:** 부분 생성 unknown과 residual 경로 기록

### `host.workspace.probe`

**주체/범위:** controller

**입력:** checkoutId, expected filesystem/worktree identity

**반환:** exists/dirty/live-use evidence

**전제·인가:** 실제 canonical resource identity

**저장·실행 효과:** 관측 only

**거부·불명:** unverifiable는 absent 아님

### `host.workspace.release`

**주체/범위:** lease owner

**입력:** checkout identity, expected claim revision, dirtyDisposition

**반환:** release receipt

**전제·인가:** no live/unverifiable writer, no retention pins, explicit dirty handling

**저장·실행 효과:** intent→remove→confirm. force 범위 별도

**거부·불명:** RESOURCE_BUSY, unknown cleanup; 경로만 보고 재귀 삭제 금지
