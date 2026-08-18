import { adminClient, isUuid, json, preflight, sha256 } from "../_shared/http.ts";

function normalizePhone(raw: unknown) {
  let phone = String(raw ?? "").replace(/[^\d+]/g, "");
  if (phone.startsWith("+")) phone = phone.slice(1);
  if (phone.startsWith("00")) phone = phone.slice(2);
  if (phone.startsWith("05")) phone = `966${phone.slice(1)}`;
  if (phone.startsWith("5") && phone.length === 9) phone = `966${phone}`;
  return /^\d{10,15}$/.test(phone) ? phone : null;
}

function createCode() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
}

const CUSTOMER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function createCustomerCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => CUSTOMER_CODE_ALPHABET[byte & 31]).join("");
}

function clientLink(req: Request, requestedBase: unknown, publicCode: string) {
  const requestOrigin = req.headers.get("Origin");
  let base = "";
  try {
    const requested = new URL(String(requestedBase ?? ""));
    if (requestOrigin && requested.origin === requestOrigin) {
      requested.hash = "";
      requested.search = "";
      base = requested.toString().replace(/[\/#]+$/, "");
    }
  } catch { /* use configured fallback */ }
  if (!base) base = (Deno.env.get("CLIENT_APP_URL") ?? "").trim().replace(/[\/#]+$/, "");
  return base ? `${base}/#${publicCode}` : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return json(req, { error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const authorization = req.headers.get("Authorization") ?? "";
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return json(req, { error: "UNAUTHENTICATED" }, 401);

    const admin = adminClient();
    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || !userData.user) return json(req, { error: "UNAUTHENTICATED" }, 401);

    const payload = await req.json();
    const cafeId = payload.cafe_id;
    const phone = normalizePhone(payload.phone);
    const fullName = String(payload.full_name ?? "").trim().slice(0, 100) || null;
    if (!isUuid(cafeId) || !phone) return json(req, { error: "INVALID_PARAMS" }, 400);

    const [{ data: staff, error: staffError }, { data: cafe, error: cafeError }] = await Promise.all([
      admin.from("staff").select("id").eq("user_id", userData.user.id)
        .eq("cafe_id", cafeId).eq("is_active", true).maybeSingle(),
      admin.from("cafes").select("name,is_active,require_verification")
        .eq("id", cafeId).maybeSingle(),
    ]);
    if (staffError || cafeError) throw new Error("AUTHORIZATION_LOOKUP_FAILED");
    if (!staff) return json(req, { error: "NOT_AUTHORIZED" }, 403);
    if (!cafe?.is_active) return json(req, { error: "CAFE_INACTIVE" }, 403);

    const customerFields = "id,full_name,verified_at,magic_token,public_code,verify_expires_at";
    let { data: customer, error: lookupError } = await admin.from("customers")
      .select(customerFields)
      .eq("cafe_id", cafeId).eq("phone", phone).maybeSingle();
    if (lookupError) throw lookupError;

    if (payload.search_only) {
      if (!customer) return json(req, { found: false });
      const { data: rewards, error } = await admin.from("rewards").select("id,label")
        .eq("customer_id", customer.id).eq("status", "available")
        .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
      if (error) throw error;
      return json(req, {
        found: true,
        customer_id: customer.id,
        full_name: customer.full_name,
        rewards: rewards ?? [],
      });
    }

    let verificationCode: string | null = null;
    if (!customer) {
      const id = crypto.randomUUID();
      const magicToken = crypto.randomUUID();
      verificationCode = cafe.require_verification ? createCode() : null;
      for (let attempt = 0; attempt < 5 && !customer; attempt++) {
        const { data: created, error } = await admin.from("customers").insert({
          id,
          cafe_id: cafeId,
          phone,
          full_name: fullName,
          magic_token: magicToken,
          public_code: createCustomerCode(),
          verified_at: cafe.require_verification ? null : new Date().toISOString(),
          verify_code: verificationCode ? await sha256(`${magicToken}:${verificationCode}`) : null,
          verify_expires_at: verificationCode ? new Date(Date.now() + 10 * 60_000).toISOString() : null,
          verify_attempts: 0,
          verify_locked_until: null,
        }).select(customerFields).single();

        if (!error) {
          customer = created;
          break;
        }
        if (error.code !== "23505") throw error;

        const retry = await admin.from("customers").select(customerFields)
          .eq("cafe_id", cafeId).eq("phone", phone).maybeSingle();
        if (retry.error) throw retry.error;
        if (retry.data) {
          customer = retry.data;
          verificationCode = null;
        }
      }
    } else {
      const updates: Record<string, unknown> = {};
      if (fullName && !customer.full_name) updates.full_name = fullName;
      if (cafe.require_verification && !customer.verified_at) {
        verificationCode = createCode();
        updates.verify_code = await sha256(`${customer.magic_token}:${verificationCode}`);
        updates.verify_expires_at = new Date(Date.now() + 10 * 60_000).toISOString();
        updates.verify_attempts = 0;
        updates.verify_locked_until = null;
      }
      if (Object.keys(updates).length) {
        const { error } = await admin.from("customers").update(updates).eq("id", customer.id);
        if (error) throw error;
        if (updates.full_name) customer.full_name = fullName;
      }
    }

    if (!customer) throw new Error("CUSTOMER_CREATE_FAILED");
    // إذا أنشأ طلب متزامن العميل قبلنا، أنشئ رمزًا مرتبطًا برمز العميل الحقيقي.
    if (cafe.require_verification && !customer.verified_at && !verificationCode) {
      verificationCode = createCode();
      const { error } = await admin.from("customers").update({
        verify_code: await sha256(`${customer.magic_token}:${verificationCode}`),
        verify_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        verify_attempts: 0,
        verify_locked_until: null,
      }).eq("id", customer.id);
      if (error) throw error;
    }
    const shortLink = clientLink(req, payload.client_base_url, customer.public_code);
    const greeting = customer.full_name ? `أهلًا ${customer.full_name} 👋` : "أهلًا وسهلًا 👋";
    const message = [
      greeting,
      `شكرًا لزيارتك ${cafe.name ?? "الكافيه"} ☕`,
      shortLink ? `هذه بطاقة ولائك لمتابعة أكوابك ومكافآتك:\n${shortLink}` : null,
      verificationCode ? `رمز التحقق: ${verificationCode}\nصالح لمدة 10 دقائق.` : null,
      "نتمنى لك يومًا جميلًا 🤎",
    ].filter(Boolean).join("\n\n");

    return json(req, {
      customer_id: customer.id,
      full_name: customer.full_name,
      verified: !!customer.verified_at,
      customer_code: customer.public_code,
      wa_link: `https://wa.me/${phone}?text=${encodeURIComponent(message)}`,
      client_link: shortLink,
    });
  } catch {
    return json(req, { error: "SERVER_ERROR" }, 500);
  }
});
