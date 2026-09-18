# C-RESOURCE — 실제 자원 배치·인계·해제


**소비 시점:** IMP-16/22/29. WorkspaceService가 논리 claim을 mahas.sqlite에 저장하고 C-HOST로 물리 effect를 수행한다. DB와 filesystem 사이의 부분 실패를 receipt로 보존한다.

write claim의 배타성은 `Checkout(hostId,canonicalPath,filesystemIdentity)` 기준이다. logical workspace가 달라도 같은 checkout이면 같은 자원이다. 경계 paths와 agent parentage는 파일 격리 증거가 아니다. read-only observer와 writer는 공존할 수 있으나 observer가 write operation을 수행하도록 권한을 확대하지 않는다.


## 연산별 계약

### `workspace.prepare`

**주체/범위:** placement 권한 팀장/launch service

**입력:** projectId, placementIntent, expectedBaseCommit?, ownerReservation

**반환:** Workspace/Checkout/ResourceClaim, effect receipt

**전제·인가:** canonical path·provisioning scope·겹치는 writer 확인

**저장·실행 효과:** claim reservation commit→host prepare→identity finalize

**거부·불명:** RESOURCE_BUSY, START_UNKNOWN; 잔여 worktree 기록

### `workspace.inspect`

**주체/범위:** 해당 작업/조율 scope

**입력:** workspaceId

**반환:** checkout identity, claims, dirtiness/evidence, retain reasons

**전제·인가:** 타 작업 코드 내용은 권한 별도

**저장·실행 효과:** query/probe only

**거부·불명:** PROCESS_UNVERIFIABLE

### `claim.handoff`

**주체/범위:** 현재 소유·배정 조율 권한

**입력:** claimId, expectedRevision, fromOwner, toOwner, quiescenceEvidence

**반환:** ResourceTransfer and new claim revision

**전제·인가:** old writer 정지/인계 확인, new owner 유효성, output pins 유지

**저장·실행 효과:** transfer intent/confirm 기록; 원자 owner pointer 변경

**거부·불명:** RESOURCE_BUSY, STALE_REVISION, PROCESS_UNVERIFIABLE

### `claim.release`

**주체/범위:** 자원 처분 권한자

**입력:** claimId, expectedRevision, disposition, dirtyDecision?

**반환:** released/retained/unknown receipt

**전제·인가:** live/unknown execution과 retention pins 검사

**저장·실행 효과:** host cleanup가 필요한 경우 별도 effect. Task outcome 변경 없음

**거부·불명:** RESOURCE_BUSY, STOP_UNKNOWN
