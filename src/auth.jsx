// Auth context + login/signup modals.
// Free-tier users never need to sign in — this only unlocks the accurate Cantera solver.

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import * as api from "./api";

const AuthCtx = createContext(null);

// ─────────────────────────────────────────────────────────────────────────
// FRONTEND ADMIN-EMAIL WHITELIST
// Final defense layer for full / unconditional access. If the signed-in
// user's email is on this list, every gated capability (online accurate
// mode, download tier, mode picker without lock) opens up regardless of
// what the backend says about their subscription state.
//
// This fires even if:
//   - the backend's _self_heal_admin failed
//   - GET /billing/subscription returned 5xx (Render restart, cold start)
//   - GET /billing/subscription returned tier="free" (DB drift)
// As long as the user is authenticated (a valid JWT loaded /auth/me), the
// email match alone unlocks everything client-side. Subscription gating
// for non-admin users is unaffected.
//
// Keep this list in lockstep with the backend's ADMIN_EMAILS env var.
// Lowercase only — comparison is case-insensitive.
const FRONTEND_ADMIN_EMAILS = new Set([
  "bmsabry@gmail.com",
]);
function _isAdminEmail(email) {
  return !!(email && FRONTEND_ADMIN_EMAILS.has(String(email).toLowerCase()));
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => api.getCachedUser());
  const [subscription, setSubscription] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    const token = api.getToken();
    if (!token) {
      setUser(null);
      setSubscription(null);
      setLoading(false);
      return;
    }
    try {
      const [u, s] = await Promise.all([api.me(), api.getSubscription().catch(() => null)]);
      setUser(u);
      setSubscription(s);
    } catch (e) {
      if (e.status === 401) {
        api.clearTokens();
        setUser(null);
        setSubscription(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const signin = async (email, password) => {
    setError(null);
    try {
      await api.login(email, password);
      await refresh();
    } catch (e) { setError(e.message || "Login failed"); throw e; }
  };

  const signup = async (email, password, full_name) => {
    setError(null);
    try {
      await api.signup(email, password, full_name);
      await refresh();
    } catch (e) { setError(e.message || "Signup failed"); throw e; }
  };

  const signout = () => {
    api.clearTokens();
    setUser(null);
    setSubscription(null);
  };

  // Admin override: if the signed-in user's email is on the frontend
  // ADMIN whitelist, every gated capability flips on regardless of what
  // the backend reports for their subscription. Backend self-heal is the
  // primary path; this is the belt-and-suspenders client-side guarantee
  // requested for full unconditional access.
  const _adminOverride = _isAdminEmail(user?.email);
  // Desktop mode runs against a bundled local solver. The Electron preload
  // sets window.__CTK_API_BASE__ to the loopback solver URL; if that's
  // present, "online access" is always true (the local solver IS the
  // backend, no cloud login required). Without this, panel calcs that gate
  // on hasOnlineAccess (cycle, AFT, etc.) silently never fire on desktop
  // because the user activated a license but never logged into the cloud.
  const _isDesktop = typeof window !== "undefined" && !!window.__CTK_API_BASE__;
  const _hasOnline = _isDesktop || _adminOverride || !!(subscription && subscription.has_online_access);
  const _hasDownload = _isDesktop || _adminOverride || !!(subscription && subscription.has_download_access);
  // CTK_DEBUG: emit the auth gate decision tree so we can see why
  // hasOnlineAccess turned out true/false. Logs once per provider render.
  if (typeof window !== "undefined") {
    window.__CTK_DEBUG__ = window.__CTK_DEBUG__ || {};
    window.__CTK_DEBUG__.auth = {
      isDesktop: _isDesktop,
      hasWindowApiBase: typeof window !== "undefined" && !!window.__CTK_API_BASE__,
      windowApiBase: typeof window !== "undefined" ? window.__CTK_API_BASE__ : null,
      adminOverride: _adminOverride,
      userEmail: user?.email || null,
      subscriptionHasOnline: !!(subscription && subscription.has_online_access),
      hasOnlineAccess: _hasOnline,
      hasDownloadAccess: _hasDownload,
    };
    // eslint-disable-next-line no-console
    console.log("[CTK_DEBUG] auth =", window.__CTK_DEBUG__.auth);
  }
  const value = {
    user, subscription, loading, error,
    signin, signup, signout, refresh,
    isAuthenticated: !!user,
    isAdminEmail: _adminOverride,
    hasOnlineAccess: _hasOnline,
    hasDownloadAccess: _hasDownload,
  };
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

// ---- modal ----
export function AuthModal({ show, mode = "login", onClose, onModeChange, C }) {
  const { signin, signup, error } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState(null);

  if (!show) return null;

  const submit = async (e) => {
    e.preventDefault();
    setLocalErr(null);
    setBusy(true);
    try {
      if (mode === "login") await signin(email, password);
      else await signup(email, password, fullName || null);
      onClose();
    } catch (err) {
      setLocalErr(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const bg = C?.bg || "#0a0e1a";
  const bg3 = C?.bg3 || "#181d2b";
  const accent = C?.accent || "#00d4ff";
  const accent2 = C?.accent2 || "#ff7b00";
  const border = C?.border || "#232a3a";
  const txt = C?.txt || "#e8eaf0";
  const txtMuted = C?.txtMuted || "#8890a3";

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:16}} onClick={onClose}>
      <form onSubmit={submit} onClick={(e)=>e.stopPropagation()} style={{background:bg3,border:`1px solid ${border}`,borderRadius:12,padding:"28px 28px 22px",width:420,maxWidth:"100%",color:txt,fontFamily:"'Barlow','Segoe UI',sans-serif"}}>
        <div style={{fontSize:22,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"-.3px",marginBottom:4}}>
          <span style={{color:accent}}>{mode === "login" ? "Sign In" : "Create Account"}</span>
        </div>
        <div style={{fontSize:11.5,color:txtMuted,marginBottom:18}}>
          {mode === "login"
            ? "Access your subscription, license keys, and the accurate Cantera solver."
            : "Signup is free. Subscribe later to unlock accurate Cantera calculations and the downloadable desktop app."}
        </div>
        {mode === "signup" && (
          <div style={{marginBottom:12}}>
            <label style={{display:"block",fontSize:10.5,color:txtMuted,fontFamily:"monospace",marginBottom:3}}>Full Name (optional)</label>
            <input value={fullName} onChange={e=>setFullName(e.target.value)} autoComplete="name"
              style={{width:"100%",padding:"9px 11px",fontFamily:"'Barlow',sans-serif",color:txt,fontSize:13,background:bg,border:`1px solid ${border}`,borderRadius:6,outline:"none",boxSizing:"border-box"}}/>
          </div>
        )}
        <div style={{marginBottom:12}}>
          <label style={{display:"block",fontSize:10.5,color:txtMuted,fontFamily:"monospace",marginBottom:3}}>Email</label>
          <input type="email" required value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email"
            style={{width:"100%",padding:"9px 11px",fontFamily:"'Barlow',sans-serif",color:txt,fontSize:13,background:bg,border:`1px solid ${border}`,borderRadius:6,outline:"none",boxSizing:"border-box"}}/>
        </div>
        <div style={{marginBottom:14}}>
          <label style={{display:"block",fontSize:10.5,color:txtMuted,fontFamily:"monospace",marginBottom:3}}>
            Password {mode === "signup" && <span style={{color:txtMuted,fontSize:9}}>(min 8 chars)</span>}
          </label>
          <input type="password" required minLength={mode === "signup" ? 8 : undefined} value={password} onChange={e=>setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"}
            style={{width:"100%",padding:"9px 11px",fontFamily:"'Barlow',sans-serif",color:txt,fontSize:13,background:bg,border:`1px solid ${border}`,borderRadius:6,outline:"none",boxSizing:"border-box"}}/>
        </div>
        {(localErr || error) && (
          <div style={{padding:"8px 10px",fontSize:11,color:"#ff6b6b",background:"#ff6b6b15",border:"1px solid #ff6b6b40",borderRadius:6,marginBottom:12,fontFamily:"monospace"}}>
            {localErr || error}
          </div>
        )}
        <button type="submit" disabled={busy} style={{width:"100%",padding:"10px 14px",fontSize:12,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".7px",color:bg,background:accent,border:"none",borderRadius:6,cursor:busy?"wait":"pointer",opacity:busy?0.6:1}}>
          {busy ? "..." : mode === "login" ? "SIGN IN" : "CREATE ACCOUNT"}
        </button>
        <div style={{textAlign:"center",marginTop:14,fontSize:11,color:txtMuted}}>
          {mode === "login" ? "New here?" : "Already have an account?"}{" "}
          <a href="#" onClick={(e)=>{e.preventDefault();onModeChange(mode === "login" ? "signup" : "login");setLocalErr(null);}} style={{color:accent2,textDecoration:"none",fontWeight:600}}>
            {mode === "login" ? "Create an account" : "Sign in"}
          </a>
        </div>
      </form>
    </div>
  );
}
