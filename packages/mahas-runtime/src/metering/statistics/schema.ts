/** Additive schema for registered statistic definitions, observation coverage,
 * and their latest persisted, versioned results. */
export const USAGE_STATISTICS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS metering_coverage_spans (
  id TEXT PRIMARY KEY,
  coverage_id TEXT NOT NULL,
  source_id TEXT,
  dimensions_json TEXT NOT NULL CHECK(json_valid(dimensions_json)),
  start_utc INTEGER NOT NULL,
  end_utc INTEGER NOT NULL CHECK(end_utc > start_utc),
  status TEXT NOT NULL CHECK(status IN ('good','missing')),
  reason TEXT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  observed_at INTEGER NOT NULL,
  FOREIGN KEY(coverage_id) REFERENCES collection_coverage(id) ON DELETE CASCADE,
  FOREIGN KEY(source_id) REFERENCES collection_sources(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS metering_coverage_range_idx
  ON metering_coverage_spans(start_utc,end_utc,status);
CREATE INDEX IF NOT EXISTS metering_coverage_source_idx
  ON metering_coverage_spans(coverage_id,source_id);

CREATE TABLE IF NOT EXISTS metering_statistic_definitions (
  id TEXT PRIMARY KEY,
  definition_revision INTEGER NOT NULL CHECK(definition_revision > 0),
  metric TEXT NOT NULL CHECK(metric IN
    ('weekly-average','daily-average-within-week','hourly-by-date','hour-of-day-distribution','hour-of-day-average')),
  dimensions_json TEXT NOT NULL CHECK(json_valid(dimensions_json)),
  time_zone TEXT NOT NULL,
  week_start INTEGER NOT NULL CHECK(week_start IN (1,7)),
  completed_periods_only INTEGER NOT NULL CHECK(completed_periods_only IN (0,1)),
  window_json TEXT NOT NULL CHECK(json_valid(window_json)),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS metering_usage_statistics (
  id TEXT NOT NULL,
  definition_revision INTEGER NOT NULL,
  result_revision INTEGER NOT NULL CHECK(result_revision > 0),
  metric TEXT NOT NULL,
  dimensions_json TEXT NOT NULL CHECK(json_valid(dimensions_json)),
  range_start INTEGER NOT NULL,
  range_end INTEGER NOT NULL CHECK(range_end > range_start),
  time_zone TEXT NOT NULL,
  calendar_policy_json TEXT NOT NULL CHECK(json_valid(calendar_policy_json)),
  value_json TEXT CHECK(value_json IS NULL OR json_valid(value_json)),
  buckets_json TEXT CHECK(buckets_json IS NULL OR json_valid(buckets_json)),
  numerator_json TEXT NOT NULL CHECK(json_valid(numerator_json)),
  denominator INTEGER,
  expected_periods INTEGER,
  valid_periods INTEGER,
  exclusions_json TEXT NOT NULL CHECK(json_valid(exclusions_json)),
  coverage_json TEXT NOT NULL CHECK(json_valid(coverage_json)),
  source_watermarks_json TEXT NOT NULL CHECK(json_valid(source_watermarks_json)),
  as_of INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY(id, result_revision),
  FOREIGN KEY(id) REFERENCES metering_statistic_definitions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS metering_statistic_latest_idx
  ON metering_usage_statistics(id,result_revision DESC);
`

export function applyUsageStatisticsSchema(db: import('node:sqlite').DatabaseSync): void {
  db.exec(USAGE_STATISTICS_SCHEMA_SQL)
}
