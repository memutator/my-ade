# 제출 문서의 정합성 확인

**대상:** 이 문서 패키지 · **근거 수준:** 문서와 명세 형식의 정적 확인 · **제품 실행 검증:** 미실행

이 기록은 verification Task를 수행한 결과가 아니다. 구현 코드를 제공하거나 실제 mahas 저장소를 수정하지 않았으며, 실제 CLI 하네스·RPC·PTY·권한·프로세스 복구 시험을 실행하지 않았다. 검증 담당자는 각 Task에 지정된 환경과 구현 revision이 준비된 뒤 별도로 수행해야 한다.

## 실제 수행한 확인

| 확인 대상 | 수행 방법 | 결과와 제한 |
|---|---|---|
| 파일 구성 | 생성 파일과 확장자, 필수 문서 및 금지된 보조 폴더 확인 | Markdown 91개와 DAG JSON 4개. source/reference/examples 폴더 없음 |
| 상대 문서 링크 | Markdown의 로컬 경로를 실제 생성 파일과 대조 | 확인 시점의 1,052개 상대 링크가 모두 존재함. 모든 내용의 의미적 완전성을 증명하는 검사는 아님 |
| 구현 계획 | 32개 Task의 identity·instruction·필수 읽기·선행 인계 확인 | 내부 의존 DAG 비순환, 17개 위상 단계. 리뷰/검증 Task가 구현 DAG에 섞이지 않음 |
| 검토·검증 계획 | review 8개와 verification 12개의 의존·구현 입력 확인 | 각 내부 DAG 및 세 계획을 연결하는 delivery DAG 비순환. 최종 결합은 IMP-30/REV-08/VER-12 |
| 연산 소유권 | 계약의 연산 헤딩과 구현 DAG의 담당 연산 대조 | 92개 연산마다 구현 담당 1개. 그중 15개는 실행면 서비스 전용, 나머지도 역할별 제한 대상 |
| 요구사항·수락 ID | REQ/AC 참조와 각 계획의 연결 확인 | REQ-01~28, AC-01~28 유효. REQ-26은 문서 계획 분리 요구이므로 별도 기능 구현 Task를 만들지 않음 |
| 읽을 절 | Task requiredReads의 숫자 절을 대상 문서의 실제 헤딩과 대조 | 지정된 숫자 절 존재 |
| SQLite DDL | storage.md 안의 두 정본 DDL을 각각 별도 메모리 DB에서 실행 | Python sqlite3의 SQLite 3.46.1에서 CREATE 문 파싱 성공. 운영 binding·실제 migration·동시성·장애 내구성 미검증 |
| Markdown 구조 | 코드 fence 짝과 생성 파일 형식 확인 | 끊어진 코드 fence 없음 |

DDL 확인은 빈 schema를 만드는 형식 검사다. 빈 DB의 foreign_key_check가 비어 있다는 사실을 실제 데이터 불변식, 트랜잭션 경합, 권한, 복구의 성공으로 확대하지 않는다. 이 제출에서 수행한 정합성 확인을 제품 테스트 개수로 집계하지 않는다.

## 아직 수행하지 않은 것

구현 Task 32개는 계획 상태다. Review Task 8개와 Verification Task 12개도 제품 코드에 대해 수행하지 않았다. 실제 Claude/Codex 설정의 로딩, 다른 하네스와의 협업, 사용자 계정·sandbox 접근, 시작/종료의 결과 불명, 재부착, 프로세스 identity, OS 격리, SQLite 전원 장애 내구성은 각 명세와 독립 검증 Task가 요구하는 후속 실행 대상이다.

외부 CLI 옵션은 S-INJECTION에 조회 근거와 범위를 적었다. 문서에 옵션이 있다는 사실과 특정 설치 버전에서 같은 구성품이 실제 전달됐다는 사실을 구별한다. 각 HarnessProfile은 해당 검증 evidence 없이 verified로 활성화하지 않는다.

## 제출물 사용

팀장은 루트 README에서 요구사항·명세·수락 기준을 확인하고 구현 DAG를 배정한다. 담당자는 자기 instruction과 지정된 읽기/인계물만 받는다. 이 확인 기록을 모든 agent의 초기 context에 추가할 필요는 없다.
