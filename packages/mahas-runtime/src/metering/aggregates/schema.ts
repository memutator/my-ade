import type { DatabaseSync } from 'node:sqlite'

/** Additive, rerunnable schema for persisted usage summaries. */
export const USAGE_AGGREGATES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS metering_aggregate_generations (
  generation INTEGER PRIMARY KEY AUTOINCREMENT,
  state TEXT NOT NULL CHECK(state IN ('building','published','retired')),
  definition_revision INTEGER NOT NULL CHECK(definition_revision > 0),
  ledger_watermark INTEGER NOT NULL DEFAULT 0,
  attribution_watermark INTEGER NOT NULL DEFAULT 0,
  pool_claim_watermark TEXT NOT NULL DEFAULT '',
  pool_claim_cursor TEXT NOT NULL DEFAULT '',
  /* Bucket semantics of this generation. A refresh with another time zone or
     definition revision replaces the generation instead of mixing buckets. */
  time_zone TEXT NOT NULL DEFAULT '',
  week_start INTEGER NOT NULL DEFAULT 1 CHECK(week_start BETWEEN 1 AND 7),
  created_at INTEGER NOT NULL,
  published_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS metering_one_published_generation
  ON metering_aggregate_generations(state) WHERE state='published';

CREATE TABLE IF NOT EXISTS metering_usage_summaries (
  generation INTEGER NOT NULL,
  summary_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  definition_revision INTEGER NOT NULL CHECK(definition_revision > 0),
  dimensions_json TEXT NOT NULL CHECK(json_valid(dimensions_json)),
  grain TEXT NOT NULL CHECK(grain IN ('alltime','hour','day','week')),
  bucket_start_utc INTEGER,
  bucket_end_utc INTEGER,
  time_zone TEXT NOT NULL,
  week_start INTEGER NOT NULL CHECK(week_start BETWEEN 1 AND 7),
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  cache_read_input_tokens INTEGER,
  cache_write_input_tokens INTEGER,
  reasoning_output_tokens INTEGER,
  input_known_count INTEGER NOT NULL DEFAULT 0 CHECK(input_known_count >= 0),
  output_known_count INTEGER NOT NULL DEFAULT 0 CHECK(output_known_count >= 0),
  total_known_count INTEGER NOT NULL DEFAULT 0 CHECK(total_known_count >= 0),
  cache_read_known_count INTEGER NOT NULL DEFAULT 0 CHECK(cache_read_known_count >= 0),
  cache_write_known_count INTEGER NOT NULL DEFAULT 0 CHECK(cache_write_known_count >= 0),
  reasoning_known_count INTEGER NOT NULL DEFAULT 0 CHECK(reasoning_known_count >= 0),
  entry_count INTEGER NOT NULL CHECK(entry_count >= 0),
  unallocated_tokens INTEGER NOT NULL CHECK(unallocated_tokens >= 0),
  unknown_attribution_tokens INTEGER NOT NULL CHECK(unknown_attribution_tokens >= 0),
  /* Counted entries that are unallocated/unattributed with an unknown amount:
     the numeric columns above stay a lower bound and never read as "nothing". */
  unallocated_unknown_entries INTEGER NOT NULL DEFAULT 0 CHECK(unallocated_unknown_entries >= 0),
  unknown_attribution_unknown_entries INTEGER NOT NULL DEFAULT 0 CHECK(unknown_attribution_unknown_entries >= 0),
  coverage_json TEXT NOT NULL CHECK(json_valid(coverage_json)),
  attribution_coverage_json TEXT NOT NULL CHECK(json_valid(attribution_coverage_json)),
  ledger_watermark INTEGER NOT NULL,
  attribution_watermark INTEGER NOT NULL,
  pool_claim_watermark TEXT NOT NULL DEFAULT '',
  computed_at INTEGER NOT NULL,
  PRIMARY KEY(generation, summary_key),
  FOREIGN KEY(generation) REFERENCES metering_aggregate_generations(generation) ON DELETE CASCADE,
  CHECK((grain='alltime' AND bucket_start_utc IS NULL AND bucket_end_utc IS NULL) OR
        (grain<>'alltime' AND bucket_start_utc IS NOT NULL AND bucket_end_utc > bucket_start_utc))
);

CREATE INDEX IF NOT EXISTS metering_summary_query_idx
  ON metering_usage_summaries(generation, grain, bucket_start_utc, bucket_end_utc);

CREATE INDEX IF NOT EXISTS metering_summary_page_idx
  ON metering_usage_summaries(generation, COALESCE(bucket_start_utc,-1), summary_key);

/* One row per source entry and emitted summary. This is the bounded inverse
   index which lets a correction subtract the old projection before adding
   the new one without rereading the ledger. */
CREATE TABLE IF NOT EXISTS metering_aggregate_contributions (
  generation INTEGER NOT NULL,
  entry_id TEXT NOT NULL,
  summary_key TEXT NOT NULL,
  contribution_json TEXT NOT NULL CHECK(json_valid(contribution_json)),
  PRIMARY KEY(generation, entry_id, summary_key),
  FOREIGN KEY(generation, summary_key)
    REFERENCES metering_usage_summaries(generation, summary_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS metering_contribution_entry_idx
  ON metering_aggregate_contributions(generation, entry_id);
`

/** Columns added after the first draft of this schema. `CREATE TABLE IF NOT
 * EXISTS` cannot add them to an existing control DB, so they are applied
 * idempotently here — the fragment stays additive and rerunnable. */
const ADDED_COLUMNS: readonly [table: string, column: string, ddl: string][] = [
  ['metering_aggregate_generations', 'pool_claim_watermark', `pool_claim_watermark TEXT NOT NULL DEFAULT ''`],
  ['metering_aggregate_generations', 'pool_claim_cursor', `pool_claim_cursor TEXT NOT NULL DEFAULT ''`],
  ['metering_aggregate_generations', 'time_zone', `time_zone TEXT NOT NULL DEFAULT ''`],
  ['metering_aggregate_generations', 'week_start', 'week_start INTEGER NOT NULL DEFAULT 1'],
  ['metering_usage_summaries', 'pool_claim_watermark', `pool_claim_watermark TEXT NOT NULL DEFAULT ''`],
  ['metering_usage_summaries', 'unallocated_unknown_entries', 'unallocated_unknown_entries INTEGER NOT NULL DEFAULT 0'],
  ['metering_usage_summaries', 'unknown_attribution_unknown_entries', 'unknown_attribution_unknown_entries INTEGER NOT NULL DEFAULT 0']
]

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
  return rows.some((row) => row.name === column)
}

export function applyUsageAggregatesSchema(db: DatabaseSync): void {
  db.exec(USAGE_AGGREGATES_SCHEMA_SQL)
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
}
