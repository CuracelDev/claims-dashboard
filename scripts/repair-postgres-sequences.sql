-- Reset local/Postgres sequences after imports or manual migrations.
-- If a table was restored with explicit IDs, the sequence can lag behind max(id)
-- and cause "duplicate key value violates unique constraint ..._pkey" on insert.

select setval(
  'daily_reports_id_seq'::regclass,
  greatest(coalesce((select max(id) from daily_reports), 1), 1),
  true
)
where to_regclass('daily_reports_id_seq') is not null;

select setval(
  'metric_definitions_id_seq'::regclass,
  greatest(coalesce((select max(id) from metric_definitions), 1), 1),
  true
)
where to_regclass('metric_definitions_id_seq') is not null;
