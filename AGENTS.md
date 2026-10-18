# Vantage Engineering Rules

## Product

Vantage is an evidence-backed competitive intelligence system.

Core loop:

Query
→ Collect
→ Remember
→ Analyze
→ Monitor
→ Detect
→ Notify
→ Query Again

The product is not a dashboard-first analytics tool.

---

## Specification Source of Truth

Start with `docs/README.md` for the reading order and each document's status.

Current runtime architecture:

- docs/architecture/00_整体架构规范.md
- docs/architecture/01_前端架构规范.md
- docs/architecture/02_现行API契约.md
- docs/architecture/03_界面设计规范.md
- docs/operations/01_部署与运行.md

Current frozen baseline:

- docs/spec/00_Engineering_Baseline_v1.2.md
- docs/spec/01_Product_PRD_v1.3.3.md
- docs/spec/02_Data_Algorithm_Spec_v0.3.md
- docs/spec/03_Backend_API_Contract_v0.3.md
- docs/spec/04_Frontend_Interaction_Spec_v0.3.md
- docs/spec/05_Data_Source_Collection_Spec_v0.3.md
- docs/spec/06_QA_Golden_Dataset_Acceptance_Spec_v0.3.md
- docs/spec/07_Monitoring_Operations_Runbook_v0.3.md

Authority order:

00 Engineering Baseline
>
01 Product PRD
>
02–07 Module Specs
>
Engineering Ticket
>
Existing Implementation

If implementation conflicts with specification, do not silently reinterpret the specification.

Create a Spec Change Proposal.

The combined product review is `docs/01_Product_PRD_v1.5.0_review.md`.
It contains product requirements, unresolved decisions, P0 issues, acceptance
scenarios and a review-evidence appendix. It has not replaced the v1.3.3
baseline. Do not silently treat its recommendations or unresolved thresholds
as approved business rules. Approved spec changes apply only to their stated
scope, including SC-01 under `docs/spec/changes/`. SC-03 is a proposal on `main` and remains non-authoritative until explicitly approved.

Runtime architecture and current API documents describe implemented structure
and compatibility. They do not override the business authority order above.
Verify actual behavior from code and tests; report conflicts rather than
approving existing defects through documentation.

## Documentation Governance

- Keep all project specifications under `docs/`; do not recreate a root `spec/`
  directory or add a parallel `agent.md` with competing instructions.
- Use `docs/architecture/` for current runtime architecture and interfaces,
  `docs/spec/` for domain specifications and approved changes,
  `docs/operations/` for runbooks, and `docs/history/` for retrospective records.
- Keep `docs/README.md` as the main ordered index. Filename order is a reading
  aid, not evidence of approval or implementation completion.
- Maintain one primary document per subject. Merge review notes into the
  product review appendix instead of keeping duplicate sources of truth.
- Write product requirements in plain Chinese with user scenarios, observable
  behavior, exceptions and acceptance. Keep code identifiers and implementation
  investigation in technical documents or a clearly marked appendix.
- Preserve the product review's unnumbered headings. Use stable decision,
  issue and acceptance identifiers for traceability instead of chapter numbers.
- When moving or deleting documents, update all affected links, indexes and
  documentation references in code comments. Validate local links and ensure
  referenced files exist before reporting completion.
- Historical documents are not current operating instructions. Do not reuse
  their old deployment examples, migration steps, test results or line numbers
  without checking the current implementation.
- Delete only explicitly requested obsolete documents or redundant documents
  after a verified merge. Preserve useful history in `docs/history/`; never
  delete runtime data, evidence or migration rollback material as doc cleanup.
- Changes to document structure do not authorize production changes, database
  migration, provider replacement, new business states or changed promises.
- Document-only work requires reference, status and consistency checks. Run
  code tests, typecheck or build as appropriate if executable behavior changes;
  never present historical checks as newly executed verification.

---

## Core Intelligence Chain

The canonical intelligence chain is:

SourceSnapshot
→ Evidence
→ Fact
→ Metric
→ DomainEvent
→ Judgment

Where applicable, Fact changes are determined through comparison / Diff before DomainEvent creation.

Evidence must be traceable back to SourceSnapshot and the original source.

---

## Canonical Brand Intelligence

Public brand intelligence should be reusable across workspaces.

Use:

Canonical Brand Intelligence
+
Workspace × Brand Relationship

Do not duplicate the same public brand facts separately for every workspace when they can safely be shared.

Workspace-specific competitive relationships, relevance, monitoring scope and judgments remain workspace scoped.

---

## Data Truth Rules

Never:

- fabricate unsupported facts
- use product price as AOV
- treat fetch failure as no_change
- treat blocked as no_change
- treat partial_scan as full coverage
- treat stale data as fresh
- claim sales weighting without real demand / volume weights
- allow user target price to alter anomaly cleaning
- silently overwrite corrections or retractions

Missing signal is not zero.

---

## Monitoring Rules

Monitoring != Research.

Recurring monitoring must prefer direct known sources.

Resolved identities must be reused.

Do not repeat discovery search when identity is already known unless re-resolution is required.

No meaningful change → no LLM judgment call.

Paid provider escalation, retry and failover must be bounded.

Cost optimization must never silently turn unavailable data into no_change.

---

## Cost Governance

All paid external calls should be attributable where applicable to:

- workspace
- watch target
- capability
- provider
- operation
- trigger
- estimated cost

Direct-source and cached paths should be preferred over repeated paid research.

---

## Development Rules

Before modifying code:

1. Read this file.
2. Read docs/README.md and the applicable current architecture documents.
3. Read 00 and 01 under docs/spec/ and the task-specific upstream specs.
4. Check the combined product review for relevant unresolved decisions; do not treat it as approved policy.
5. Inspect the actual implementation.
6. Identify acceptance criteria.
7. Produce an implementation plan and expected changed files.

Do not assume README descriptions are more authoritative than actual code.

---

## Forbidden Without Explicit Spec / Ticket Authority

Do not:

- invent new business enums
- invent new domain states
- change product promises
- redesign the architecture globally
- delete legacy storage during incremental migration
- introduce new external providers
- change scheduler semantics
- change qualification semantics
- change Evidence / Fact / Event semantics
- directly edit production systems

Prefer additive migration.

---

## Spec Conflicts

When a business-semantic conflict is discovered, report:

- Spec reference
- Current implementation
- Conflict
- Impact
- Proposed options

Do not resolve the product decision silently.

---

## Completion Report

For implementation tasks report:

- Spec References
- Changed Files
- Schema / Migration Changes
- API Changes
- Tests Added
- Test Results
- Acceptance Verification
- Compatibility Verification
- Open Issues

If acceptance criteria are not fully satisfied, report PARTIAL instead of PASS.

## Secret Hygiene（2026-10-07 安全事件后生效，最高纪律）

- `config-seed/` 目录**必须保持零密钥**：只允许空值/占位符模板入库。密钥一律经环境变量或平台安全配置注入，严禁写进 Git、部署包、PR、日志、截图或任何明文产物。
- 历史教训（2026-10-07 审计）：`config-seed/config.json` 曾在初始提交（9bd9b1e）与部署 zip（b2ab988，blob c51969c5）中携带真实 DeepSeek/Serper 密钥进入公开仓库历史，触发全量轮换 + filter-repo 历史重写。
- 提交前跑 `node scripts/secret-scan.js`（零依赖，git 跟踪文件全扫，potentially real 命中即 exit 1）；误报在脚本 WHITELIST_HASH_PREFIXES 登记哈希前缀，禁止放宽正则。
- `.zip` 归档禁止入库（.gitignore 已拦）；`.env`、`*.pem/*.ppk/*.key`、运行时数据库、本地密钥文件继续排除。
