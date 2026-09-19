# 도메인 연산과 구현 소유자

문서 ID: S-OPERATIONS · 소비 시점: IMP-02/IMP-11/IMP-30과 계약 검토자

입력·권한·저장 효과·실패 의미의 정본은 링크한 계약이다. C-HOST의 15개 연산은 실행면 서비스 전용이며 나머지 77개도 역할별 scope에 따라 제한된다. 전체 목록을 업무 agent에게 자동 주입하지 않는다. 이 색인은 계약과 계획에서 생성한다.

| operation | 계약 | 구현 owner | 기본 주체 |
| --- | --- | --- | --- |
| project.create | [C-MODEL](contracts/model.md) | [IMP-04](../implementation-plan/tasks/IMP-04/instruction.md) | operator |
| project.get | [C-MODEL](contracts/model.md) | [IMP-04](../implementation-plan/tasks/IMP-04/instruction.md) | project.read 허용 주체 |
| model.snapshot | [C-MODEL](contracts/model.md) | [IMP-04](../implementation-plan/tasks/IMP-04/instruction.md) | model.read 허용 주체 |
| model.change.prepare | [C-MODEL](contracts/model.md) | [IMP-04](../implementation-plan/tasks/IMP-04/instruction.md) | model.maintain grant |
| model.change.commit | [C-MODEL](contracts/model.md) | [IMP-04](../implementation-plan/tasks/IMP-04/instruction.md) | model.maintain grant |
| model.impact.list | [C-MODEL](contracts/model.md) | [IMP-27](../implementation-plan/tasks/IMP-27/instruction.md) | 해당 책임자 또는 유지 담당자 |
| model.impact.classify | [C-MODEL](contracts/model.md) | [IMP-27](../implementation-plan/tasks/IMP-27/instruction.md) | 지정 유지 판단 주체 |
| responsibility.search | [C-DISCOVERY](contracts/discovery-assignment.md) | [IMP-06](../implementation-plan/tasks/IMP-06/instruction.md) | 팀장 discovery.search / 위임된 범위 |
| responsibility.inspect | [C-DISCOVERY](contracts/discovery-assignment.md) | [IMP-06](../implementation-plan/tasks/IMP-06/instruction.md) | discovery.read 범위 |
| responsibility.locate | [C-DISCOVERY](contracts/discovery-assignment.md) | [IMP-06](../implementation-plan/tasks/IMP-06/instruction.md) | discovery.locate 범위 |
| responsibility.collaborators | [C-DISCOVERY](contracts/discovery-assignment.md) | [IMP-06](../implementation-plan/tasks/IMP-06/instruction.md) | 자기 역할 또는 팀장 scope |
| role.implementations | [C-DISCOVERY](contracts/discovery-assignment.md) | [IMP-06](../implementation-plan/tasks/IMP-06/instruction.md) | role 읽기와 discovery 권한 |
| assignment.preview | [C-DISCOVERY](contracts/discovery-assignment.md) | [IMP-13](../implementation-plan/tasks/IMP-13/instruction.md) | team.plan 위임 범위 |
| interface.get | [C-REALIZATION](contracts/realization.md) | [IMP-07](../implementation-plan/tasks/IMP-07/instruction.md) | role 구현 담당자 / role.read |
| implementation.prepare | [C-REALIZATION](contracts/realization.md) | [IMP-07](../implementation-plan/tasks/IMP-07/instruction.md) | role.implement 위임 |
| implementation.publish | [C-REALIZATION](contracts/realization.md) | [IMP-07](../implementation-plan/tasks/IMP-07/instruction.md) | 구현 공개 권한자 |
| implementation.retire | [C-REALIZATION](contracts/realization.md) | [IMP-07](../implementation-plan/tasks/IMP-07/instruction.md) | 구현 유지 담당자 |
| harness.profile.register | [C-REALIZATION](contracts/realization.md) | [IMP-07](../implementation-plan/tasks/IMP-07/instruction.md) | operator 또는 profile-maintainer |
| harness.profile.inspect | [C-REALIZATION](contracts/realization.md) | [IMP-07](../implementation-plan/tasks/IMP-07/instruction.md) | 해당 profile 사용 권한 |
| harness.profile.admit | [C-REALIZATION](contracts/realization.md) | [IMP-07](../implementation-plan/tasks/IMP-07/instruction.md) | operator/profile 검증 책임자 |
| context.build | [C-REALIZATION](contracts/realization.md) | [IMP-08](../implementation-plan/tasks/IMP-08/instruction.md) | 역할 구성 또는 launch service |
| context.inspect | [C-REALIZATION](contracts/realization.md) | [IMP-09](../implementation-plan/tasks/IMP-09/instruction.md) | 자기 execution 또는 범위 내 팀장/유지 담당자 |
| surface.describe | [C-ACCESS](contracts/access-cli.md) | [IMP-11](../implementation-plan/tasks/IMP-11/instruction.md) | bootstrap 또는 current Member/operator |
| access.policy.publish | [C-ACCESS](contracts/access-cli.md) | [IMP-10](../implementation-plan/tasks/IMP-10/instruction.md) | operator policy administrator |
| access.grant | [C-ACCESS](contracts/access-cli.md) | [IMP-10](../implementation-plan/tasks/IMP-10/instruction.md) | operator 또는 제한된 delegator |
| access.revoke | [C-ACCESS](contracts/access-cli.md) | [IMP-10](../implementation-plan/tasks/IMP-10/instruction.md) | 해당 grant 발급/폐기 권한자 |
| access.inspect | [C-ACCESS](contracts/access-cli.md) | [IMP-10](../implementation-plan/tasks/IMP-10/instruction.md) | 자기 binding 또는 관리 범위 |
| run.create | [C-WORK](contracts/work.md) | [IMP-13](../implementation-plan/tasks/IMP-13/instruction.md) | run.create 위임 또는 operator |
| run.get | [C-WORK](contracts/work.md) | [IMP-13](../implementation-plan/tasks/IMP-13/instruction.md) | Run 참여자/조율자 |
| run.close | [C-WORK](contracts/work.md) | [IMP-13](../implementation-plan/tasks/IMP-13/instruction.md) | Run 결합 책임자 |
| plan.prepare | [C-WORK](contracts/work.md) | [IMP-13](../implementation-plan/tasks/IMP-13/instruction.md) | 팀장 plan.write 범위 |
| plan.commit | [C-WORK](contracts/work.md) | [IMP-13](../implementation-plan/tasks/IMP-13/instruction.md) | 팀장 plan.write 범위 |
| team.assign | [C-WORK](contracts/work.md) | [IMP-13](../implementation-plan/tasks/IMP-13/instruction.md) | 제한된 provisioning 권한을 가진 팀장 |
| team.retire | [C-WORK](contracts/work.md) | [IMP-13](../implementation-plan/tasks/IMP-13/instruction.md) | 해당 Member의 조율 책임자 |
| assignment.show | [C-WORK](contracts/work.md) | [IMP-13](../implementation-plan/tasks/IMP-13/instruction.md) | bootstrap/자기 Member |
| task.accept | [C-WORK](contracts/work.md) | [IMP-20](../implementation-plan/tasks/IMP-20/instruction.md) | 현재 Dispatch의 Member |
| task.report | [C-WORK](contracts/work.md) | [IMP-21](../implementation-plan/tasks/IMP-21/instruction.md) | 현재 Task 책임자 |
| outcome.decide | [C-WORK](contracts/work.md) | [IMP-21](../implementation-plan/tasks/IMP-21/instruction.md) | TaskSpec에 지정된 수용 주체 |
| inbox.check | [C-MAIL](contracts/mail-artifacts.md) | [IMP-15](../implementation-plan/tasks/IMP-15/instruction.md) | 현재 Member |
| inbox.wait | [C-MAIL](contracts/mail-artifacts.md) | [IMP-15](../implementation-plan/tasks/IMP-15/instruction.md) | 현재 Member |
| delivery.ack | [C-MAIL](contracts/mail-artifacts.md) | [IMP-15](../implementation-plan/tasks/IMP-15/instruction.md) | Delivery의 현재 recipient |
| message.send | [C-MAIL](contracts/mail-artifacts.md) | [IMP-15](../implementation-plan/tasks/IMP-15/instruction.md) | peer messaging grant |
| message.replyAndAck | [C-MAIL](contracts/mail-artifacts.md) | [IMP-15](../implementation-plan/tasks/IMP-15/instruction.md) | 현재 recipient |
| artifact.publish | [C-MAIL](contracts/mail-artifacts.md) | [IMP-15](../implementation-plan/tasks/IMP-15/instruction.md) | 현재 producer Dispatch |
| artifact.read | [C-MAIL](contracts/mail-artifacts.md) | [IMP-15](../implementation-plan/tasks/IMP-15/instruction.md) | 정확한 artifact를 읽도록 허용된 참여자 |
| operation.get | [C-MAIL](contracts/mail-artifacts.md) | [IMP-12](../implementation-plan/tasks/IMP-12/instruction.md) | 자기 요청 또는 관리 범위 |
| worker.prepare | [C-LAUNCH](contracts/launch.md) | [IMP-19](../implementation-plan/tasks/IMP-19/instruction.md) | provisioning 권한을 가진 팀장/launch service |
| worker.start | [C-LAUNCH](contracts/launch.md) | [IMP-19](../implementation-plan/tasks/IMP-19/instruction.md) | 해당 LaunchPlan 실행 권한자 |
| worker.inspect | [C-LAUNCH](contracts/launch.md) | [IMP-19](../implementation-plan/tasks/IMP-19/instruction.md) | 자기 Member 또는 조율 범위 |
| execution.join | [C-LAUNCH](contracts/launch.md) | [IMP-20](../implementation-plan/tasks/IMP-20/instruction.md) | bootstrap credential의 agent |
| execution.heartbeat | [C-LAUNCH](contracts/launch.md) | [IMP-20](../implementation-plan/tasks/IMP-20/instruction.md) | 현재 실행의 Member |
| worker.stop | [C-LAUNCH](contracts/launch.md) | [IMP-22](../implementation-plan/tasks/IMP-22/instruction.md) | 해당 실행 정지 권한자 |
| worker.resume | [C-LAUNCH](contracts/launch.md) | [IMP-22](../implementation-plan/tasks/IMP-22/instruction.md) | 해당 Member 재개 권한자 |
| worker.release | [C-LAUNCH](contracts/launch.md) | [IMP-22](../implementation-plan/tasks/IMP-22/instruction.md) | 정산 이후 자원 처분 권한자 |
| execution.wake | [C-LAUNCH](contracts/launch.md) | [IMP-21](../implementation-plan/tasks/IMP-21/instruction.md) | 현재 continuation grant 또는 operator |
| host.hello | [C-HOST](contracts/execution-host.md) | [IMP-17](../implementation-plan/tasks/IMP-17/instruction.md) | mahasd service |
| host.acquire | [C-HOST](contracts/execution-host.md) | [IMP-17](../implementation-plan/tasks/IMP-17/instruction.md) | mahasd service |
| host.inventory | [C-HOST](contracts/execution-host.md) | [IMP-17](../implementation-plan/tasks/IMP-17/instruction.md) | 현재/복구 controller |
| host.effect.get | [C-HOST](contracts/execution-host.md) | [IMP-17](../implementation-plan/tasks/IMP-17/instruction.md) | controller |
| host.process.spawn | [C-HOST](contracts/execution-host.md) | [IMP-18](../implementation-plan/tasks/IMP-18/instruction.md) | lease owner |
| host.process.probe | [C-HOST](contracts/execution-host.md) | [IMP-18](../implementation-plan/tasks/IMP-18/instruction.md) | controller |
| host.process.stop | [C-HOST](contracts/execution-host.md) | [IMP-18](../implementation-plan/tasks/IMP-18/instruction.md) | lease owner |
| host.terminal.attach | [C-HOST](contracts/execution-host.md) | [IMP-18](../implementation-plan/tasks/IMP-18/instruction.md) | 허용 controller/client proxy |
| host.terminal.input | [C-HOST](contracts/execution-host.md) | [IMP-18](../implementation-plan/tasks/IMP-18/instruction.md) | current InputLease proxy |
| host.terminal.resize | [C-HOST](contracts/execution-host.md) | [IMP-18](../implementation-plan/tasks/IMP-18/instruction.md) | current size owner proxy |
| host.terminal.snapshot | [C-HOST](contracts/execution-host.md) | [IMP-18](../implementation-plan/tasks/IMP-18/instruction.md) | 허용 reader |
| host.terminal.detach | [C-HOST](contracts/execution-host.md) | [IMP-18](../implementation-plan/tasks/IMP-18/instruction.md) | 허용 reader |
| host.workspace.prepare | [C-HOST](contracts/execution-host.md) | [IMP-16](../implementation-plan/tasks/IMP-16/instruction.md) | lease owner |
| host.workspace.probe | [C-HOST](contracts/execution-host.md) | [IMP-16](../implementation-plan/tasks/IMP-16/instruction.md) | controller |
| host.workspace.release | [C-HOST](contracts/execution-host.md) | [IMP-16](../implementation-plan/tasks/IMP-16/instruction.md) | lease owner |
| workspace.prepare | [C-RESOURCE](contracts/resources.md) | [IMP-16](../implementation-plan/tasks/IMP-16/instruction.md) | placement 권한 팀장/launch service |
| workspace.inspect | [C-RESOURCE](contracts/resources.md) | [IMP-16](../implementation-plan/tasks/IMP-16/instruction.md) | 해당 작업/조율 scope |
| claim.handoff | [C-RESOURCE](contracts/resources.md) | [IMP-16](../implementation-plan/tasks/IMP-16/instruction.md) | 현재 소유·배정 조율 권한 |
| claim.release | [C-RESOURCE](contracts/resources.md) | [IMP-16](../implementation-plan/tasks/IMP-16/instruction.md) | 자원 처분 권한자 |
| runtime.status | [C-RECOVERY](contracts/recovery-operations.md) | [IMP-23](../implementation-plan/tasks/IMP-23/instruction.md) | operator / 제한된 status reader |
| runtime.reconcile | [C-RECOVERY](contracts/recovery-operations.md) | [IMP-23](../implementation-plan/tasks/IMP-23/instruction.md) | operator/recovery service |
| runtime.shutdown | [C-RECOVERY](contracts/recovery-operations.md) | [IMP-23](../implementation-plan/tasks/IMP-23/instruction.md) | operator |
| backup.create | [C-RECOVERY](contracts/recovery-operations.md) | [IMP-29](../implementation-plan/tasks/IMP-29/instruction.md) | operator backup 권한 |
| backup.restore | [C-RECOVERY](contracts/recovery-operations.md) | [IMP-29](../implementation-plan/tasks/IMP-29/instruction.md) | operator offline restore |
| observation.ingest | [C-OBSERVATION](contracts/observation-client.md) | [IMP-26](../implementation-plan/tasks/IMP-26/instruction.md) | trusted hook ingress/service 또는 제한된 self reporter |
| intervention.raise | [C-OBSERVATION](contracts/observation-client.md) | [IMP-26](../implementation-plan/tasks/IMP-26/instruction.md) | 자기 담당자/관측 service |
| intervention.resolve | [C-OBSERVATION](contracts/observation-client.md) | [IMP-26](../implementation-plan/tasks/IMP-26/instruction.md) | 지정 responder/operator |
| runtime.snapshot | [C-OBSERVATION](contracts/observation-client.md) | [IMP-26](../implementation-plan/tasks/IMP-26/instruction.md) | 허용 client/조율자 |
| runtime.subscribe | [C-OBSERVATION](contracts/observation-client.md) | [IMP-26](../implementation-plan/tasks/IMP-26/instruction.md) | 허용 client |
| terminal.attach | [C-CLIENT](contracts/client-terminal.md) | [IMP-28](../implementation-plan/tasks/IMP-28/instruction.md) | operator 또는 terminal.read scope |
| terminal.input | [C-CLIENT](contracts/client-terminal.md) | [IMP-28](../implementation-plan/tasks/IMP-28/instruction.md) | operator terminal.input scope |
| terminal.resize | [C-CLIENT](contracts/client-terminal.md) | [IMP-28](../implementation-plan/tasks/IMP-28/instruction.md) | 현재 input/size owner |
| terminal.snapshot | [C-CLIENT](contracts/client-terminal.md) | [IMP-28](../implementation-plan/tasks/IMP-28/instruction.md) | terminal.read scope |
| terminal.detach | [C-CLIENT](contracts/client-terminal.md) | [IMP-28](../implementation-plan/tasks/IMP-28/instruction.md) | 해당 구독 client |
| client.view.bind | [C-CLIENT](contracts/client-terminal.md) | [IMP-28](../implementation-plan/tasks/IMP-28/instruction.md) | UI client 본인 |
| client.view.unbind | [C-CLIENT](contracts/client-terminal.md) | [IMP-28](../implementation-plan/tasks/IMP-28/instruction.md) | UI client 본인 |
| task.dispatch | [C-WORK](contracts/work.md) | [IMP-21](../implementation-plan/tasks/IMP-21/instruction.md) | 현재 Task/Member를 배정하는 팀장 |
