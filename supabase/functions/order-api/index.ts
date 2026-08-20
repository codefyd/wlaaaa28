import {
  adminClient,
  isUuid,
  json,
  normalizeCustomerCode,
  preflight,
  resolveCustomerSession,
} from "../_shared/http.ts";

const ACTIVE_STATUSES = ["pending", "accepted", "preparing", "ready"];

function rpcError(message: string) {
  const known = [
    "INVALID_ITEMS", "INVALID_VEHICLE", "CUSTOMER_NOT_FOUND", "ORDERING_DISABLED",
    "ACTIVE_ORDER_EXISTS", "INVALID_QUANTITY", "PRODUCT_UNAVAILABLE", "INVALID_OPTIONS",
    "MIN_TOTAL_NOT_MET", "REWARD_NOT_AVAILABLE", "REWARD_PRODUCT_REQUIRED",
    "REWARD_RESERVED", "REWARD_PRODUCT_NOT_IN_ORDER", "ORDER_NOT_FOUND",
    "ORDER_NOT_ACTIVE", "ORDER_CANNOT_BE_CANCELLED",
  ].find((code) => message.includes(code));
  return known ?? "ORDER_FAILED";
}

async function orderDetails(admin: ReturnType<typeof adminClient>, customerId: string, orderId?: string) {
  let query = admin.from("orders").select(`
    id,order_number,status,payment_status,subtotal,discount_total,total,
    vehicle_plate,vehicle_color,vehicle_model,parking_spot,note,
    accepted_at,preparing_at,ready_at,arrived_at,completed_at,cancelled_at,created_at,updated_at,
    order_items(id,product_id,product_name,base_unit_price,unit_price,quantity,line_total,reward_applied,
      order_item_options(id,option_name,price_delta))
  `).eq("customer_id", customerId);
  query = orderId ? query.eq("id", orderId) : query.in("status", ACTIVE_STATUSES);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

async function customerContext(
  admin: ReturnType<typeof adminClient>,
  customerCode: string,
  sessionToken: unknown,
  requireSession: boolean,
) {
  const { data: customer, error } = await admin.from("customers")
    .select("id,cafe_id,full_name,public_code").eq("public_code", customerCode).maybeSingle();
  if (error) throw error;
  if (!customer) return { error: "CUSTOMER_NOT_FOUND" } as const;
  const session = await resolveCustomerSession(admin, sessionToken);
  const authenticated = session?.customerId === customer.id;
  if (requireSession && !authenticated) return { error: "LOGIN_REQUIRED" } as const;
  return { customer, authenticated } as const;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return json(req, { error: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const payload = await req.json();
    const action = String(payload.action ?? "bootstrap");
    const customerCode = normalizeCustomerCode(payload.customer_code);
    if (!customerCode) return json(req, { error: "INVALID_CUSTOMER_CODE" }, 400);
    const admin = adminClient();
    const context = await customerContext(
      admin, customerCode, payload.customer_session, action !== "bootstrap",
    );
    if ("error" in context) {
      return json(req, { error: context.error }, context.error === "LOGIN_REQUIRED" ? 401 : 404);
    }

    if (action === "bootstrap") {
      const [{ data: cafe, error: cafeError }, categoriesResult, productsResult, optionsResult] =
        await Promise.all([
          admin.from("cafes").select(
            "id,name,logo_url,color_primary,color_secondary,color_background,color_button,theme,background_url,customer_theme,car_ordering_enabled,customer_login_required,order_min_total,is_active",
          ).eq("id", context.customer.cafe_id).maybeSingle(),
          admin.from("product_categories").select("id,name,sort_order")
            .eq("cafe_id", context.customer.cafe_id).eq("is_active", true).order("sort_order"),
          admin.from("products").select(
            "id,category_id,name,description,image_url,base_price,preparation_minutes,sort_order",
          ).eq("cafe_id", context.customer.cafe_id).eq("is_active", true)
            .eq("is_available", true).order("sort_order"),
          admin.from("product_options").select(
            "id,product_id,group_name,name,price_delta,is_multiple,sort_order",
          ).eq("cafe_id", context.customer.cafe_id).eq("is_active", true).order("sort_order"),
        ]);
      if (cafeError || categoriesResult.error || productsResult.error || optionsResult.error) {
        throw new Error("BOOTSTRAP_FAILED");
      }
      if (!cafe?.is_active) return json(req, { error: "CAFE_INACTIVE" }, 403);
      const { is_active: _active, ...publicCafe } = cafe;
      const response: Record<string, unknown> = {
        cafe: publicCafe,
        categories: categoriesResult.data ?? [],
        products: productsResult.data ?? [],
        options: optionsResult.data ?? [],
        authenticated: context.authenticated,
        requires_login: !context.authenticated,
      };
      if (context.authenticated) {
        const [activeOrder, rewardsResult] = await Promise.all([
          orderDetails(admin, context.customer.id),
          admin.from("rewards").select("id,label,reward_type,reward_value,expires_at,created_at")
            .eq("customer_id", context.customer.id).eq("status", "available")
            .eq("reward_type", "free_cup")
            .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
            .order("created_at", { ascending: false }),
        ]);
        if (rewardsResult.error) throw rewardsResult.error;
        const rewards = rewardsResult.data ?? [];
        let reserved = new Set<string>();
        if (rewards.length) {
          const { data, error } = await admin.from("reward_reservations").select("reward_id")
            .in("reward_id", rewards.map((reward) => reward.id))
            .is("consumed_at", null).is("released_at", null);
          if (error) throw error;
          reserved = new Set((data ?? []).map((row) => row.reward_id));
        }
        response.customer = { id: context.customer.id, full_name: context.customer.full_name };
        response.rewards = rewards.filter((reward) => !reserved.has(reward.id));
        response.active_order = activeOrder;
      }
      return json(req, response);
    }

    if (action === "create") {
      const { data, error } = await admin.rpc("create_car_order", {
        p_customer: context.customer.id,
        p_vehicle_plate: String(payload.vehicle_plate ?? ""),
        p_vehicle_color: String(payload.vehicle_color ?? ""),
        p_vehicle_model: String(payload.vehicle_model ?? ""),
        p_note: String(payload.note ?? ""),
        p_items: payload.items,
        p_reward: isUuid(payload.reward_id) ? payload.reward_id : null,
        p_reward_product: isUuid(payload.reward_product_id) ? payload.reward_product_id : null,
      });
      if (error) return json(req, { error: rpcError(error.message) }, 400);
      return json(req, { order: await orderDetails(admin, context.customer.id, data.order_id) }, 201);
    }

    if (action === "state") {
      if (!isUuid(payload.order_id)) return json(req, { error: "INVALID_ORDER" }, 400);
      const order = await orderDetails(admin, context.customer.id, payload.order_id);
      return order ? json(req, { order }) : json(req, { error: "ORDER_NOT_FOUND" }, 404);
    }

    if (action === "arrive") {
      if (!isUuid(payload.order_id)) return json(req, { error: "INVALID_ORDER" }, 400);
      const { error } = await admin.rpc("customer_mark_order_arrived", {
        p_customer: context.customer.id,
        p_order: payload.order_id,
        p_parking_spot: String(payload.parking_spot ?? ""),
      });
      if (error) return json(req, { error: rpcError(error.message) }, 400);
      return json(req, { order: await orderDetails(admin, context.customer.id, payload.order_id) });
    }

    if (action === "cancel") {
      if (!isUuid(payload.order_id)) return json(req, { error: "INVALID_ORDER" }, 400);
      const { error } = await admin.rpc("customer_cancel_car_order", {
        p_customer: context.customer.id,
        p_order: payload.order_id,
      });
      if (error) return json(req, { error: rpcError(error.message) }, 400);
      return json(req, { order: await orderDetails(admin, context.customer.id, payload.order_id) });
    }

    return json(req, { error: "INVALID_ACTION" }, 400);
  } catch (error) {
    console.error("order-api failed", error instanceof Error ? error.message : "unknown");
    return json(req, { error: "SERVER_ERROR" }, 500);
  }
});
