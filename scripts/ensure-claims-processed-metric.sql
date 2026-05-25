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
