import {
  adminClient, isUuid, json, normalizeCustomerCode, preflight, resolveCustomerSession,
} from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return json(req, { error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const { customer_code, magic_token, customer_session, visit_id } = await req.json();
    const publicCode = normalizeCustomerCode(customer_code);
    const legacyToken = isUuid(magic_token) ? magic_token : null;
    if ((!publicCode && !legacyToken) || !isUuid(visit_id)) {
      return json(req, { error: "MISSING_PARAMS" }, 400);
    }

    const admin = adminClient();
    let customerQuery = admin.from("customers")
      .select("id,magic_token,cafe_id,cafes!inner(customer_login_required)");
    customerQuery = publicCode
      ? customerQuery.eq("public_code", publicCode)
      : customerQuery.eq("magic_token", legacyToken!);
    const { data: customer, error: customerError } = await customerQuery.maybeSingle();
    if (customerError) throw customerError;
    if (!customer) return json(req, { error: "INVALID_TOKEN" }, 401);
    const cafe = Array.isArray(customer.cafes) ? customer.cafes[0] : customer.cafes;
    if (cafe?.customer_login_required) {
      const session = await resolveCustomerSession(admin, customer_session);
      if (session?.customerId !== customer.id) {
        return json(req, { error: "LOGIN_REQUIRED" }, 401);
      }
    }
    const resolvedMagicToken = customer.magic_token;

    const random = crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
    const { data, error } = await admin.rpc("spin_roulette", {
      p_magic_token: resolvedMagicToken,
      p_visit_id: visit_id,
      p_random: random,
    });
    if (error) {
      const message = error.message ?? "";
      if (message.includes("INVALID_TOKEN")) return json(req, { error: "INVALID_TOKEN" }, 401);
      if (message.includes("VISIT_NOT_FOUND")) return json(req, { error: "VISIT_NOT_FOUND" }, 404);
      if (message.includes("ALREADY_SPUN")) return json(req, { error: "ALREADY_SPUN" }, 409);
      if (message.includes("NO_PRIZES")) return json(req, { error: "NO_PRIZES" }, 400);
      throw error;
    }
    return json(req, data);
  } catch {
    return json(req, { error: "SERVER_ERROR" }, 500);
  }
});
