// API client for the combustion-toolkit backend.
// Free users never hit these — the accurate solver is gated to FULL-tier subscribers.

const API_BASE =
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_API_BASE) ||
  (typeof window !== "undefined" && window.__CTK_API_BASE__) ||
  "https://combustion-toolkit-api.onrender.com";

const TOKEN_KEY = "ctk_token";
const REFRESH_KEY = "ctk_refresh";
const USER_KEY = "ctk_user";

// ---- token storage ----
export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function getRefreshToken() {
  try { return localStorage.getItem(REFRESH_KEY); } catch { return null; }
}
export function setTokens(access, refresh) {
  try {
    if (access) localStorage.setItem(TOKEN_KEY, access); else localStorage.removeItem(TOKEN_KEY);
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh); else localStorage.removeItem(REFRESH_KEY);
  } catch {}
}
export function clearTokens() {
  try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(REFRESH_KEY); localStorage.removeItem(USER_KEY); } catch {}
}
export function getCachedUser() {
  try { const s = localStorage.getItem(USER_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}
export function setCachedUser(u) {
  try { if (u) localStorage.setItem(USER_KEY, JSON.stringify(u)); else localStorage.removeItem(USER_KEY); } catch {}
}

// In desktop mode, the preload script exposes window.__CTK_LICENSE_TOKEN__
// (signed offline license). The loopback solver's require_desktop_license
// dependency validates the HMAC on this header before running any /calc/*.
function getDesktopLicenseToken() {
  try {
    return (typeof window !== "undefined" && window.__CTK_LICENSE_TOKEN__) || null;
  } catch {
    return null;
  }
}

// ---- low-level fetch with auto-refresh ----
async function request(path, { method = "GET", body = null, auth = false, retry = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const t = getToken();
    if (t) headers["Authorization"] = `Bearer ${t}`;
    const lt = getDesktopLicenseToken();
    if (lt) headers["X-License-Token"] = lt;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });
  if (res.status === 401 && auth && retry) {
    // try refresh once
    const rt = getRefreshToken();
    if (rt) {
      try {
        const refreshed = await fetch(`${API_BASE}/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: rt }),
        });
        if (refreshed.ok) {
          const data = await refreshed.json();
          setTokens(data.access_token, data.refresh_token);
          return request(path, { method, body, auth, retry: false });
        } else {
          clearTokens();
        }
      } catch { clearTokens(); }
    }
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    // FastAPI returns 422 validation errors as { detail: [{loc, msg, type, ...}, ...] }.
    // Flatten that array into a readable string; otherwise fall back to detail/message
    // / status text. Without this the Error ends up with `[object Object]` message.
    let msg = null;
    const d = data && data.detail;
    if (Array.isArray(d)) {
      msg = d.map(e => {
        const loc = Array.isArray(e.loc) ? e.loc.slice(1).join(".") : "";
        return loc ? `${loc}: ${e.msg}` : (e.msg || String(e));
      }).join("; ");
    } else if (typeof d === "string") {
      msg = d;
    } else if (d) {
      msg = JSON.stringify(d);
    } else if (data && typeof data.message === "string") {
      msg = data.message;
    }
    const err = new Error(msg || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---- auth ----
export async function signup(email, password, full_name) {
  const data = await request("/auth/signup", { method: "POST", body: { email, password, full_name } });
  setTokens(data.access_token, data.refresh_token);
  return data;
}
export async function login(email, password) {
  const data = await request("/auth/login", { method: "POST", body: { email, password } });
  setTokens(data.access_token, data.refresh_token);
  return data;
}
export async function logout() { clearTokens(); }
export async function me() {
  const u = await request("/auth/me", { auth: true });
  setCachedUser(u);
  return u;
}

// ---- subscription ----
export async function getSubscription() {
  return request("/billing/subscription", { auth: true });
}
export async function createCheckout(tier /* 'download' | 'full' */) {
  return request("/billing/checkout", { method: "POST", body: { tier }, auth: true });
}
export async function openPortal() {
  return request("/billing/portal", { auth: true });
}
export async function listLicenseKeys() {
  return request("/billing/license-keys", { auth: true });
}
export async function generateLicenseKey() {
  return request("/billing/license-keys/generate", { method: "POST", auth: true });
}

// ---- calc (requires FULL subscription) ----
export async function calcAFT(payload) {
  return request("/calc/aft", { method: "POST", body: payload, auth: true });
}
export async function calcFlameSpeed(payload) {
  return request("/calc/flame-speed", { method: "POST", body: payload, auth: true });
}
export async function calcFlameSpeedSweep(payload) {
  return request("/calc/flame-speed-sweep", { method: "POST", body: payload, auth: true });
}
export async function calcCombustor(payload) {
  return request("/calc/combustor", { method: "POST", body: payload, auth: true });
}
export async function calcExhaust(payload) {
  return request("/calc/exhaust", { method: "POST", body: payload, auth: true });
}
export async function calcProps(payload) {
  return request("/calc/props", { method: "POST", body: payload, auth: true });
}
export async function calcAutoignition(payload) {
  return request("/calc/autoignition", { method: "POST", body: payload, auth: true });
}
export async function calcCycle(payload) {
  return request("/calc/cycle", { method: "POST", body: payload, auth: true });
}
export async function calcCombustorMapping(payload) {
  return request("/calc/combustor_mapping", { method: "POST", body: payload, auth: true });
}

// ---- health ----
export async function health() {
  return request("/health");
}

export const API = { base: API_BASE };
