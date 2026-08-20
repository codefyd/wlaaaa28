-- Move a new car order straight from "pending" to "preparing".
-- The accepted timestamp is still populated so existing preparation analytics remain valid.
create or replace function public.staff_update_car_order(
  p_order uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.orders%rowtype;
  v_staff uuid;
begin
  if (select auth.uid()) is null then raise exception 'UNAUTHENTICATED'; end if;
  select * into v_order from public.orders where id = p_order for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if not public.is_staff_of(v_order.cafe_id) then raise exception 'NOT_AUTHORIZED'; end if;
  select s.id into v_staff from public.staff s
  where s.user_id = (select auth.uid()) and s.cafe_id = v_order.cafe_id and s.is_active = true
  limit 1;

  if not (
    (v_order.status = 'pending' and p_status in ('preparing','accepted','cancelled')) or
    (v_order.status = 'accepted' and p_status in ('preparing','ready','cancelled')) or
    (v_order.status = 'preparing' and p_status in ('ready','cancelled')) or
    (v_order.status = 'ready' and p_status in ('cancelled','no_show'))
  ) then raise exception 'INVALID_STATUS_TRANSITION'; end if;

  update public.orders set
    status = p_status,
    accepted_at = case
      when p_status in ('accepted','preparing') and accepted_at is null then pg_catalog.now()
      else accepted_at
    end,
    preparing_at = case when p_status = 'preparing' then pg_catalog.now() else preparing_at end,
    ready_at = case when p_status = 'ready' then pg_catalog.now() else ready_at end,
    cancelled_at = case when p_status in ('cancelled','no_show') then pg_catalog.now() else cancelled_at end,
    payment_status = case when p_status in ('cancelled','no_show') then 'void' else payment_status end
  where id = p_order;

  if p_status in ('cancelled','no_show') then
    update public.reward_reservations set released_at = pg_catalog.now()
    where order_id = p_order and consumed_at is null and released_at is null;
  end if;
  insert into public.order_status_history(order_id, cafe_id, status, changed_by)
  values (p_order, v_order.cafe_id, p_status, v_staff);
  return jsonb_build_object('order_id', p_order, 'status', p_status);
end
$function$;
