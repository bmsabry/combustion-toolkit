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

contextBridge.exposeInMainWorld("ctk", {
  activateLicense: (key) => ipcRenderer.invoke("license:activate", { key }),
  licenseStatus: () => ipcRenderer.invoke("license:status"),
  clearLicense: () => ipcRenderer.invoke("license:clear"),
  submitActivation: (result) => ipcRenderer.send("activation:complete", result),
  skipActivation: () => ipcRenderer.send("activation:skip"),
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
});
