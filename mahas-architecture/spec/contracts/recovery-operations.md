# C-RECOVERY — 재연결·재개·재시도·운영 복구


**소비 시점:** IMP-22/23/28/29와 verification의 장애 담당자. 입력 보고서의 '프로세스 연속성·대화 복원·요청 복구·작업 완료' 구분을 유지한다(「Orca와 Paseo의 실행 아키텍처 비교 분석」 §2, §13).

## 네 연산의 차이

| 동작 | 동일하게 유지 | 새로 만드는 것 | 반드시 필요한 증거 |
|---|---|---|---|
| reattach | execution generation, process, native conversation | client transport/observation binding | host/process incarnation 일치 |
| native-resume | 역할 의미·검증된 native conversation handle | process와 execution generation/credential | old process 종료 또는 통제된 quiescence, 지원 recipe |
| task retry | Task identity와 명시 선택한 revision | Dispatch와 필요한 execution | 이전 attempt revoke/정산, 새 시도 권한 |
| fresh role start | 선택한 새 role/interface | 새 대화·bundle·credential·execution | 역할 구현과 current grants |

role/interface 또는 필수 context가 달라졌는데 과거 대화를 그대로 물려받는 것은 기본 금지다. 원래 대화에 남은 정보는 파일 삭제로 제거되지 않는다. explicit reviewed migration이 없는 v1은 새 대화다.

## 재시작 알고리즘

1. mahasd single-writer lock, schema 검사, 새 ControllerEpoch를 얻고 ready publication을 보류한다.
2. DB에 남은 active/unknown effect와 execution/claim을 읽는다. 화면 상태는 live 증거로 쓰지 않는다.
3. execution-host의 actual endpoint와 incarnation을 확인하고 이전 controller process의 죽음/hand-off를 증명하여 lease를 얻는다.
4. effectKey·spawnNonce·process birth·terminal inventory를 대조한다. matching process는 reattach하고 conflicting/orphan은 quarantine/unknown이다.
5. old ack/report 권한과 input lease를 조정한다. 동일 process의 유효한 credential은 계속 사용할 수 있게 binding을 재확인하고 새 process만 generation을 증가시킨다.
6. unknown 실행의 writer claim은 보존하고 startup receipt 및 projection을 공개한다. 보류된 outbox는 같은 effect key로 조회/정산하며 임의 신규 spawn 안 함.

execution-host가 사라진 경우 OS상 자식이 살아 있는지와 제어 가능한지를 따로 확인한다. pid birth 증거가 없으면 unverifiable이며 자동 입양/재배치하지 않는다. host의 자체 restart로 PTY master가 사라졌다면 explicit exit evidence에 따라 종료를 확정한다. 생존 불가능한 경로에서 재부착을 약속하지 않는다.


## 연산별 계약

### `runtime.status`

**주체/범위:** operator / 제한된 status reader

**입력:** detail level

**반환:** controller/host health, epochs, schema, reconciliation blockers

**전제·인가:** 상세 경로/credential 제외

**저장·실행 효과:** read only

**거부·불명:** control unavailable는 worker 완료 아님

### `runtime.reconcile`

**주체/범위:** operator/recovery service

**입력:** host/execution scope, expectedEpoch, evidenceRefs?

**반환:** reconciliation decisions, unresolved resources, nextAllowedActions

**전제·인가:** ownership/current epoch; 외부 evidence 무조건 신뢰 금지

**저장·실행 효과:** host probe와 receipt 대조, 권한 포인터 갱신, unknown 유지

**거부·불명:** PROCESS_UNVERIFIABLE, HOST_PROTOCOL_MISMATCH

### `runtime.shutdown`

**주체/범위:** operator

**입력:** mode: leave-executions|drain-and-stop, targetedExecutionIds?, timeoutBudget

**반환:** shutdown receipt with residuals

**전제·인가:** operator authentication, exact current identities

**저장·실행 효과:** 모드별 새 admission 중지→정리/leave 기록→DB checkpoint/close. timeout도 pending resources 보존

**거부·불명:** STOP_UNKNOWN; UI close는 이 연산을 자동 호출하지 않음

### `backup.create`

**주체/범위:** operator backup 권한

**입력:** scope, retentionPolicy

**반환:** BackupSet with consistency point and blob pins

**전제·인가:** DB 일관성 snapshot과 필요한 blob/host receipt 범위

**저장·실행 효과:** 명시 snapshot operation, backup manifest 기록

**거부·불명:** 부분 복사는 failed/unknown; raw WAL 파일 누락한 성공 금지

### `backup.restore`

**주체/범위:** operator offline restore

**입력:** backupSetId, expectedRuntimeStopped, targetPath

**반환:** restore receipt, restored-unconfirmed runtime state

**전제·인가:** runtime write 중지·backup manifest/digest/schema 검증

**저장·실행 효과:** DB/content 복원, 모든 과거 실행은 reconciliation 필요로 시작

**거부·불명:** STALE_REVISION, PROCESS_UNVERIFIABLE; restore가 과거 PID 권한 부활시키지 않음
