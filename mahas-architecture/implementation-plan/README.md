# 구현 계획 인덱스

**소비자:** 팀장·구현 담당자. **목적:** 문서 한 개의 거대한 체크리스트 대신 실제 배정 가능한 Task와 계약 인계를 제공한다.

[공통 지시](INSTRUCTIONS.md) · [DAG](DAG.md) · [기계 판독 DAG](dag.json)

## 배정 흐름

팀장은 requirements와 architecture를 읽고 준비된 선행 인계가 있는 Task를 고른다. 담당자에게 해당 instruction을 첫 입력으로 주고 requiredReads와 exact inputHandoff를 함께 전달한다. 모든 Task 파일을 하나의 agent에게 읽히지 않는다. 독립 검토와 실행 시험은 [review-plan](../review-plan/README.md), [verification-plan](../verification-plan/README.md)에 있다.

## Task 목록

| Task | 책임 | 담당 역할 | 선행 |
| --- | --- | --- | --- |
| [IMP-01](tasks/IMP-01/instruction.md) | 기존 앱 연결 지점과 서비스 package 경계 구현 | 플랫폼 통합 구현자 | 없음 |
| [IMP-02](tasks/IMP-02/instruction.md) | 전체 도메인 타입과 wire schema의 정본 구현 | 도메인 계약 구현자 | IMP-01 |
| [IMP-03](tasks/IMP-03/instruction.md) | 두 SQLite 저장 경계와 transaction/content store 구현 | 저장소 구현자 | IMP-02 |
| [IMP-04](tasks/IMP-04/instruction.md) | SQLite RDD aggregate와 원자적 모델 변경 구현 | 책임 모델 구현자 | IMP-03, IMP-10, IMP-11 |
| [IMP-05](tasks/IMP-05/instruction.md) | 책임 관계 인덱스·territory·변경 영향 계산 구현 | 책임 조회 기반 구현자 | IMP-04 |
| [IMP-06](tasks/IMP-06/instruction.md) | 팀장의 책임 탐색·관계 조회 API 구현 | 팀 배정 탐색 구현자 | IMP-05, IMP-07, IMP-10, IMP-11 |
| [IMP-07](tasks/IMP-07/instruction.md) | RoleInterface와 RoleImplementation 저작·공개 서비스 구현 | 역할 실현 구현자 | IMP-04, IMP-10, IMP-11 |
| [IMP-08](tasks/IMP-08/instruction.md) | 결정적 role component compiler와 ContextBundle 구현 | 컨텍스트 compiler 구현자 | IMP-05, IMP-07, IMP-11 |
| [IMP-09](tasks/IMP-09/instruction.md) | 구성품 materializer와 실효 컨텍스트 검사 조회 구현 | 컨텍스트 설치 구현자 | IMP-08, IMP-16 |
| [IMP-10](tasks/IMP-10/instruction.md) | 주체·정책·grant·폐기 인가 코어 구현 | 권한 구현자 | IMP-03 |
| [IMP-11](tasks/IMP-11/instruction.md) | OperationRegistry·동일 admission·역할별 surface 구현 | API 정책 경계 구현자 | IMP-02, IMP-10 |
| [IMP-12](tasks/IMP-12/instruction.md) | 로컬 협업 RPC와 얇은 mahas CLI 구현 | 협업 transport 구현자 | IMP-11, IMP-03 |
| [IMP-13](tasks/IMP-13/instruction.md) | Run·팀장 배정·META DAG·Assignment 서비스 구현 | 협업 도메인 구현자 | IMP-04, IMP-06, IMP-10, IMP-11 |
| [IMP-14](tasks/IMP-14/instruction.md) | TaskSpec·Dispatch 권한·입력 pin과 WorkEnvelope 구현 | 작업 시도 구현자 | IMP-13, IMP-08 |
| [IMP-15](tasks/IMP-15/instruction.md) | durable inbox·회신·artifact 저장 API 구현 | 메시지 구현자 | IMP-12, IMP-14, IMP-16 |
| [IMP-16](tasks/IMP-16/instruction.md) | workspace·checkout·write claim과 물리 자원 primitive 구현 | 작업 공간 구현자 | IMP-03, IMP-10, IMP-17 |
| [IMP-17](tasks/IMP-17/instruction.md) | 재부착 가능한 execution-host bootstrap·lease·receipt 서비스 구현 | 실행 호스트 구현자 | IMP-01, IMP-02, IMP-03 |
| [IMP-18](tasks/IMP-18/instruction.md) | 범용 PTY·pipes process와 terminal I/O 관리 구현 | 프로세스 실행 구현자 | IMP-17 |
| [IMP-19](tasks/IMP-19/instruction.md) | 고정 LaunchPlan과 단계별 worker.start coordinator 구현 | 스폰 조율 구현자 | IMP-09, IMP-14, IMP-16, IMP-18, IMP-11 |
| [IMP-20](tasks/IMP-20/instruction.md) | worker bootstrap·join·명시 Task 인수 연결 구현 | 실행 인수 프로토콜 구현자 | IMP-12, IMP-19 |
| [IMP-21](tasks/IMP-21/instruction.md) | 결과 선언·지정 수용·직접 인계와 안전 wake 연결 구현 | 협업 정산 구현자 | IMP-15, IMP-20 |
| [IMP-22](tasks/IMP-22/instruction.md) | 실행 정지·재부착·native resume·unknown reconciliation 구현 | 실행 복구 구현자 | IMP-16, IMP-18, IMP-19, IMP-20, IMP-21 |
| [IMP-23](tasks/IMP-23/instruction.md) | mahasd 서비스 수명·재시작 readiness·종료 정책 구현 | 런타임 수명 구현자 | IMP-01, IMP-12, IMP-17, IMP-22 |
| [IMP-24](tasks/IMP-24/instruction.md) | 파일 기반 하네스의 구성품 구현과 launch recipe 작성 | 하네스 구성 구현자 | IMP-07, IMP-09, IMP-19, IMP-20 |
| [IMP-25](tasks/IMP-25/instruction.md) | 설정 본문 기반 하네스의 구성품 구현과 launch recipe 작성 | 하네스 구성 구현자 | IMP-07, IMP-09, IMP-19, IMP-20 |
| [IMP-26](tasks/IMP-26/instruction.md) | 관측 출처·개입·snapshot/event projection 구현 | 관측 구현자 | IMP-11, IMP-13, IMP-15, IMP-18, IMP-21 |
| [IMP-27](tasks/IMP-27/instruction.md) | 모델·context 변경 후보와 별도 유지 작업 흐름 구현 | 유지관리 구현자 | IMP-05, IMP-07, IMP-13, IMP-21 |
| [IMP-28](tasks/IMP-28/instruction.md) | Desktop·detached client·terminal view의 정본 분리 구현 | 작업대 통합 구현자 | IMP-12, IMP-23, IMP-26 |
| [IMP-29](tasks/IMP-29/instruction.md) | 운영 migration·일관 backup·retention·복구 구현 | 운영 저장 구현자 | IMP-03, IMP-16, IMP-22, IMP-23 |
| [IMP-30](tasks/IMP-30/instruction.md) | 전체 runtime 배선·CLI 배포·service entrypoint 조립 | 아키텍처 통합 구현자 | IMP-23, IMP-24, IMP-25, IMP-27, IMP-28, IMP-29, IMP-31, IMP-32 |
| [IMP-31](tasks/IMP-31/instruction.md) | 책임 탐색·배정·META DAG 작업대 구현 | 팀장 작업대 구현자 | IMP-06, IMP-13, IMP-26 |
| [IMP-32](tasks/IMP-32/instruction.md) | 역할 구현 편집·context/권한/spawn Inspector 구현 | 역할 구성 작업대 구현자 | IMP-07, IMP-09, IMP-19, IMP-26 |

## 최종 합류

IMP-30은 기능 wiring/배포 구현의 합류다. 여기서 self-review나 제품 수락을 선언하지 않는다. review/verification evidence를 받은 뒤 최종 책임자가 acceptance.md에 따라 결합한다.
