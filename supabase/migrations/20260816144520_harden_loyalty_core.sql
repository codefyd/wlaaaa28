-- Critical security and consistency fixes for the loyalty core.

create or replace function public.add_visit(
  p_customer uuid,
  p_cups integer,
  p_branch uuid default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cafe uuid;
  v_staff uuid;
  v_limit integer;
  v_need integer;
  v_count_mode text;
  v_today_cups integer;
  v_balance integer;
  v_visit uuid;
  v_free_cups integer := 0;
  v_reward_days integer;
  v_earned integer;
begin
  if p_cups is null or p_cups <= 0 or p_cups > 100 then
    raise exception 'INVALID_CUPS';
  end if;

  -- Serialize all balance-changing operations for this customer.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_customer::text, 0)
  );

  select c.cafe_id
    into v_cafe
    from public.customers c
    where c.id = p_customer
    for update;

  if v_cafe is null then raise exception 'CUSTOMER_NOT_FOUND'; end if;
  if not public.is_staff_of(v_cafe) then raise exception 'NOT_AUTHORIZED'; end if;

  select s.id into v_staff
    from public.staff s
    where s.user_id = (select auth.uid())
      and s.cafe_id = v_cafe
      and s.is_active = true
    limit 1;

  select c.cups_per_reward, c.daily_cup_limit, c.reward_valid_days,
         c.count_mode
    into v_need, v_limit, v_reward_days, v_count_mode
    from public.cafes c
    where c.id = v_cafe and c.is_active = true;

  if not found then raise exception 'CAFE_INACTIVE'; end if;
  if v_need is null or v_need <= 0 then raise exception 'INVALID_LOYALTY_CONFIG'; end if;
  if p_branch is not null and not exists (
    select 1 from public.branches b
    where b.id = p_branch and b.cafe_id = v_cafe and b.is_active = true
  ) then
    raise exception 'INVALID_BRANCH';
  end if;

  v_earned := case when v_count_mode = 'per_invoice' then 1 else p_cups end;

  if v_limit is not null then
    select coalesce(sum(l.delta) filter (where l.delta > 0), 0)::integer
      into v_today_cups
      from public.cup_ledger l
      where l.customer_id = p_customer
        and l.created_at >= (
          pg_catalog.date_trunc('day', pg_catalog.now() at time zone 'Asia/Riyadh')
          at time zone 'Asia/Riyadh'
        );
    if v_today_cups + v_earned > v_limit then
      raise exception 'DAILY_LIMIT_EXCEEDED';
    end if;
  end if;

  insert into public.visits(cafe_id, customer_id, branch_id, staff_id, cups, note)
    values (v_cafe, p_customer, p_branch, v_staff, p_cups, left(p_note, 500))
    returning id into v_visit;

  insert into public.cup_ledger(cafe_id, customer_id, visit_id, delta, reason)
    values (v_cafe, p_customer, v_visit, v_earned, 'earn');

  update public.customers set last_visit_at = pg_catalog.now() where id = p_customer;

  select coalesce(sum(l.delta), 0)::integer into v_balance
    from public.cup_ledger l where l.customer_id = p_customer;

  while v_balance >= v_need loop
    insert into public.cup_ledger(cafe_id, customer_id, visit_id, delta, reason)
      values (v_cafe, p_customer, v_visit, -v_need, 'redeem');

    insert into public.rewards(
      cafe_id, customer_id, source, reward_type, label, status, expires_at
    ) values (
      v_cafe, p_customer, 'cup_completion', 'free_cup', 'كوب مجاني', 'available',
      pg_catalog.now() + pg_catalog.make_interval(days => coalesce(v_reward_days, 30))
    );

    v_free_cups := v_free_cups + 1;
    v_balance := v_balance - v_need;
  end loop;

  return jsonb_build_object(
    'visit_id', v_visit,
    'balance', v_balance,
    'cups_per_reward', v_need,
    'credited_cups', v_earned,
    'free_cups_earned', v_free_cups,
    'eligible_roulette', true
  );
end
$function$;

alter table public.customers
  add column if not exists verify_attempts integer not null default 0,
  add column if not exists verify_locked_until timestamptz;

alter table public.customers
  drop constraint if exists customers_verify_attempts_check;
alter table public.customers
  add constraint customers_verify_attempts_check
  check (verify_attempts between 0 and 20);

create or replace function public.spin_roulette(
  p_magic_token uuid,
  p_visit_id uuid,
  p_random double precision
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_customer uuid;
  v_cafe uuid;
  v_prize public.roulette_prizes%rowtype;
  v_spin uuid;
  v_days integer;
  v_wheel jsonb;
begin
  if p_random is null or p_random < 0 or p_random >= 1 then
    raise exception 'INVALID_RANDOM';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_visit_id::text, 0)
  );

  select c.id, c.cafe_id into v_customer, v_cafe
    from public.customers c
    join public.cafes f on f.id = c.cafe_id and f.is_active = true
    where c.magic_token = p_magic_token;
  if not found then raise exception 'INVALID_TOKEN'; end if;

  if not exists (
    select 1 from public.visits v
    where v.id = p_visit_id and v.customer_id = v_customer and v.cafe_id = v_cafe
  ) then raise exception 'VISIT_NOT_FOUND'; end if;

  if exists (select 1 from public.roulette_spins s where s.visit_id = p_visit_id) then
    raise exception 'ALREADY_SPUN';
  end if;

  with weighted as (
    select p.id,
      sum(greatest(p.weight, 0)) over () as total_weight,
      sum(greatest(p.weight, 0)) over (order by p.sort_order, p.id) as running_weight
    from public.roulette_prizes p
    where p.cafe_id = v_cafe and p.is_active = true
  )
  select p.* into v_prize
    from weighted w
    join public.roulette_prizes p on p.id = w.id
    where w.total_weight > 0
      and w.running_weight > p_random * w.total_weight
    order by w.running_weight
    limit 1;

  if not found then raise exception 'NO_PRIZES'; end if;

  insert into public.roulette_spins(
    cafe_id, customer_id, visit_id, prize_id, prize_label
  ) values (
    v_cafe, v_customer, p_visit_id, v_prize.id, v_prize.label
  ) returning id into v_spin;

  if v_prize.prize_type <> 'none' then
    select coalesce(c.reward_valid_days, 30) into v_days
      from public.cafes c where c.id = v_cafe;
    insert into public.rewards(
      cafe_id, customer_id, source, reward_type, reward_value,
      label, status, spin_id, expires_at
    ) values (
      v_cafe, v_customer, 'roulette', v_prize.prize_type, v_prize.prize_value,
      v_prize.label, 'available', v_spin,
      pg_catalog.now() + pg_catalog.make_interval(days => v_days)
    );
  end if;

  select coalesce(
    jsonb_agg(jsonb_build_object('id', p.id, 'label', p.label) order by p.sort_order, p.id),
    '[]'::jsonb
  ) into v_wheel
  from public.roulette_prizes p
  where p.cafe_id = v_cafe and p.is_active = true;

  return jsonb_build_object(
    'prize_id', v_prize.id,
    'prize_label', v_prize.label,
    'prize_type', v_prize.prize_type,
    'wheel', v_wheel
  );
end
$function$;

create or replace function public.replace_roulette_prizes(p_cafe uuid, p_prizes jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer;
begin
  if not public.is_owner_of(p_cafe) then raise exception 'NOT_AUTHORIZED'; end if;
  if jsonb_typeof(p_prizes) <> 'array' or jsonb_array_length(p_prizes) > 50 then
    raise exception 'INVALID_PRIZES';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_prizes) item
    where nullif(btrim(item->>'label'), '') is null
       or (item->>'prize_type') not in ('discount','size_upgrade','free_addon','free_cup','points','none')
       or coalesce((item->>'weight')::numeric, 0) < 0
  ) then raise exception 'INVALID_PRIZES'; end if;

  delete from public.roulette_prizes where cafe_id = p_cafe;
  insert into public.roulette_prizes(
    cafe_id, label, prize_type, prize_value, weight, color, sort_order, is_active
  )
  select p_cafe,
    left(btrim(item->>'label'), 100),
    item->>'prize_type',
    nullif(item->>'prize_value', '')::numeric,
    coalesce((item->>'weight')::numeric, 0),
    case when item->>'color' ~ '^#[0-9A-Fa-f]{6}$' then item->>'color' else '#C8A97E' end,
    ordinality::integer - 1,
    true
  from jsonb_array_elements(p_prizes) with ordinality as entries(item, ordinality);

  get diagnostics v_count = row_count;
  return v_count;
end
$function$;

create or replace function public.redeem_reward(p_reward uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reward public.rewards%rowtype;
  v_staff uuid;
begin
  select * into v_reward
    from public.rewards
    where id = p_reward
    for update;

  if not found then raise exception 'REWARD_NOT_FOUND'; end if;
  if not public.is_staff_of(v_reward.cafe_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if v_reward.status <> 'available' then raise exception 'REWARD_NOT_AVAILABLE'; end if;

  if v_reward.expires_at is not null and v_reward.expires_at < pg_catalog.now() then
    update public.rewards set status = 'expired' where id = p_reward;
    return jsonb_build_object('reward_id', p_reward, 'status', 'expired');
  end if;

  select s.id into v_staff
    from public.staff s
    where s.user_id = (select auth.uid())
      and s.cafe_id = v_reward.cafe_id
      and s.is_active = true
    limit 1;

  update public.rewards
    set status = 'used', used_at = pg_catalog.now(), used_by_staff = v_staff
    where id = p_reward and status = 'available';

  if not found then raise exception 'REWARD_NOT_AVAILABLE'; end if;
  return jsonb_build_object('reward_id', p_reward, 'status', 'used');
end
$function$;

-- Lock down privileged functions. Postgres grants EXECUTE to PUBLIC by default.
revoke execute on function public.add_visit(uuid, integer, uuid, text) from public, anon;
revoke execute on function public.customer_cup_balance(uuid) from public, anon, authenticated;
revoke execute on function public.is_owner_of(uuid) from public, anon;
revoke execute on function public.is_staff_of(uuid) from public, anon;
revoke execute on function public.list_customers(uuid, text, text, text, integer, integer) from public, anon;
revoke execute on function public.redeem_reward(uuid) from public, anon;
revoke execute on function public.report_overview(uuid, timestamptz, timestamptz) from public, anon;
revoke execute on function public.spin_roulette(uuid, uuid, double precision) from public, anon, authenticated;
revoke execute on function public.replace_roulette_prizes(uuid, jsonb) from public, anon;

grant execute on function public.add_visit(uuid, integer, uuid, text) to authenticated, service_role;
grant execute on function public.customer_cup_balance(uuid) to service_role;
grant execute on function public.is_owner_of(uuid) to authenticated, service_role;
grant execute on function public.is_staff_of(uuid) to authenticated, service_role;
grant execute on function public.list_customers(uuid, text, text, text, integer, integer) to authenticated, service_role;
grant execute on function public.redeem_reward(uuid) to authenticated, service_role;
grant execute on function public.report_overview(uuid, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.spin_roulette(uuid, uuid, double precision) to service_role;
grant execute on function public.replace_roulette_prizes(uuid, jsonb) to authenticated, service_role;

alter function public.touch_updated_at() set search_path = 'pg_catalog';
alter function public.time_bucket_ar(timestamptz) set search_path = 'pg_catalog';
alter function public.month_bucket_ar(timestamptz) set search_path = 'pg_catalog';

alter default privileges for role postgres in schema public
  revoke execute on functions from public;

-- Cover the foreign keys flagged by the performance advisor.
create index if not exists cup_ledger_visit_id_idx on public.cup_ledger(visit_id);
create index if not exists rewards_spin_id_idx on public.rewards(spin_id);
create index if not exists rewards_used_by_staff_idx on public.rewards(used_by_staff);
create index if not exists roulette_spins_prize_id_idx on public.roulette_spins(prize_id);
create index if not exists staff_branch_id_idx on public.staff(branch_id);
create index if not exists visits_branch_id_idx on public.visits(branch_id);
create index if not exists visits_staff_id_idx on public.visits(staff_id);

create index if not exists visits_customer_occurred_at_idx
  on public.visits(customer_id, occurred_at desc);
create index if not exists rewards_customer_status_created_idx
  on public.rewards(customer_id, status, created_at desc);
create index if not exists roulette_prizes_active_order_idx
  on public.roulette_prizes(cafe_id, is_active, sort_order);
