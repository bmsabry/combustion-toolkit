// Preload — exposes two things to the renderer:
//  1. window.__CTK_API_BASE__  (read from --ctk-api-base=... launch arg)
//     so src/api.js auto-targets the loopback solver instead of the cloud.
//  2. window.ctk  — license-activation bridge used by activation.html.

const { contextBridge, ipcRenderer } = require("electron");

// Pluck --ctk-api-base=<url> out of additionalArguments.
const arg = process.argv.find((a) => a.startsWith("--ctk-api-base="));
if (arg) {
  const base = arg.slice("--ctk-api-base=".length);
  contextBridge.exposeInMainWorld("__CTK_API_BASE__", base);
}

// Pluck --ctk-license-token=<token>. Renderer attaches this as X-License-Token
// on every /calc/* request so the loopback solver verifies the Ed25519
// signature in addition to the env-var-based startup check.
const tokArg = process.argv.find((a) => a.startsWith("--ctk-license-token="));
if (tokArg) {
  const tok = tokArg.slice("--ctk-license-token=".length);
  contextBridge.exposeInMainWorld("__CTK_LICENSE_TOKEN__", tok);
}

// Verified license claims (already signature-checked in main.js) — expose
// these as `window.__CTK_LICENSE__` so App.jsx's mode picker can lock the
// available modes to what the JWT permits. localStorage tier overrides
// are ignored on the desktop.
const tierArg = process.argv.find((a) => a.startsWith("--ctk-license-tier="));
const featArg = process.argv.find((a) => a.startsWith("--ctk-license-features="));
if (tierArg || featArg) {
  contextBridge.exposeInMainWorld("__CTK_LICENSE__", {
    tier: tierArg ? tierArg.slice("--ctk-license-tier=".length) : null,
    features: featArg
      ? featArg.slice("--ctk-license-features=".length).split(",").filter(Boolean)
      : [],
  });
}

contextBridge.exposeInMainWorld("ctk", {
  activateLicense: (key) => ipcRenderer.invoke("license:activate", { key }),
  licenseStatus: () => ipcRenderer.invoke("license:status"),
  clearLicense: () => ipcRenderer.invoke("license:clear"),
  submitActivation: (result) => ipcRenderer.send("activation:complete", result),
  skipActivation: () => ipcRenderer.send("activation:skip"),
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
});
