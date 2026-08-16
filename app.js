// =============================================================
// app.js — أدوات مشتركة لكل الصفحات
// =============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { APP_CONFIG } from "./config.js";

const cfg = APP_CONFIG;
export const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

// استدعاء Edge Function (يمرّر توكن الموظف إن وُجد)
export async function callFn(name, body, withAuth = false) {
  const headers = {
    "Content-Type": "application/json",
    apikey: cfg.SUPABASE_ANON_KEY,
  };
  if (withAuth) {
    const { data } = await sb.auth.getSession();
    if (data?.session) headers["Authorization"] = `Bearer ${data.session.access_token}`;
  } else {
    headers["Authorization"] = `Bearer ${cfg.SUPABASE_ANON_KEY}`;
  }
  const res = await fetch(`${cfg.FUNCTIONS_URL}/${name}`, {
    method: "POST", headers, body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP_${res.status}`);
  return json;
}

// قراءة قيمة من هاش الرابط: #t=xxxx
export function hashParam(key) {
  const h = new URLSearchParams(location.hash.slice(1));
  return h.get(key);
}

// تطبيق ألوان الكافيه على متغيرات CSS
export function applyTheme(cafe) {
  if (!cafe) return;
  const r = document.documentElement.style;
  if (cafe.color_primary)    r.setProperty("--primary", cafe.color_primary);
  if (cafe.color_secondary)  r.setProperty("--secondary", cafe.color_secondary);
  if (cafe.color_background) r.setProperty("--bg", cafe.color_background);
  if (cafe.color_button)     r.setProperty("--btn", cafe.color_button);
}

// تطبيق هوية الكافيه على واجهات الموظف (بدون تغيير الخلفية الفاتحة)
export function applyBrand(cafe) {
  if (!cafe) return;
  const r = document.documentElement.style;
  if (cafe.color_primary)   r.setProperty("--primary", cafe.color_primary);
  if (cafe.color_secondary) r.setProperty("--secondary", cafe.color_secondary);
  if (cafe.color_button)    r.setProperty("--btn", cafe.color_button);
}

export function toast(msg, isError = false) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = "toast show" + (isError ? " err" : "");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = "toast"), 3000);
}
