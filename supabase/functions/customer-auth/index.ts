import {
  adminClient,
  json,
  normalizeCustomerCode,
  normalizePhone,
  preflight,
  randomToken,
  resolveCustomerSession,
  sha256,
} from "../_shared/http.ts";

function otpCode() {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(value).padStart(6, "0");
}

function maskedPhone(phone: string) {
  return `${phone.slice(0, 3)}•••••${phone.slice(-4)}`;
}

const PUBLIC_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function createPublicCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => PUBLIC_CODE_ALPHABET[byte & 31]).join("");
}

async function sendWhatsAppOtp(phone: string, code: string) {
  const token = Deno.env.get("META_WHATSAPP_TOKEN")?.trim();
  const phoneNumberId = Deno.env.get("META_PHONE_NUMBER_ID")?.trim();
  if (!token || !phoneNumberId) throw new Error("WHATSAPP_NOT_CONFIGURED");

  const graphVersion = Deno.env.get("META_GRAPH_VERSION")?.trim() || "v25.0";
  const templateName = Deno.env.get("META_TEMPLATE_NAME")?.trim() ||
    "alhsan_job_application_confirm";
  const language = Deno.env.get("META_TEMPLATE_LANGUAGE")?.trim() || "ar";
  const response = await fetch(
    `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: phone,
        type: "template",
        template: {
          name: templateName,
          language: { code: language },
          components: [{
            type: "body",
            parameters: [{ type: "text", text: code }],
          }],
        },
      }),
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    console.error("WhatsApp Cloud API rejected OTP", response.status, detail);
    throw new Error("WHATSAPP_SEND_FAILED");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return json(req, { error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const payload = await req.json();
    const action = String(payload.action ?? "");
    const admin = adminClient();

    if (action === "request") {
      const customerCode = normalizeCustomerCode(payload.customer_code);
      const cafeCode = normalizeCustomerCode(payload.cafe_code);
      let customer: Record<string, any> | null = null;
      let cafe: Record<string, any> | null = null;
      let phone: string | null = null;

      if (cafeCode) {
        phone = normalizePhone(payload.phone);
        if (!phone) return json(req, { error: "INVALID_PHONE" }, 400);
        const { data: publicCafe, error: cafeError } = await admin.from("cafes")
          .select("id,is_active,customer_login_required,car_ordering_enabled")
          .eq("order_public_code", cafeCode).maybeSingle();
        if (cafeError) throw cafeError;
        cafe = publicCafe;
        if (!cafe?.is_active || !cafe?.car_ordering_enabled) {
          return json(req, { error: "CAFE_NOT_FOUND" }, 404);
        }

        const lookup = await admin.from("customers").select("id,phone,cafe_id,public_code")
          .eq("cafe_id", cafe.id).eq("phone", phone).maybeSingle();
        if (lookup.error) throw lookup.error;
        customer = lookup.data;
        for (let attempt = 0; !customer && attempt < 5; attempt++) {
          const created = await admin.from("customers").insert({
            cafe_id: cafe.id,
            phone,
            public_code: createPublicCode(),
            verified_at: null,
          }).select("id,phone,cafe_id,public_code").single();
          if (!created.error) {
            customer = created.data;
            break;
          }
          if (created.error.code !== "23505") throw created.error;
          const retry = await admin.from("customers").select("id,phone,cafe_id,public_code")
            .eq("cafe_id", cafe.id).eq("phone", phone).maybeSingle();
          if (retry.error) throw retry.error;
          customer = retry.data;
        }
        if (!customer) throw new Error("CUSTOMER_CREATE_FAILED");
      } else {
        if (!customerCode) return json(req, { error: "INVALID_CUSTOMER_CODE" }, 400);
        const lookup = await admin.from("customers")
          .select("id,phone,cafe_id,public_code,cafes!inner(is_active,customer_login_required)")
          .eq("public_code", customerCode).maybeSingle();
        if (lookup.error) throw lookup.error;
        customer = lookup.data;
        cafe = Array.isArray(customer?.cafes) ? customer?.cafes[0] : customer?.cafes;
        phone = normalizePhone(customer?.phone);
      }
      if (!customer || !phone || !cafe?.is_active) {
        return json(req, { error: "CUSTOMER_NOT_FOUND" }, 404);
      }

      const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
      const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
      const [{ data: recent }, { count: hourlyCount, error: countError }] = await Promise.all([
        admin.from("customer_login_challenges").select("requested_at")
          .eq("customer_id", customer.id).gte("requested_at", oneMinuteAgo)
          .order("requested_at", { ascending: false }).limit(1).maybeSingle(),
        admin.from("customer_login_challenges").select("id", { count: "exact", head: true })
          .eq("customer_id", customer.id).gte("requested_at", oneHourAgo),
      ]);
      if (countError) throw countError;
      if (recent) return json(req, { error: "WAIT_BEFORE_RESEND", retry_after: 60 }, 429);
      if ((hourlyCount ?? 0) >= 5) {
        return json(req, { error: "TOO_MANY_REQUESTS", retry_after: 3600 }, 429);
      }

      const code = otpCode();
      const pepper = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const codeHash = await sha256(`${customer.id}:${code}:${pepper}`);
      await admin.from("customer_login_challenges").update({ used_at: new Date().toISOString() })
        .eq("customer_id", customer.id).is("used_at", null);
      const { data: challenge, error: insertError } = await admin
        .from("customer_login_challenges").insert({
          customer_id: customer.id,
          code_hash: codeHash,
          expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        }).select("id").single();
      if (insertError) throw insertError;

      try {
        await sendWhatsAppOtp(phone, code);
      } catch (error) {
        await admin.from("customer_login_challenges").delete().eq("id", challenge.id);
        throw error;
      }
      return json(req, {
        challenge_id: challenge.id,
        masked_phone: maskedPhone(phone),
        expires_in: 300,
      });
    }

    if (action === "verify") {
      const customerCode = normalizeCustomerCode(payload.customer_code);
      const cafeCode = normalizeCustomerCode(payload.cafe_code);
      const challengeId = String(payload.challenge_id ?? "");
      const code = String(payload.code ?? "").trim();
      if ((!customerCode && !cafeCode) || !/^[0-9a-f-]{36}$/i.test(challengeId) || !/^\d{6}$/.test(code)) {
        return json(req, { error: "INVALID_PARAMS" }, 400);
      }
      const { data: challenge, error: challengeError } = await admin
        .from("customer_login_challenges")
        .select("customer_id,customers!inner(public_code,cafe_id,cafes!inner(order_public_code))")
        .eq("id", challengeId).maybeSingle();
      if (challengeError) throw challengeError;
      const linkedCustomer = Array.isArray(challenge?.customers)
        ? challenge?.customers[0] : challenge?.customers;
      const linkedCafe = Array.isArray(linkedCustomer?.cafes)
        ? linkedCustomer?.cafes[0] : linkedCustomer?.cafes;
      const challengeMatches = customerCode
        ? linkedCustomer?.public_code === customerCode
        : linkedCafe?.order_public_code === cafeCode;
      if (!challenge || !challengeMatches) {
        return json(req, { error: "INVALID_CHALLENGE" }, 401);
      }

      const pepper = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const sessionToken = randomToken();
      const sessionHash = await sha256(sessionToken);
      const codeHash = await sha256(`${challenge.customer_id}:${code}:${pepper}`);
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
      const { data, error } = await admin.rpc("verify_customer_login", {
        p_challenge: challengeId,
        p_code_hash: codeHash,
        p_session_hash: sessionHash,
        p_session_expires_at: expiresAt,
      });
      if (error) throw error;
      if (data?.error) {
        const status = data.error === "OTP_LOCKED" ? 429 : 400;
        return json(req, data, status);
      }
      return json(req, {
        customer_session: sessionToken,
        customer_code: linkedCustomer.public_code,
        expires_at: expiresAt,
      });
    }

    if (action === "logout") {
      const session = await resolveCustomerSession(admin, payload.customer_session);
      if (session) {
        await admin.from("customer_sessions").update({ revoked_at: new Date().toISOString() })
          .eq("token_hash", session.tokenHash);
      }
      return json(req, { logged_out: true });
    }

    return json(req, { error: "INVALID_ACTION" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "WHATSAPP_NOT_CONFIGURED") {
      return json(req, { error: message }, 503);
    }
    if (message === "WHATSAPP_SEND_FAILED") {
      return json(req, { error: message }, 502);
    }
    console.error("customer-auth failed", message);
    return json(req, { error: "SERVER_ERROR" }, 500);
  }
});
