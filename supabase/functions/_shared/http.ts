import { createClient } from "jsr:@supabase/supabase-js@2.110.9";

function allowedOrigins() {
  const values = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  values.push("https://codefyd.github.io");
  const clientUrl = Deno.env.get("CLIENT_APP_URL");
  if (clientUrl) {
    try { values.push(new URL(clientUrl).origin); } catch { /* invalid secret */ }
  }
  return new Set(values);
}

export function corsHeaders(req: Request) {
  const origin = req.headers.get("Origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (origin && allowedOrigins().has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export function preflight(req: Request) {
  return new Response("ok", { headers: corsHeaders(req) });
}

export function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function normalizeCustomerCode(value: unknown) {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-HJ-NP-Z2-9]{8}$/.test(code) ? code : null;
}

export function normalizePhone(raw: unknown) {
  let phone = String(raw ?? "").replace(/[^\d+]/g, "");
  if (phone.startsWith("+")) phone = phone.slice(1);
  if (phone.startsWith("00")) phone = phone.slice(2);
  if (phone.startsWith("05")) phone = `966${phone.slice(1)}`;
  if (phone.startsWith("5") && phone.length === 9) phone = `966${phone}`;
  return /^\d{10,15}$/.test(phone) ? phone : null;
}

export async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function resolveCustomerSession(
  admin: ReturnType<typeof adminClient>,
  rawToken: unknown,
) {
  const token = String(rawToken ?? "").trim();
  if (!/^[A-Za-z0-9_-]{40,180}$/.test(token)) return null;
  const tokenHash = await sha256(token);
  const now = new Date().toISOString();
  const { data: session, error } = await admin.from("customer_sessions")
    .select("customer_id,expires_at,last_seen_at")
    .eq("token_hash", tokenHash).is("revoked_at", null)
    .gt("expires_at", now).maybeSingle();
  if (error || !session) return null;

  if (Date.now() - new Date(session.last_seen_at).getTime() > 15 * 60_000) {
    await admin.from("customer_sessions").update({ last_seen_at: now })
      .eq("token_hash", tokenHash);
  }
  return { customerId: session.customer_id as string, tokenHash, expiresAt: session.expires_at as string };
}
