// Account & Billing panel — shows user info, subscription status, and license keys.
// Appears only when signed in.

import { useEffect, useState } from "react";
import { useAuth } from "./auth";
import * as api from "./api";

export function AccountPanel({ C }) {
  const { user, subscription, refresh, signout } = useAuth();
  const [licenseKeys, setLicenseKeys] = useState([]);
  const [newKey, setNewKey] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.listLicenseKeys().then(setLicenseKeys).catch(() => setLicenseKeys([]));
  }, []);

  const subscribe = async (tier) => {
    setBusy(true); setErr(null);
    try {
      const { checkout_url } = await api.createCheckout(tier);
      window.location.href = checkout_url;
    } catch (e) {
      setErr(e.message || "Failed to start checkout.");
    } finally { setBusy(false); }
  };

  const manage = async () => {
    setBusy(true); setErr(null);
    try {
      const { portal_url } = await api.openPortal();
      window.location.href = portal_url;
    } catch (e) {
      setErr(e.message || "Failed to open billing portal.");
    } finally { setBusy(false); }
  };

  const genKey = async () => {
    setBusy(true); setErr(null);
    try {
      const k = await api.generateLicenseKey();
      setNewKey(k.key);
      const keys = await api.listLicenseKeys();
      setLicenseKeys(keys);
    } catch (e) {
      setErr(e.message || "Failed to generate key.");
    } finally { setBusy(false); }
  };

  const Box = ({ children, style }) => (
    <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:10,padding:"18px 20px",marginBottom:14,...style}}>{children}</div>
  );

  const Btn = ({ children, onClick, primary, disabled }) => (
    <button disabled={disabled || busy} onClick={onClick} style={{
      padding:"8px 16px",fontSize:11,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".6px",
      color:primary?C.bg:C.accent,background:primary?C.accent:"transparent",border:`1px solid ${C.accent}`,borderRadius:6,
      cursor:(disabled||busy)?"wait":"pointer",opacity:(disabled||busy)?0.6:1,
    }}>{children}</button>
  );

  const tier = subscription?.tier || "free";
  const active = subscription?.status === "active";
  const expires = subscription?.current_period_end ? new Date(subscription.current_period_end) : null;

  return (
    <div style={{maxWidth:800,margin:"0 auto"}}>
      <h2 style={{fontSize:22,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",margin:"0 0 16px",color:C.txt,letterSpacing:"-.3px"}}>
        Account & Billing
      </h2>

      {err && (
        <div style={{padding:"10px 14px",fontSize:11.5,color:"#ff6b6b",background:"#ff6b6b15",border:"1px solid #ff6b6b40",borderRadius:6,marginBottom:14,fontFamily:"monospace"}}>{err}</div>
      )}

      <Box>
        <div style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace",letterSpacing:"1.5px",textTransform:"uppercase",marginBottom:4}}>Signed in as</div>
        <div style={{fontSize:16,fontWeight:600,color:C.txt}}>{user?.email}</div>
        {user?.full_name && <div style={{fontSize:11,color:C.txtMuted,marginTop:2}}>{user.full_name}</div>}
        <div style={{marginTop:12}}>
          <Btn onClick={signout}>Sign Out</Btn>
        </div>
      </Box>

      <Box>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace",letterSpacing:"1.5px",textTransform:"uppercase"}}>Subscription</div>
          <div style={{padding:"3px 10px",fontSize:10,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".8px",
            color:active?C.accent:C.txtMuted,background:active?`${C.accent}18`:"transparent",border:`1px solid ${active?C.accent:C.border}`,borderRadius:4}}>
            {active ? "ACTIVE" : "INACTIVE"}
          </div>
        </div>
        <div style={{fontSize:18,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",color:tier === "free" ? C.txtMuted : C.accent,marginBottom:4}}>
          {tier === "full" ? "Download + Online — $150/yr"
            : tier === "download" ? "Accurate Download — $100/yr"
            : "Free Tier"}
        </div>
        {expires && <div style={{fontSize:11,color:C.txtMuted,marginBottom:10}}>Renews {expires.toLocaleDateString()}</div>}
        <div style={{fontSize:11.5,color:C.txtDim,marginBottom:14,lineHeight:1.5}}>
          {tier === "free" && "Upgrade to unlock accurate Cantera-backed calculations and the downloadable desktop app."}
          {tier === "download" && "You can download the desktop app. Upgrade to Full for online Cantera API access as well."}
          {tier === "full" && "Full access enabled. Use Accurate Mode in any panel to run exact Cantera chemistry."}
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {tier === "free" && (
            <>
              <Btn primary onClick={() => subscribe("download")}>Subscribe $100/yr (Download)</Btn>
              <Btn primary onClick={() => subscribe("full")}>Subscribe $150/yr (Download + Online)</Btn>
            </>
          )}
          {tier === "download" && (
            <Btn primary onClick={() => subscribe("full")}>Upgrade to Full ($150/yr)</Btn>
          )}
          {active && <Btn onClick={manage}>Manage Billing</Btn>}
        </div>
      </Box>

      {subscription?.has_download_access && (
        <Box>
          <div style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace",letterSpacing:"1.5px",textTransform:"uppercase",marginBottom:10}}>Desktop License Keys</div>
          <div style={{fontSize:11.5,color:C.txtDim,marginBottom:12,lineHeight:1.5}}>
            Paste this key into the desktop app on first launch to activate offline Cantera. Each key supports up to 3 device activations.
          </div>
          {newKey && (
            <div style={{padding:"12px 14px",background:`${C.accent}12`,border:`1px solid ${C.accent}40`,borderRadius:6,marginBottom:12}}>
              <div style={{fontSize:10,color:C.accent,fontFamily:"monospace",letterSpacing:"1px",marginBottom:4}}>NEW KEY — SAVE THIS NOW, IT WON'T BE SHOWN AGAIN</div>
              <div style={{fontSize:15,fontFamily:"monospace",color:C.txt,wordBreak:"break-all"}}>{newKey}</div>
            </div>
          )}
          {licenseKeys.length === 0 ? (
            <div style={{fontSize:11.5,color:C.txtMuted,fontStyle:"italic",marginBottom:12}}>No license keys yet.</div>
          ) : (
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,marginBottom:12}}>
              <thead>
                <tr style={{borderBottom:`1px solid ${C.border}`}}>
                  <th style={{textAlign:"left",padding:"6px 4px",color:C.txtMuted,fontWeight:600,fontFamily:"monospace"}}>KEY</th>
                  <th style={{textAlign:"left",padding:"6px 4px",color:C.txtMuted,fontWeight:600,fontFamily:"monospace"}}>TIER</th>
                  <th style={{textAlign:"left",padding:"6px 4px",color:C.txtMuted,fontWeight:600,fontFamily:"monospace"}}>EXPIRES</th>
                  <th style={{textAlign:"center",padding:"6px 4px",color:C.txtMuted,fontWeight:600,fontFamily:"monospace"}}>DEVICES</th>
                </tr>
              </thead>
              <tbody>
                {licenseKeys.map(k => (
                  <tr key={k.id} style={{borderBottom:`1px solid ${C.border}40`}}>
                    <td style={{padding:"6px 4px",fontFamily:"monospace",color:C.txt}}>{k.key_prefix}-••••-••••-••••-••••-••••</td>
                    <td style={{padding:"6px 4px",color:C.txt}}>{k.tier}</td>
                    <td style={{padding:"6px 4px",color:C.txtDim}}>{new Date(k.expires_at).toLocaleDateString()}</td>
                    <td style={{padding:"6px 4px",textAlign:"center",color:C.txtDim}}>{k.activation_count}/{k.max_activations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Btn onClick={genKey}>Generate New License Key</Btn>
        </Box>
      )}

      {subscription?.has_download_access && (
        <Box>
          <div style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace",letterSpacing:"1.5px",textTransform:"uppercase",marginBottom:10}}>Desktop Download</div>
          <div style={{fontSize:11.5,color:C.txtDim,marginBottom:12,lineHeight:1.5}}>
            Bundles the full Cantera chemistry engine so calculations run locally and offline. Download the installer for your platform:
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <a href="/downloads/CombustionToolkit-mac.dmg" style={{padding:"8px 16px",fontSize:11,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".6px",color:C.accent,background:"transparent",border:`1px solid ${C.accent}`,borderRadius:6,textDecoration:"none"}}>macOS (.dmg)</a>
            <a href="/downloads/CombustionToolkit-win.exe" style={{padding:"8px 16px",fontSize:11,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".6px",color:C.accent,background:"transparent",border:`1px solid ${C.accent}`,borderRadius:6,textDecoration:"none"}}>Windows (.exe)</a>
            <a href="/downloads/CombustionToolkit-linux.AppImage" style={{padding:"8px 16px",fontSize:11,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".6px",color:C.accent,background:"transparent",border:`1px solid ${C.accent}`,borderRadius:6,textDecoration:"none"}}>Linux (.AppImage)</a>
          </div>
          <div style={{fontSize:10,color:C.txtMuted,marginTop:10,fontFamily:"monospace"}}>
            Note: installers are unsigned — first-launch warnings are expected. See docs for bypass instructions.
          </div>
        </Box>
      )}
    </div>
  );
}
