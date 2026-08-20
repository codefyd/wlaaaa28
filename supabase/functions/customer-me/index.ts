import {
  adminClient, isUuid, json, normalizeCustomerCode, preflight, resolveCustomerSession,
} from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return json(req, { error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const { customer_code, magic_token, customer_session } = await req.json();
    const publicCode = normalizeCustomerCode(customer_code);
    const legacyToken = isUuid(magic_token) ? magic_token : null;
    if (!publicCode && !legacyToken) return json(req, { error: "INVALID_TOKEN" }, 401);

    const admin = adminClient();
    let customerQuery = admin.from("customers").select("id,cafe_id,full_name,verified_at");
    customerQuery = publicCode
      ? customerQuery.eq("public_code", publicCode)
      : customerQuery.eq("magic_token", legacyToken!);
    const { data: customer, error: customerError } = await customerQuery.maybeSingle();
    if (customerError) throw customerError;
    if (!customer) return json(req, { error: "INVALID_TOKEN" }, 401);

    const { data: cafe, error: cafeError } = await admin.from("cafes")
      .select("name,logo_url,color_primary,color_secondary,color_background,color_button,theme,background_url,customer_theme,cups_per_reward,require_verification,customer_login_required,car_ordering_enabled,is_active")
      .eq("id", customer.cafe_id).maybeSingle();
    if (cafeError) throw cafeError;
    if (!cafe?.is_active) return json(req, { error: "CAFE_INACTIVE" }, 403);

    const { is_active: _active, ...publicCafe } = cafe;
    const session = await resolveCustomerSession(admin, customer_session);
    const sessionValid = session?.customerId === customer.id;
    if (cafe.customer_login_required && !sessionValid) {
      return json(req, {
        requires_login: true,
        customer: null,
        cafe: publicCafe,
      });
    }
    if (cafe.require_verification && !customer.verified_at) {
      return json(req, {
        requires_verification: true,
        customer: { id: customer.id, full_name: customer.full_name, verified: false },
        cafe: publicCafe,
      });
    }

    const [balanceResult, rewardsResult, visitsResult, prizesResult] = await Promise.all([
      admin.rpc("customer_cup_balance", { p_customer: customer.id }),
      admin.from("rewards")
        .select("id,label,reward_type,reward_value,status,expires_at,created_at")
        .eq("customer_id", customer.id).eq("status", "available")
        .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
        .order("created_at", { ascending: false }),
      admin.from("visits").select("id,cups,occurred_at")
        .eq("customer_id", customer.id).order("occurred_at", { ascending: false }).limit(10),
      admin.from("roulette_prizes").select("id,label,color,sort_order")
        .eq("cafe_id", customer.cafe_id).eq("is_active", true).order("sort_order"),
    ]);
    if (balanceResult.error || rewardsResult.error || visitsResult.error || prizesResult.error) {
      throw new Error("CUSTOMER_DATA_FAILED");
    }

    const visits = visitsResult.data ?? [];
    let pendingSpin: string | null = null;
    if (visits.length) {
      const { data: spins, error } = await admin.from("roulette_spins")
        .select("visit_id").in("visit_id", visits.map((visit) => visit.id));
      if (error) throw error;
      const used = new Set((spins ?? []).map((spin) => spin.visit_id));
      pendingSpin = visits.find((visit) => !used.has(visit.id))?.id ?? null;
    }

    const rewards = rewardsResult.data ?? [];
    let reservedRewardIds = new Set<string>();
    if (rewards.length) {
      const { data: reservations, error } = await admin.from("reward_reservations")
        .select("reward_id").in("reward_id", rewards.map((reward) => reward.id))
        .is("consumed_at", null).is("released_at", null);
      if (error) throw error;
      reservedRewardIds = new Set((reservations ?? []).map((item) => item.reward_id));
    }

    return json(req, {
      requires_login: false,
      requires_verification: false,
      customer: { id: customer.id, full_name: customer.full_name, verified: !!customer.verified_at },
      cafe: publicCafe,
      balance: balanceResult.data ?? 0,
      cups_per_reward: cafe.cups_per_reward ?? 10,
      rewards: rewards.filter((reward) => !reservedRewardIds.has(reward.id)),
      visits,
      roulette_preview: prizesResult.data ?? [],
      pending_spin_visit_id: pendingSpin,
    });
  } catch {
    return json(req, { error: "SERVER_ERROR" }, 500);
  }
});
