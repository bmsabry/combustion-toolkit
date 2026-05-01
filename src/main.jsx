import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App, { BusyProvider } from './App.jsx'
import { AuthProvider } from './auth.jsx'

// ── Top-level ErrorBoundary ─────────────────────────────────────────────
// Without this, any uncaught render-time exception in App (a hooks-order
// violation, an undefined deref, a bad cached response shape) leaves the
// user on a fully black screen with NO indication of what went wrong.
// This boundary catches the throw, shows the error + a recovery button
// that wipes the localStorage cache (the most common silent cause), and
// gives the user a reload that has a real chance of recovering.
class RootBoundary extends Component {
  constructor(props){ super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error){ return { error }; }
  componentDidCatch(error, info){
    // Best-effort log; the user may not have devtools open.
    try { console.error("[RootBoundary]", error, info); } catch {}
  }
  resetAndReload = () => {
    try {
      // Wipe any backend-response cache from prior builds — the most common
      // cause of "black screen after deploy" is a stored response that no
      // longer matches the current schema and throws on parse.
      const stale = [];
      for(let i = 0; i < localStorage.length; i++){
        const k = localStorage.key(i);
        if(k && k.startsWith("ctk_bk_cache_")) stale.push(k);
      }
      stale.forEach(k => { try { localStorage.removeItem(k); } catch {} });
    } catch {}
    location.reload();
  };
  render(){
    if(!this.state.error) return this.props.children;
    const msg = String(this.state.error?.message || this.state.error || "Unknown error");
    const stack = String(this.state.error?.stack || "");
    return (
      <div style={{
        minHeight:'100vh', background:'#0D1117', color:'#c9d1d9',
        fontFamily:'ui-monospace, Menlo, monospace',
        padding:'40px 24px', boxSizing:'border-box'
      }}>
        <h1 style={{color:'#f85149', margin:'0 0 16px', fontSize:22}}>
          Combustion Toolkit — render error
        </h1>
        <p style={{margin:'0 0 16px', maxWidth:720, lineHeight:1.5}}>
          The page failed to render. Most often this is a stale cached response
          left over from a previous deploy. Click below to wipe the cache and
          reload — that fixes it in nearly every case. If the same error
          appears after reload, please share the message below with support.
        </p>
        <button onClick={this.resetAndReload} style={{
          background:'#238636', color:'white', border:'none',
          padding:'10px 18px', borderRadius:6, fontSize:15, cursor:'pointer',
          marginBottom:24
        }}>Reset cache & reload</button>
        <details open style={{
          background:'#161b22', border:'1px solid #30363d', borderRadius:6,
          padding:'12px 16px', maxWidth:'100%', overflow:'auto'
        }}>
          <summary style={{cursor:'pointer', color:'#58a6ff'}}>Error details</summary>
          <pre style={{margin:'12px 0 0', whiteSpace:'pre-wrap', wordBreak:'break-word', color:'#f0883e', fontSize:12}}>{msg}</pre>
          {stack ? <pre style={{margin:'12px 0 0', whiteSpace:'pre-wrap', wordBreak:'break-word', color:'#8b949e', fontSize:11}}>{stack}</pre> : null}
        </details>
      </div>
    );
  }
}

// BusyProvider is hoisted OUTSIDE App so the top-level bkCycle
// useBackendCalc (which lives in App's body) finds a real BusyCtx value.
// Nested inside App it would get the no-op default, so cycle-only updates
// would never register with the global "CALCULATIONS IN PROGRESS" overlay.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RootBoundary>
      <AuthProvider>
        <BusyProvider>
          <App />
        </BusyProvider>
      </AuthProvider>
    </RootBoundary>
  </StrictMode>,
)
