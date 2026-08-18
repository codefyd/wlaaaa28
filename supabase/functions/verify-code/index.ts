import { adminClient, isUuid, json, normalizeCustomerCode, preflight, sha256 } from "../_shared/http.ts";

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i++) result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return result === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return json(req, { error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const { customer_code, magic_token, code } = await req.json();
    const publicCode = normalizeCustomerCode(customer_code);
    const legacyToken = isUuid(magic_token) ? magic_token : null;
    if ((!publicCode && !legacyToken) || !/^\d{6}$/.test(String(code ?? ""))) {
      return json(req, { error: "INVALID_PARAMS" }, 400);
    }

    const admin = adminClient();
    let customerQuery = admin.from("customers")
      .select("id,magic_token,verified_at,verify_code,verify_expires_at,verify_attempts,verify_locked_until");
    customerQuery = publicCode
      ? customerQuery.eq("public_code", publicCode)
      : customerQuery.eq("magic_token", legacyToken!);
    const { data: customer, error } = await customerQuery.maybeSingle();
    if (error) throw error;
    if (!customer) return json(req, { error: "INVALID_TOKEN" }, 401);
    if (customer.verified_at) return json(req, { verified: true });
    if (customer.verify_locked_until && new Date(customer.verify_locked_until) > new Date()) {
      return json(req, { error: "TOO_MANY_ATTEMPTS" }, 429);
    }
    if (!customer.verify_code || !customer.verify_expires_at ||
        new Date(customer.verify_expires_at) <= new Date()) {
      return json(req, { error: "CODE_EXPIRED" }, 400);
    }

    const supplied = await sha256(`${customer.magic_token}:${String(code)}`);
    if (!safeEqual(customer.verify_code, supplied)) {
      const attempts = (customer.verify_attempts ?? 0) + 1;
      const locked = attempts >= 5;
      const { error: updateError } = await admin.from("customers").update({
        verify_attempts: locked ? 0 : attempts,
        verify_locked_until: locked ? new Date(Date.now() + 15 * 60_000).toISOString() : null,
      }).eq("id", customer.id);
      if (updateError) throw updateError;
      return json(req, { error: locked ? "TOO_MANY_ATTEMPTS" : "WRONG_CODE" }, locked ? 429 : 400);
    }

    const { error: verifyError } = await admin.from("customers").update({
      verified_at: new Date().toISOString(),
      verify_code: null,
      verify_expires_at: null,
      verify_attempts: 0,
      verify_locked_until: null,
    }).eq("id", customer.id);
    if (verifyError) throw verifyError;
    return json(req, { verified: true });
  } catch {
    return json(req, { error: "SERVER_ERROR" }, 500);
  }
});
