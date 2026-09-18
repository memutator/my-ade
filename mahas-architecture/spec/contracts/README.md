# 계약 인덱스

모든 mutation은 [S-COMMON](../common.md)의 envelope·인가·receipt·revision 규칙을 따른다. 아래 계약은 본문을 읽어야만 알 수 있는 reference 목록이 아니라, 구현 Task가 지정해 읽는 정식 입출력 명세다. C-HOST만 서비스 전용이며 worker 명령 surface에서 제외한다.

| 계약 | 책임 | 문서 |
| --- | --- | --- |
| C-MODEL | 모델 공개와 변경 영향 | [C-MODEL](model.md) |
| C-DISCOVERY | 팀장의 책임 탐색·조회·배정 준비 | [C-DISCOVERY](discovery-assignment.md) |
| C-REALIZATION | 역할 구현의 공개·빌드·실효 구성 조회 | [C-REALIZATION](realization.md) |
| C-ACCESS | 역할별 CLI·인증·인가 | [C-ACCESS](access-cli.md) |
| C-WORK | Run·META DAG·배정·작업 인수 | [C-WORK](work.md) |
| C-MAIL | 공통 mailbox·회신·artifact 인계 | [C-MAIL](mail-artifacts.md) |
| C-LAUNCH | 스폰·초기 입력·인수·계속 수행 | [C-LAUNCH](launch.md) |
| C-HOST | 재부착 가능한 실행 호스트 프로토콜 | [C-HOST](execution-host.md) |
| C-RESOURCE | 실제 자원 배치·인계·해제 | [C-RESOURCE](resources.md) |
| C-RECOVERY | 재연결·재개·재시도·운영 복구 | [C-RECOVERY](recovery-operations.md) |
| C-OBSERVATION | 관측·개입·UI projection | [C-OBSERVATION](observation-client.md) |
| C-CLIENT | Desktop·터미널 사용 표면 | [C-CLIENT](client-terminal.md) |
