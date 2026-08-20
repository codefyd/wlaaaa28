alter table public.cafes
  add column if not exists order_public_code text;

create or replace function public.assign_cafe_order_public_code()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_code text;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_index integer;
begin
  if new.order_public_code is null or btrim(new.order_public_code) = '' then
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
        select 1 from public.cafes
        where order_public_code = v_code and id <> new.id
      );
    end loop;
    new.order_public_code := v_code;
  else
    new.order_public_code := upper(btrim(new.order_public_code));
  end if;
  return new;
end
$function$;

revoke execute on function public.assign_cafe_order_public_code() from public, anon, authenticated;
grant execute on function public.assign_cafe_order_public_code() to service_role;

drop trigger if exists cafes_assign_order_public_code on public.cafes;
create trigger cafes_assign_order_public_code
before insert or update of order_public_code on public.cafes
for each row execute function public.assign_cafe_order_public_code();

update public.cafes
set order_public_code = null
where order_public_code is null;

alter table public.cafes
  alter column order_public_code set not null;

alter table public.cafes
  drop constraint if exists cafes_order_public_code_format_check;
alter table public.cafes
  add constraint cafes_order_public_code_format_check
  check (order_public_code ~ '^[A-HJ-NP-Z2-9]{8}$');

create unique index if not exists cafes_order_public_code_key
  on public.cafes(order_public_code);

comment on column public.cafes.order_public_code is
  'Eight-character public code for the permanent store car-ordering QR link.';
