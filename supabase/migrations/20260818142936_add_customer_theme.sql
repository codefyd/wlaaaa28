alter table public.cafes
  add column if not exists customer_theme jsonb not null default '{}'::jsonb;

alter table public.cafes
  drop constraint if exists cafes_customer_theme_object_check;

alter table public.cafes
  add constraint cafes_customer_theme_object_check
  check (jsonb_typeof(customer_theme) = 'object');

comment on column public.cafes.customer_theme is
  'Whitelisted customer-page visual settings. Values are validated again by the public client before use.';
