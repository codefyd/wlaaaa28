import { APP_CONFIG } from "../config.js";

const tests = [
  ["customer-me", { customer_code: "ABCDEFGH" }, 401],
  ["customer-me", { magic_token: "00000000-0000-4000-8000-000000000000" }, 401],
  ["spin", {
    customer_code: "ABCDEFGH",
    visit_id: "00000000-0000-4000-8000-000000000000",
  }, 401],
  ["verify-code", { customer_code: "ABCDEFGH", code: "000000" }, 401],
  ["customer-upsert", { cafe_id: "bad", phone: "0500000000" }, 401],
];

let failed = false;
const expectedOrigin = "https://codefyd.github.io";
for (const [name] of tests) {
  const preflight = await fetch(`${APP_CONFIG.FUNCTIONS_URL}/${name}`, {
    method: "OPTIONS",
    headers: { Origin: expectedOrigin, "Access-Control-Request-Method": "POST" },
  });
  const corsPassed = preflight.status === 200 &&
    preflight.headers.get("access-control-allow-origin") === expectedOrigin;
  console.log(`${corsPassed ? "PASS" : "FAIL"} CORS ${name}: ${preflight.headers.get("access-control-allow-origin") ?? "DENIED"}`);
  if (!corsPassed) failed = true;
}

for (const [name, body, expected] of tests) {
  const response = await fetch(`${APP_CONFIG.FUNCTIONS_URL}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: APP_CONFIG.SUPABASE_ANON_KEY },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  const safeError = typeof result.error === "string" && !("detail" in result);
  const passed = response.status === expected && safeError;
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${response.status} ${result.error ?? "NO_ERROR"}`);
  if (!passed) failed = true;
}

if (failed) process.exitCode = 1;
