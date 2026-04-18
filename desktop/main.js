// Combustion Toolkit — Electron main process.
//
// Boot sequence:
//   1. Read stored license token from userData/license.json. If none / expired,
//      show activation.html which POSTs to the cloud /desktop/activate endpoint.
//   2. Spawn the bundled PyInstaller solver binary (`solver/ctk-solver`) as a
//      child process with CTK_LICENSE_TOKEN in its env. The solver prints
//      `CTK_PORT=<n>` on its first stdout line.
//   3. Create a BrowserWindow that loads ui/index.html, injecting
//      window.__CTK_API_BASE__ = `http://127.0.0.1:<port>` before React mounts.
//
// `npm run dev` skips step 2/3 — it loads a running `vite` dev server and relies
// on a manually-started solver (CTK_DEV_SOLVER_PORT env var).

const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const CLOUD_API = "https://combustion-toolkit-api.onrender.com";
const LICENSE_FILE = () => path.join(app.getPath("userData"), "license.json");

let solverProc = null;
let solverPort = null;
let mainWin = null;

// ---------- license persistence ----------
function readLicense() {
  try {
    return JSON.parse(fs.readFileSync(LICENSE_FILE(), "utf8"));
  } catch {
    return null;
  }
}

function writeLicense(obj) {
  fs.mkdirSync(path.dirname(LICENSE_FILE()), { recursive: true });
  fs.writeFileSync(LICENSE_FILE(), JSON.stringify(obj, null, 2), "utf8");
}

function licenseIsCurrent(lic) {
  if (!lic || !lic.signed_token || !lic.expires_at) return false;
  try {
    return new Date(lic.expires_at).getTime() > Date.now();
  } catch {
    return false;
  }
}

function machineId() {
  // Stable-enough device id for the "max 3 activations" cap. Combines hostname and userData path.
  const os = require("os");
  const crypto = require("crypto");
  const raw = `${os.hostname()}|${os.userInfo().username}|${app.getPath("userData")}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

// ---------- solver child process ----------
function solverBinaryPath() {
  const exe = process.platform === "win32" ? "ctk-solver.exe" : "ctk-solver";
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "solver", exe);
  }
  // Dev run — expect the built binary in desktop/solver-dist/
  return path.join(__dirname, "solver-dist", exe);
}

function startSolver(licenseToken) {
  return new Promise((resolve, reject) => {
    const bin = solverBinaryPath();
    if (!fs.existsSync(bin)) {
      reject(new Error(`solver binary not found at ${bin}. Run 'npm run build:solver' first.`));
      return;
    }
    const env = {
      ...process.env,
      CTK_LICENSE_TOKEN: licenseToken,
    };
    solverProc = spawn(bin, [], { env, stdio: ["ignore", "pipe", "pipe"] });

    let resolved = false;
    solverProc.stdout.on("data", (buf) => {
      const s = buf.toString();
      process.stdout.write(`[solver] ${s}`);
      if (!resolved) {
        const m = s.match(/CTK_PORT=(\d+)/);
        if (m) {
          solverPort = parseInt(m[1], 10);
          resolved = true;
          resolve(solverPort);
        }
      }
    });
    solverProc.stderr.on("data", (buf) => {
      process.stderr.write(`[solver-err] ${buf.toString()}`);
    });
    solverProc.on("exit", (code) => {
      console.log(`solver exited code=${code}`);
      solverProc = null;
      if (!resolved) reject(new Error(`solver exited before reporting port (code=${code})`));
    });

    // Fail fast if the solver never starts.
    setTimeout(() => {
      if (!resolved) reject(new Error("solver failed to start within 20s"));
    }, 20000);
  });
}

function stopSolver() {
  if (solverProc) {
    try { solverProc.kill(); } catch { /* ignore */ }
    solverProc = null;
  }
}

// ---------- windows ----------
async function showActivationWindow() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 520,
      height: 560,
      resizable: false,
      title: "Activate Combustion Toolkit",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, "activation.html"));

    ipcMain.once("activation:complete", (_e, lic) => {
      writeLicense(lic);
      win.close();
      resolve(lic);
    });
    ipcMain.once("activation:skip", () => {
      win.close();
      resolve(null);
    });
    win.on("closed", () => resolve(readLicense()));
  });
}

async function showMainWindow(licenseToken) {
  const extraArgs = [`--ctk-api-base=http://127.0.0.1:${solverPort}`];
  if (licenseToken) {
    // Renderer attaches this as X-License-Token on every /calc/* request — the
    // loopback solver's require_desktop_license dependency validates the HMAC
    // in addition to the CTK_LICENSE_TOKEN env var the process was started with.
    extraArgs.push(`--ctk-license-token=${licenseToken}`);
  }
  mainWin = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Combustion Toolkit",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: extraArgs,
    },
  });

  const devUrl = process.env.CTK_DEV_UI;
  if (devUrl) {
    await mainWin.loadURL(devUrl);
    mainWin.webContents.openDevTools({ mode: "detach" });
  } else {
    const uiIndex = path.join(app.isPackaged ? process.resourcesPath : __dirname, app.isPackaged ? "app.asar/ui" : "ui", "index.html");
    // Fallback — when bundled, the ui folder is inside the asar: use app:// style loading instead.
    // For dev, __dirname/ui is where build:ui copies it.
    const local = app.isPackaged
      ? path.join(app.getAppPath(), "ui", "index.html")
      : path.join(__dirname, "ui", "index.html");
    if (!fs.existsSync(local) && !fs.existsSync(uiIndex)) {
      dialog.showErrorBox(
        "UI missing",
        `Could not find the bundled UI at ${local}. Run 'npm run build:ui' before launching.`
      );
      app.quit();
      return;
    }
    await mainWin.loadFile(fs.existsSync(local) ? local : uiIndex);
  }

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

// ---------- IPC ----------
ipcMain.handle("license:activate", async (_e, { key }) => {
  const res = await fetch(`${CLOUD_API}/desktop/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: (key || "").trim(), device_id: machineId() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || data.message || `HTTP ${res.status}`);
  }
  // Returned shape: { valid, tier, expires_at, signed_token, message }
  return data;
});

ipcMain.handle("license:status", () => {
  const lic = readLicense();
  if (!lic) return { activated: false };
  return {
    activated: true,
    current: licenseIsCurrent(lic),
    tier: lic.tier,
    expires_at: lic.expires_at,
  };
});

ipcMain.handle("license:clear", () => {
  try { fs.unlinkSync(LICENSE_FILE()); } catch { /* ignore */ }
  return { ok: true };
});

ipcMain.handle("app:open-external", (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) shell.openExternal(url);
});

// ---------- boot ----------
app.whenReady().then(async () => {
  let lic = readLicense();

  if (!licenseIsCurrent(lic)) {
    lic = await showActivationWindow();
  }

  if (!licenseIsCurrent(lic)) {
    // User declined activation — exit. A future "trial" mode could fall back to the
    // client-side approximation here, but that's what the free web version is for.
    dialog.showErrorBox(
      "Activation required",
      "The desktop solver requires a valid subscription. Install the free web version at https://combustion-toolkit.onrender.com/ if you'd like to try without activating.",
    );
    app.quit();
    return;
  }

  try {
    await startSolver(lic.signed_token);
  } catch (e) {
    dialog.showErrorBox("Solver failed to start", String(e.message || e));
    app.quit();
    return;
  }

  await showMainWindow(lic.signed_token);
});

app.on("window-all-closed", () => {
  stopSolver();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", stopSolver);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && solverPort) {
    const lic = readLicense();
    showMainWindow(lic && lic.signed_token);
  }
});
