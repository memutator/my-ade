# S-STORAGE — SQLite 전체 영속 모델과 migration 계약

**소비 시점:** IMP-02~IMP-05, 각 도메인 repository 담당자, IMP-17/18/29. 아래 DDL은 부록용 reference가 아니라 v1 migration이 구현해야 할 저장 계약이다. payload JSON의 구조는 domains 문서와 각 C-* 계약을 따른다. JSON schema 검증과 aggregate 의미 검사를 SQL CHECK 하나로 대체하지 않는다.

## 1. 정본 경계

mahas.sqlite에 RDD와 모든 제어 도메인을 저장한다. 프로젝트 파일의 records.json은 optional import/export일 뿐 정본이 아니다. RDD context 본문·코드·타입·테스트의 저작 정본은 원래 파일이다. 실행 때 고정한 byte snapshot은 content_blobs에 저장하며 이를 별도로 저작/동기화하지 않는다. execution-host.sqlite는 OS primitive effect와 현재 process 증거만 소유한다.

본 DDL은 schema v1의 논리 시작점이다. published 객체 immutability, tree 연결성, criterion 1개 이상, context coverage, same-project/run scope, DAG cycle, composite JSON identity는 repository/service transaction에서 추가 검사한다. FOREIGN KEY가 이 의미 검사를 모두 보장한다고 주장하지 않는다.

## 2. 저장 매핑

| 테이블 | 도메인/주의사항 |
| --- | --- |
| schema_meta | 지원 schema/protocol 범위 |
| migration_receipts | MigrationReceipt |
| content_blobs | ContentBlob; 작은 context/config는 body, 대형 artifact만 external_ref 허용 |
| projects | Project |
| model_versions | ModelVersion; published 수정은 service에서 거부 |
| rdd_boundaries | Boundary와 단일 responsibility |
| rdd_criteria | Criterion; 한 개 이상은 publish transaction 검사 |
| boundary_paths | 코드 영토 인덱스 입력 |
| boundary_edges | Contains; recursive cycle/connected root는 publish에서 검사 |
| horizontal_roles | HorizontalRole; 전문 context는 별도 관계 |
| rdd_roles | Role; 정책/Task 지시를 넣지 않음 |
| rdd_contexts | Context는 path만 |
| boundary_contexts | 영토 지침 |
| horizontal_contexts | 전문 지침 |
| rdd_contracts | Contract |
| contract_consumers | ContractConsumer |
| rdd_non_goals | NonGoal |
| model_changes | ModelChange candidates; typed edits schema는 C-MODEL |
| role_search_rows | 재생성 가능한 검색 projection; 한국어 부분조회 fallback |
| role_interfaces | RoleInterface/ContextRequirement |
| harness_profiles | HarnessProfile |
| role_implementations | RoleImplementation; maintainer scope는 interface의 model로 resolve |
| implementation_components | ImplementationComponent/CoverageBinding; graph와 clause validity는 publish 검사 |
| maintenance_bindings | MaintenanceBinding; runtime 주입 목록과 별개 |
| context_bundles | ContextBundle |
| principals | Principal |
| role_policies | RolePolicy |
| grants | AssignmentGrant/ProvisioningGrant/ContinuationGrant의 typed union |
| command_surfaces | CommandSurface derived immutable snapshot |
| authorization_decisions | AuthorizationDecision |
| runs | Run |
| members | Member; run/model 일치는 C-WORK에서 검사 |
| assignments | Assignment의 immutable revision |
| plans | PlanRevision |
| plan_candidates | plan.prepare 후보 |
| tasks | Task identity; current revision FK 검사 service |
| task_specs | TaskSpec/InputBinding/OutputSlot; owner role는 Run.modelVersion으로 resolve |
| plan_tasks | Plan이 고정한 TaskSpec |
| task_edges | TaskEdge; recursive DAG 검사 C-WORK |
| runtime_instances | RuntimeInstance |
| execution_hosts | ExecutionHost의 control mirror |
| controller_leases | ControllerLease mirror; host가 OS mutation admission을 최종 집행 |
| executions | Execution/ProcessIncarnation/NativeConversation metadata |
| execution_credentials | ExecutionCredential; raw secret DB 미저장 |
| work_envelopes | WorkEnvelope; task text 실제 본문 pin |
| launch_plans | LaunchPlan; plain secret 포함 금지 |
| dispatches | Dispatch; active 하나 partial unique |
| injection_receipts | InjectionReceipt/EffectiveContextReceipt |
| worker_joins | WorkerJoin |
| operation_receipts | CommandReceipt |
| effect_intents | EffectIntent/EffectReceipt/ResidualResource |
| messages | Message |
| deliveries | Delivery; InboxRead는 response snapshot, 따로 정본 불필요 |
| wake_requests | WakeRequest |
| artifacts | Artifact; blob 또는 Git object existence는 publish 검사 |
| outcomes | Outcome |
| outcome_outputs | 정확한 output 바인딩 |
| settlements | Settlement; latest accepted revision은 projection |
| run_decisions | RunDecision |
| resources | 자원 공통 identity |
| checkouts | Checkout |
| workspaces | Workspace |
| resource_claims | ResourceClaim; polymorphic owner는 C-RESOURCE resolver에서 검증 |
| resource_transfers | ResourceTransfer |
| terminal_records | Terminal control mirror |
| terminal_input_leases | InputLease |
| retention_pins | RetentionPin typed resolver |
| handoffs | Handoff |
| observations | ObservationFact/AttemptObservation; bound/unbound 허용 |
| interventions | Intervention |
| domain_events | DomainEvent/projection outbox |
| effect_outbox | 접수된 effect intent pump; 새 업무 scheduler 아님 |
| client_view_bindings | ClientViewBinding; subscription cursor는 server response value |
| resume_candidates | ResumeCandidate |
| impact_candidates | ImpactCandidate |
| backup_sets | BackupSet |
| runtime_shutdowns | RuntimeShutdown |
| support_attestations | SupportAttestation |

## 3. control DB DDL

```sql
PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA busy_timeout=5000;

CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE migration_receipts (
  id TEXT PRIMARY KEY,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  state TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
);

CREATE TABLE content_blobs (
  digest TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length>=0),
  body BLOB,
  external_ref TEXT,
  verified INTEGER NOT NULL CHECK(verified IN (0,1)),
  CHECK((body IS NOT NULL)+(external_ref IS NOT NULL)=1)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL,
  repository_root TEXT NOT NULL,
  active_model_version TEXT,
  revision INTEGER NOT NULL CHECK(revision>0),
  FOREIGN KEY(active_model_version) REFERENCES model_versions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE model_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_version TEXT,
  root_boundary_id TEXT,
  goal_snapshot TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','published','superseded')),
  digest TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(parent_version) REFERENCES model_versions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(id,root_boundary_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE rdd_boundaries (
  model_version TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  responsibility_statement TEXT NOT NULL,
  PRIMARY KEY(model_version,id),
  FOREIGN KEY(model_version) REFERENCES model_versions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE rdd_criteria (
  model_version TEXT NOT NULL,
  boundary_id TEXT NOT NULL,
  id TEXT NOT NULL,
  criterion TEXT NOT NULL,
  description TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(model_version,boundary_id,id),
  FOREIGN KEY(model_version,boundary_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE boundary_paths (
  model_version TEXT NOT NULL,
  boundary_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('file','directory')),
  PRIMARY KEY(model_version,boundary_id,path),
  FOREIGN KEY(model_version,boundary_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE boundary_edges (
  model_version TEXT NOT NULL,
  child_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  PRIMARY KEY(model_version,child_id),
  CHECK(child_id<>parent_id),
  FOREIGN KEY(model_version,child_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(model_version,parent_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE horizontal_roles (
  model_version TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY(model_version,name),
  FOREIGN KEY(model_version) REFERENCES model_versions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE rdd_roles (
  model_version TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  boundary_id TEXT NOT NULL,
  horizontal_role_name TEXT NOT NULL,
  PRIMARY KEY(model_version,id),
  FOREIGN KEY(model_version,boundary_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(model_version,horizontal_role_name) REFERENCES horizontal_roles(model_version,name) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE rdd_contexts (
  model_version TEXT NOT NULL,
  id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY(model_version,id),
  FOREIGN KEY(model_version) REFERENCES model_versions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE boundary_contexts (
  model_version TEXT NOT NULL,
  boundary_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  PRIMARY KEY(model_version,boundary_id,context_id),
  FOREIGN KEY(model_version,boundary_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(model_version,context_id) REFERENCES rdd_contexts(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE horizontal_contexts (
  model_version TEXT NOT NULL,
  horizontal_role_name TEXT NOT NULL,
  context_id TEXT NOT NULL,
  PRIMARY KEY(model_version,horizontal_role_name,context_id),
  FOREIGN KEY(model_version,horizontal_role_name) REFERENCES horizontal_roles(model_version,name) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(model_version,context_id) REFERENCES rdd_contexts(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE rdd_contracts (
  model_version TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  schema_path TEXT NOT NULL,
  provider_boundary_id TEXT NOT NULL,
  PRIMARY KEY(model_version,id),
  FOREIGN KEY(model_version,provider_boundary_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE contract_consumers (
  model_version TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  consumer_boundary_id TEXT NOT NULL,
  PRIMARY KEY(model_version,contract_id,consumer_boundary_id),
  FOREIGN KEY(model_version,contract_id) REFERENCES rdd_contracts(model_version,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(model_version,consumer_boundary_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE rdd_non_goals (
  model_version TEXT NOT NULL,
  id TEXT NOT NULL,
  boundary_id TEXT NOT NULL,
  statement TEXT NOT NULL,
  PRIMARY KEY(model_version,id),
  FOREIGN KEY(model_version,boundary_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE model_changes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  base_version TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  edits_json TEXT NOT NULL CHECK(json_valid(edits_json)),
  touched_targets_json TEXT NOT NULL CHECK(json_valid(touched_targets_json)),
  diagnostics_json TEXT NOT NULL CHECK(json_valid(diagnostics_json)),
  FOREIGN KEY(project_id) REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(base_version) REFERENCES model_versions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE role_search_rows (
  model_version TEXT NOT NULL,
  role_id TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  PRIMARY KEY(model_version,role_id),
  FOREIGN KEY(model_version,role_id) REFERENCES rdd_roles(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE VIRTUAL TABLE role_search_fts USING fts5(model_version UNINDEXED, role_id UNINDEXED, normalized_text, tokenize='unicode61');

CREATE TABLE role_interfaces (
  digest TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  role_id TEXT NOT NULL,
  requirements_json TEXT NOT NULL CHECK(json_valid(requirements_json)),
  judgment_scope_json TEXT NOT NULL CHECK(json_valid(judgment_scope_json)),
  FOREIGN KEY(model_version,role_id) REFERENCES rdd_roles(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE harness_profiles (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  recipe_json TEXT NOT NULL CHECK(json_valid(recipe_json)),
  capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
  executable_identity_json TEXT NOT NULL CHECK(json_valid(executable_identity_json)),
  PRIMARY KEY(id,revision)
);

CREATE TABLE role_implementations (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  interface_digest TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  maintainer_role_id TEXT NOT NULL,
  semantic_decision TEXT,
  PRIMARY KEY(id,revision),
  FOREIGN KEY(interface_digest) REFERENCES role_interfaces(digest) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(profile_id,profile_revision) REFERENCES harness_profiles(id,revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE implementation_components (
  implementation_id TEXT NOT NULL,
  implementation_revision INTEGER NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  activation TEXT NOT NULL,
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
  consumes_json TEXT NOT NULL CHECK(json_valid(consumes_json)),
  coverage_json TEXT NOT NULL CHECK(json_valid(coverage_json)),
  PRIMARY KEY(implementation_id,implementation_revision,id),
  FOREIGN KEY(implementation_id,implementation_revision) REFERENCES role_implementations(id,revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE maintenance_bindings (
  implementation_id TEXT NOT NULL,
  implementation_revision INTEGER NOT NULL,
  id TEXT NOT NULL,
  basis_ref_json TEXT NOT NULL CHECK(json_valid(basis_ref_json)),
  component_ref_json TEXT NOT NULL CHECK(json_valid(component_ref_json)),
  PRIMARY KEY(implementation_id,implementation_revision,id),
  FOREIGN KEY(implementation_id,implementation_revision) REFERENCES role_implementations(id,revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE context_bundles (
  digest TEXT PRIMARY KEY,
  implementation_id TEXT NOT NULL,
  implementation_revision INTEGER NOT NULL,
  interface_digest TEXT NOT NULL,
  surface_digest TEXT NOT NULL,
  required_text_digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  source_observations_json TEXT NOT NULL CHECK(json_valid(source_observations_json)),
  FOREIGN KEY(implementation_id,implementation_revision) REFERENCES role_implementations(id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(interface_digest) REFERENCES role_interfaces(digest) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(required_text_digest) REFERENCES content_blobs(digest) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE role_policies (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  selector_json TEXT NOT NULL CHECK(json_valid(selector_json)),
  action_ceiling_json TEXT NOT NULL CHECK(json_valid(action_ceiling_json)),
  projection_policy_json TEXT NOT NULL CHECK(json_valid(projection_policy_json)),
  PRIMARY KEY(id,revision)
);

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('assignment','provisioning','continuation')),
  principal_id TEXT NOT NULL,
  parent_grant_id TEXT,
  policy_id TEXT,
  policy_revision INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  actions_json TEXT NOT NULL CHECK(json_valid(actions_json)),
  FOREIGN KEY(principal_id) REFERENCES principals(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(parent_grant_id) REFERENCES grants(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(policy_id,policy_revision) REFERENCES role_policies(id,revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE command_surfaces (
  digest TEXT PRIMARY KEY,
  actions_and_schemas_json TEXT NOT NULL CHECK(json_valid(actions_and_schemas_json)),
  policy_pins_json TEXT NOT NULL CHECK(json_valid(policy_pins_json))
);

CREATE TABLE authorization_decisions (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  allow INTEGER NOT NULL CHECK(allow IN (0,1)),
  actual_targets_json TEXT NOT NULL CHECK(json_valid(actual_targets_json)),
  policy_evidence_json TEXT NOT NULL CHECK(json_valid(policy_evidence_json)),
  FOREIGN KEY(principal_id) REFERENCES principals(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  goal_text TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'work' CHECK(purpose IN ('work','verification')),
  coordinator_member_id TEXT,
  state TEXT NOT NULL,
  current_plan_revision INTEGER,
  revision INTEGER NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(model_version) REFERENCES model_versions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(coordinator_member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  role_id TEXT NOT NULL,
  implementation_id TEXT NOT NULL,
  implementation_revision INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  current_execution_id TEXT,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(model_version,role_id) REFERENCES rdd_roles(model_version,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(implementation_id,implementation_revision) REFERENCES role_implementations(id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(current_execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE assignments (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('coordination','task')),
  mandate_text TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  task_id TEXT,
  task_revision INTEGER,
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  PRIMARY KEY(id,revision),
  FOREIGN KEY(member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(grant_id) REFERENCES grants(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(task_id,task_revision) REFERENCES task_specs(task_id,revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE plans (
  run_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  dispositions_json TEXT NOT NULL CHECK(json_valid(dispositions_json)),
  PRIMARY KEY(run_id,revision),
  FOREIGN KEY(run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE plan_candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  base_revision INTEGER,
  digest TEXT NOT NULL,
  patch_json TEXT NOT NULL CHECK(json_valid(patch_json)),
  diagnostics_json TEXT NOT NULL CHECK(json_valid(diagnostics_json)),
  FOREIGN KEY(run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  current_dispatch_id TEXT,
  FOREIGN KEY(run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(current_dispatch_id) REFERENCES dispatches(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE task_specs (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  requirement_text TEXT NOT NULL,
  owner_role_id TEXT NOT NULL,
  assigned_member_id TEXT,
  inputs_json TEXT NOT NULL CHECK(json_valid(inputs_json)),
  outputs_json TEXT NOT NULL CHECK(json_valid(outputs_json)),
  settlement_policy_json TEXT NOT NULL CHECK(json_valid(settlement_policy_json)),
  PRIMARY KEY(task_id,revision),
  FOREIGN KEY(task_id) REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(assigned_member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE plan_tasks (
  run_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  PRIMARY KEY(run_id,plan_revision,task_id),
  FOREIGN KEY(run_id,plan_revision) REFERENCES plans(run_id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(task_id,task_revision) REFERENCES task_specs(task_id,revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE task_edges (
  run_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL,
  from_task TEXT NOT NULL,
  to_task TEXT NOT NULL,
  requirements_json TEXT NOT NULL CHECK(json_valid(requirements_json)),
  PRIMARY KEY(run_id,plan_revision,from_task,to_task),
  CHECK(from_task<>to_task),
  FOREIGN KEY(run_id,plan_revision,from_task) REFERENCES plan_tasks(run_id,plan_revision,task_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(run_id,plan_revision,to_task) REFERENCES plan_tasks(run_id,plan_revision,task_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE runtime_instances (
  id TEXT PRIMARY KEY,
  controller_epoch INTEGER NOT NULL UNIQUE,
  state TEXT NOT NULL,
  process_identity_json TEXT NOT NULL CHECK(json_valid(process_identity_json)),
  endpoint_incarnation TEXT NOT NULL
);

CREATE TABLE execution_hosts (
  id TEXT PRIMARY KEY,
  incarnation TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  state TEXT NOT NULL,
  identity_json TEXT NOT NULL CHECK(json_valid(identity_json))
);

CREATE TABLE controller_leases (
  host_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  proof_json TEXT NOT NULL CHECK(json_valid(proof_json)),
  FOREIGN KEY(host_id) REFERENCES execution_hosts(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  host_id TEXT NOT NULL,
  launch_plan_id TEXT NOT NULL,
  state TEXT NOT NULL,
  liveness TEXT NOT NULL CHECK(liveness IN ('live','unverifiable','exited')),
  terminal_id TEXT,
  process_identity_json TEXT NOT NULL CHECK(json_valid(process_identity_json)),
  native_conversation_json TEXT NOT NULL CHECK(json_valid(native_conversation_json)),
  revision INTEGER NOT NULL,
  UNIQUE(member_id,generation),
  FOREIGN KEY(member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(host_id) REFERENCES execution_hosts(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(launch_plan_id) REFERENCES launch_plans(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(terminal_id) REFERENCES terminal_records(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE execution_credentials (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('bootstrap','full')),
  revoked_at INTEGER,
  revision INTEGER NOT NULL,
  FOREIGN KEY(principal_id) REFERENCES principals(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE work_envelopes (
  digest TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  assignment_revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  bindings_json TEXT NOT NULL CHECK(json_valid(bindings_json)),
  FOREIGN KEY(assignment_id,assignment_revision) REFERENCES assignments(id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(body_digest) REFERENCES content_blobs(digest) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE launch_plans (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  assignment_revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  bundle_digest TEXT NOT NULL,
  envelope_digest TEXT NOT NULL,
  surface_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  process_spec_json TEXT NOT NULL CHECK(json_valid(process_spec_json)),
  pins_json TEXT NOT NULL CHECK(json_valid(pins_json)),
  reservations_json TEXT NOT NULL CHECK(json_valid(reservations_json)),
  FOREIGN KEY(assignment_id,assignment_revision) REFERENCES assignments(id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(bundle_digest) REFERENCES context_bundles(digest) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(envelope_digest) REFERENCES work_envelopes(digest) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(surface_digest) REFERENCES command_surfaces(digest) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE dispatches (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  envelope_digest TEXT NOT NULL,
  phase TEXT NOT NULL,
  authority_state TEXT NOT NULL CHECK(authority_state IN ('active','settled','revoked')),
  assignment_delivery_id TEXT,
  revision INTEGER NOT NULL,
  FOREIGN KEY(task_id,task_revision) REFERENCES task_specs(task_id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(envelope_digest) REFERENCES work_envelopes(digest) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(assignment_delivery_id) REFERENCES deliveries(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX one_active_dispatch_per_task ON dispatches(task_id) WHERE authority_state='active';

CREATE UNIQUE INDEX one_active_dispatch_per_execution ON dispatches(execution_id) WHERE authority_state='active';

CREATE TABLE injection_receipts (
  execution_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  revision INTEGER NOT NULL,
  components_json TEXT NOT NULL CHECK(json_valid(components_json)),
  inherited_json TEXT NOT NULL CHECK(json_valid(inherited_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  PRIMARY KEY(execution_id,phase,revision),
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE worker_joins (
  execution_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  bundle_digest TEXT NOT NULL,
  surface_digest TEXT NOT NULL,
  envelope_digest TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(execution_id,generation),
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(bundle_digest) REFERENCES context_bundles(digest) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(surface_digest) REFERENCES command_surfaces(digest) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(envelope_digest) REFERENCES work_envelopes(digest) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE operation_receipts (
  principal_scope TEXT NOT NULL,
  operation TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(principal_scope,operation,operation_id)
);

CREATE TABLE effect_intents (
  id TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  host_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('prepared','attempting','confirmed','rejected','unknown')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  residuals_json TEXT NOT NULL CHECK(json_valid(residuals_json)),
  FOREIGN KEY(host_id) REFERENCES execution_hosts(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sender_principal_id TEXT NOT NULL,
  sender_member_id TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  links_json TEXT NOT NULL CHECK(json_valid(links_json)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(sender_member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(sender_principal_id) REFERENCES principals(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  recipient_member_id TEXT NOT NULL,
  consumer_generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('outstanding','acknowledged','fenced')),
  revision INTEGER NOT NULL,
  acked_at INTEGER,
  handling_json TEXT NOT NULL CHECK(json_valid(handling_json)),
  UNIQUE(message_id,recipient_member_id),
  FOREIGN KEY(message_id) REFERENCES messages(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(recipient_member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX inbox_outstanding ON deliveries(recipient_member_id,status,consumer_generation);

CREATE TABLE wake_requests (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  execution_id TEXT,
  continuation_grant_id TEXT,
  operation_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  delivery_set_json TEXT NOT NULL CHECK(json_valid(delivery_set_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  FOREIGN KEY(member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(continuation_grant_id) REFERENCES grants(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE artifacts (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  producer_dispatch_id TEXT NOT NULL,
  output_slot TEXT NOT NULL,
  digest TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  storage_ref_json TEXT NOT NULL CHECK(json_valid(storage_ref_json)),
  PRIMARY KEY(id,revision),
  FOREIGN KEY(run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(producer_dispatch_id) REFERENCES dispatches(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE outcomes (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  dispatch_id TEXT NOT NULL,
  result TEXT NOT NULL,
  rationale TEXT NOT NULL,
  assessment_json TEXT NOT NULL CHECK(json_valid(assessment_json)),
  contract_effects_json TEXT NOT NULL CHECK(json_valid(contract_effects_json)),
  PRIMARY KEY(id,revision),
  FOREIGN KEY(task_id,task_revision) REFERENCES task_specs(task_id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(dispatch_id) REFERENCES dispatches(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE outcome_outputs (
  outcome_id TEXT NOT NULL,
  outcome_revision INTEGER NOT NULL,
  slot TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_revision INTEGER NOT NULL,
  PRIMARY KEY(outcome_id,outcome_revision,slot),
  FOREIGN KEY(outcome_id,outcome_revision) REFERENCES outcomes(id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(artifact_id,artifact_revision) REFERENCES artifacts(id,revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE settlements (
  id TEXT PRIMARY KEY,
  outcome_id TEXT NOT NULL,
  outcome_revision INTEGER NOT NULL,
  authority_member_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  UNIQUE(outcome_id,outcome_revision),
  FOREIGN KEY(outcome_id,outcome_revision) REFERENCES outcomes(id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(authority_member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE run_decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL,
  coordinator_member_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  FOREIGN KEY(run_id,plan_revision) REFERENCES plans(run_id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(coordinator_member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  host_id TEXT,
  identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
  FOREIGN KEY(host_id) REFERENCES execution_hosts(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE checkouts (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL UNIQUE,
  host_id TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  filesystem_identity TEXT NOT NULL,
  repository_json TEXT NOT NULL CHECK(json_valid(repository_json)),
  revision INTEGER NOT NULL,
  UNIQUE(host_id,canonical_path,filesystem_identity),
  FOREIGN KEY(resource_id) REFERENCES resources(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(host_id) REFERENCES execution_hosts(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(checkout_id) REFERENCES checkouts(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE resource_claims (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('read','write')),
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('held','transferring','released','unknown')),
  revision INTEGER NOT NULL,
  FOREIGN KEY(resource_id) REFERENCES resources(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX one_writer_per_resource ON resource_claims(resource_id) WHERE mode='write' AND state IN ('held','transferring','unknown');

CREATE TABLE resource_transfers (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  from_owner TEXT NOT NULL,
  to_owner TEXT NOT NULL,
  state TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  FOREIGN KEY(claim_id) REFERENCES resource_claims(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE terminal_records (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  host_incarnation TEXT NOT NULL,
  pty_id TEXT NOT NULL,
  output_epoch TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  state TEXT NOT NULL,
  process_identity_json TEXT NOT NULL CHECK(json_valid(process_identity_json)),
  FOREIGN KEY(host_id) REFERENCES execution_hosts(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(resource_id) REFERENCES resources(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE terminal_input_leases (
  terminal_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(terminal_id) REFERENCES terminal_records(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(principal_id) REFERENCES principals(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE retention_pins (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  holder_kind TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  from_dispatch TEXT NOT NULL,
  to_task TEXT,
  to_member TEXT,
  bindings_json TEXT NOT NULL CHECK(json_valid(bindings_json)),
  FOREIGN KEY(from_dispatch) REFERENCES dispatches(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(to_task) REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(to_member) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  execution_id TEXT,
  dispatch_id TEXT,
  source TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  identity_evidence_json TEXT NOT NULL CHECK(json_valid(identity_evidence_json)),
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(dispatch_id) REFERENCES dispatches(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE interventions (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  member_id TEXT,
  execution_id TEXT,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  FOREIGN KEY(run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE domain_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  aggregate_id TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
);

CREATE TABLE effect_outbox (
  effect_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  next_attempt_at INTEGER,
  FOREIGN KEY(effect_id) REFERENCES effect_intents(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE client_view_bindings (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  view_id TEXT NOT NULL,
  execution_id TEXT,
  terminal_id TEXT,
  layout_binding_json TEXT NOT NULL CHECK(json_valid(layout_binding_json)),
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(terminal_id) REFERENCES terminal_records(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE resume_candidates (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  support_state TEXT NOT NULL,
  native_handle_json TEXT NOT NULL CHECK(json_valid(native_handle_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE impact_candidates (
  id TEXT PRIMARY KEY,
  change_ref TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  reason_json TEXT NOT NULL CHECK(json_valid(reason_json)),
  resolution_json TEXT NOT NULL CHECK(json_valid(resolution_json))
);

CREATE TABLE backup_sets (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  consistency_point TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json))
);

CREATE TABLE runtime_shutdowns (
  operation_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  stages_json TEXT NOT NULL CHECK(json_valid(stages_json)),
  residuals_json TEXT NOT NULL CHECK(json_valid(residuals_json))
);

CREATE TABLE support_attestations (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  decision TEXT NOT NULL,
  installation_json TEXT NOT NULL CHECK(json_valid(installation_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  FOREIGN KEY(profile_id,profile_revision) REFERENCES harness_profiles(id,revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX roles_by_boundary ON rdd_roles(model_version,boundary_id);

CREATE INDEX consumers_by_boundary ON contract_consumers(model_version,consumer_boundary_id);

CREATE INDEX members_by_role ON members(model_version,role_id,state);

CREATE INDEX effects_pending ON effect_intents(state,host_id);
```

## 4. execution-host DB DDL

```sql
PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
CREATE TABLE host_identity(id TEXT PRIMARY KEY, incarnation TEXT NOT NULL, protocol_version TEXT NOT NULL, process_identity_json TEXT NOT NULL CHECK(json_valid(process_identity_json)));
CREATE TABLE host_controller_lease(id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL, revision INTEGER NOT NULL, expires_at INTEGER NOT NULL, proof_json TEXT NOT NULL CHECK(json_valid(proof_json)));
CREATE TABLE host_effects(effect_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, intent_json TEXT NOT NULL CHECK(json_valid(intent_json)), receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)));
CREATE TABLE host_processes(spawn_nonce TEXT PRIMARY KEY, execution_id TEXT NOT NULL, generation INTEGER NOT NULL, pid INTEGER, state TEXT NOT NULL, identity_json TEXT NOT NULL CHECK(json_valid(identity_json)), process_spec_json TEXT NOT NULL CHECK(json_valid(process_spec_json)));
CREATE TABLE host_terminals(id TEXT PRIMARY KEY, spawn_nonce TEXT NOT NULL REFERENCES host_processes(spawn_nonce), pty_id TEXT NOT NULL, output_epoch TEXT NOT NULL, last_sequence INTEGER NOT NULL, state TEXT NOT NULL, buffer_ref TEXT);
CREATE TABLE host_workspaces(id TEXT PRIMARY KEY, effect_key TEXT NOT NULL REFERENCES host_effects(effect_key), canonical_path TEXT NOT NULL, identity_json TEXT NOT NULL CHECK(json_valid(identity_json)), state TEXT NOT NULL);

```

## 5. transaction 경계와 publication

모델 publish는 snapshot row·관계·role_search_rows/FTS projection·active pointer·event/receipt를 한 write transaction으로 공개한다. role implementation publish는 components와 coverage를 모두 저장한 뒤 활성화한다. Message send는 모든 수신 Delivery를 함께, replyAndAck는 답변과 원문 ack를 함께 저장한다. Task report는 output ArtifactRef 및 owner-declaration settlement를 함께 저장한다. 외부 file/process effect는 transaction 밖에서 C-HOST의 동일 effect key로 수행한다.

mahasd는 단일 writer이고 background indexer/CLI/renderer가 DB를 직접 수정하지 않는다. execution-host도 자신의 DB에 단일 writer다. DB 간 원자성 주장은 없고 effect receipt/outbox로 결합한다. 오래된 schema의 바이너리는 write 금지다.

## 6. 검색·조회·성능

role_search_rows와 FTS는 published model에서 재생성 가능한 index다. 반환 전 Role/Boundary/Grant와 join하여 권한을 필터한다. FTS row만으로 조회하지 않는다. 한국어 부분 문자열 fallback은 parameter binding+escape를 사용한다. snapshot cursor는 modelVersion과 visibilityDigest를 포함한다. Task/Delivery 조회는 Run/Member index를 사용하고 무조건 전체 transcript를 읽지 않는다.

## 7. 내구성·backup·GC

WAL+FULL을 선택한다. SQLite 공식 문서에 따른 동기화 설정이며 저장장치/OS failure에서 절대 무손실을 보장한다는 뜻은 아니다. WAL DB를 live 상태에서 main 파일만 복사하지 않는다. SQLite snapshot/backup 절차와 필요한 ContentBlob/Artifact retention manifest를 함께 만든다. 실제 binding의 지원·장애 시험은 VER-02/VER-08에서 수행한다. 근거: https://www.sqlite.org/pragma.html 및 https://www.sqlite.org/wal.html (2026-09-18 조회).

published 모델/구현·활성 또는 unknown execution·미처리 Delivery·수락 output·backup이 pin한 blob은 GC하지 않는다. 정책적 retention 정리는 explicit operation으로 관리한다. DB snapshot의 과거 process identity는 복원 후 unconfirmed이며 즉시 writer로 승인하지 않는다.
