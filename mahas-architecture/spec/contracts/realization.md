# C-REALIZATION — 역할 구현의 공개·빌드·실효 구성 조회


**소비 시점:** IMP-07~IMP-09/IMP-24/25. 의미 구현의 정본은 RoleImplementation, 하네스 전달의 계약은 S-INJECTION이다. 아래 명령을 일반 실행 agent의 자기수정 API로 노출하지 않는다.

## 빌드 함수

`build(interfaceDigest, implementationRevision, effectiveCommandSurface, sourceSnapshotPins) -> ContextBundle`은 같은 입력에 같은 bytes/digest를 내야 한다. 대상 scope·credential·Task requirement는 bundle에 넣지 않고 WorkEnvelope로 분리한다. human-authored reexpression을 선택하는 것은 구현 작성자의 판단이며 빌더가 실시간 LLM으로 새로 만들어 내지 않는다.

coverageBindings의 필수 clause가 initial component에 연결되어야 한다. component의 설치 그래프는 acyclic이고 중복 경로/collision을 거부한다. conditional skill로만 매핑한 initial requirement는 컴파일 오류다. descriptor를 만든 것과 하네스가 실제 읽은 것은 다른 증거다.


## 연산별 계약

### `interface.get`

**주체/범위:** role 구현 담당자 / role.read

**입력:** modelVersion, roleId

**반환:** RoleInterface, context requirements, digest, maintenance refs

**전제·인가:** 해당 role 범위, source 본문을 받을 권한 분리

**저장·실행 효과:** SQLite에서 interface snapshot 계산/저장; RDD 수정 아님

**거부·불명:** SCOPE_DENIED, MODEL_INVALID

### `implementation.prepare`

**주체/범위:** role.implement 위임

**입력:** interfaceDigest, harnessProfileRevision, componentGraph, coverageBindings, maintainerRoleId

**반환:** candidateImplementation, uncoveredClauses, unsupportedComponents, digest

**전제·인가:** self-active implementation 변경 권한 미부여; profile 권한 확인

**저장·실행 효과:** 후보와 structural diagnostics 저장

**거부·불명:** INTERFACE_STALE, MANDATORY_COMPONENT_MISSING, INJECTION_UNSUPPORTED

### `implementation.publish`

**주체/범위:** 구현 공개 권한자

**입력:** candidateId, candidateDigest, expectedInterfaceDigest, semanticDecision

**반환:** published implementationId/revision

**전제·인가:** 필수 coverage·profile compatibility·전문가의 의미 판단 선언

**저장·실행 효과:** immutable 구현 revision + publication event 저장

**거부·불명:** STALE_REVISION, MANDATORY_COMPONENT_MISSING; 기계 검사를 의미 보증으로 표시 금지

### `implementation.retire`

**주체/범위:** 구현 유지 담당자

**입력:** implementationId, revision, reason

**반환:** retired 상태와 참조 실행 목록

**전제·인가:** 현재 유지 범위; 기존 snapshot 파괴 금지

**저장·실행 효과:** 새 배정 선택에서 제외, 진행 execution pin 유지

**거부·불명:** SCOPE_DENIED; running bundle 삭제 금지

### `harness.profile.register`

**주체/범위:** operator 또는 profile-maintainer

**입력:** executableLocator, versionRange, supportedComponents, injectionRecipe, resumeRecipe?, wakeRecipe?, settingsPolicy

**반환:** draft profileId/revision

**전제·인가:** arbitrary executable code 승인 범위; worker가 불가

**저장·실행 효과:** SQLite profile 설정 등록; 실행 없음

**거부·불명:** SCOPE_DENIED, MODEL_INVALID

### `harness.profile.inspect`

**주체/범위:** 해당 profile 사용 권한

**입력:** profileId/revision, hostId

**반환:** recipe capability, documented/verified 상태, 설치 identity 관측

**전제·인가:** secret/account 설정 제외

**저장·실행 효과:** 버전·경로 probe는 명시 진단 effect로 기록, prompt 실행 안 함

**거부·불명:** HOST_PROTOCOL_MISMATCH, executable unavailable

### `harness.profile.admit`

**주체/범위:** operator/profile 검증 책임자

**입력:** profileRevision, SupportAttestation, expectedExecutableIdentity

**반환:** verified/disabled revision

**전제·인가:** 실제 검증 evidence ref 필요; docs-only는 verified 불가

**저장·실행 효과:** support attestation과 activation 상태 저장

**거부·불명:** STALE_REVISION, SCOPE_DENIED; 실행 시험을 자동 꾸며내지 않음

### `context.build`

**주체/범위:** 역할 구성 또는 launch service

**입력:** interfaceDigest, implementationRevision, surfaceDigest, sourceSnapshotPins

**반환:** bundleDigest, component manifest, requiredTextDigest

**전제·인가:** 필수 clauses·source pins·현재 role action ceiling 검사

**저장·실행 효과:** 원본 파일 byte 관측을 immutable snapshot에 저장, bundle 및 blob 저장

**거부·불명:** MANDATORY_COMPONENT_MISSING, INTERFACE_STALE, REQUIRED_ACTION_DENIED, path collision

### `context.inspect`

**주체/범위:** 자기 execution 또는 범위 내 팀장/유지 담당자

**입력:** bundleDigest 또는 executionId, detail: own|composition|maintenance

**반환:** planned components / attached receipt / inherited known inputs / unknowns

**전제·인가:** own/composition/maintenance에 따른 내용 해상도·읽기 범위

**저장·실행 효과:** query only. native 숨은 시스템 prompt를 알고 있다고 표시 안 함

**거부·불명:** SCOPE_DENIED, content unavailable
