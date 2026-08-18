create extension if not exists pgcrypto with schema extensions;

alter table public.customers
  add column if not exists public_code text;

do $migration$
declare
  v_customer record;
  v_code text;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_index integer;
begin
  for v_customer in
    select id from public.customers where public_code is null
  loop
    loop
      v_code := '';
      for v_index in 1..8 loop
        v_code := v_code || substr(
          v_alphabet,
          (get_byte(extensions.gen_random_bytes(1), 0) % 32) + 1,
          1
        );
      end loop;
      exit when not exists (
        select 1 from public.customers where public_code = v_code
      );
    end loop;

    update public.customers
      set public_code = v_code
      where id = v_customer.id;
  end loop;
end
$migration$;

alter table public.customers
  alter column public_code set not null;

alter table public.customers
  drop constraint if exists customers_public_code_format_check;
alter table public.customers
  add constraint customers_public_code_format_check
  check (public_code ~ '^[A-HJ-NP-Z2-9]{8}$');

create unique index if not exists customers_public_code_key
  on public.customers (public_code);

comment on column public.customers.public_code is
  'Eight-character customer-facing code used in short loyalty links. Magic tokens remain for legacy links only.';
