select setval(
  'metric_definitions_id_seq'::regclass,
  greatest(coalesce((select max(id) from metric_definitions), 1), 1),
  true
)
where to_regclass('metric_definitions_id_seq') is not null;

update metric_definitions
set category = 'mapping_data'
where lower(trim(category)) in ('mapping & data', 'mapping_data', 'mapping and data', '📦 mapping & data');

update metric_definitions
set category = 'claims_piles'
where lower(trim(category)) in ('claims piles checked', 'claims_piles', 'claims piles', '📊 claims piles checked');

update metric_definitions
set category = 'quality_review'
where lower(trim(category)) in ('quality & review', 'quality_review', 'quality and review', '✅ quality & review');

insert into metric_definitions (
  category,
  label,
  metric_key,
  key,
  data_type,
  display_order,
  is_active,
  applies_to_all,
  applicable_members,
  active
)
select
  'mapping_data',
  'Num of Claims Processed',
  'claims_processed',
  'claims_processed',
  'number',
  15,
  true,
  true,
  '[]'::jsonb,
  true
where not exists (
  select 1
  from metric_definitions
  where metric_key = 'claims_processed'
     or key = 'claims_processed'
);

update metric_definitions
set active = false,
    is_active = false
where (metric_key = 'num_of_claims_processed' or key = 'num_of_claims_processed')
  and exists (
    select 1
    from metric_definitions
    where metric_key = 'claims_processed'
       or key = 'claims_processed'
  );
