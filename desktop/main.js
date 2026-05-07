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
const crypto = require("crypto");
const { spawn } = require("child_process");

const CLOUD_API = "https://combustion-toolkit-api.onrender.com";
const LICENSE_FILE = () => path.join(app.getPath("userData"), "license.json");

// Ed25519 public key for verifying signed license tokens. The matching
// PRIVATE key lives only on the Render backend (CTK_ED25519_PRIVATE_KEY_B64
// env var). Extracting this public key from the binary gives an attacker
// no ability to forge licenses — Ed25519 is asymmetric.
//
// If/when the keypair is rotated (e.g. suspected compromise), generate a
// new pair, set the new private key on Render, paste the new public key
// here, and ship a new desktop release. Existing installs will fail
// verification on next launch and require re-activation.
const ED25519_PUBLIC_KEY_B64 = "/sUDVHHr3jNFwzG0TNcTYRkzDwEs5HlzU4mejzau2zI=";

function ed25519PublicKeyObject() {
  // Node's crypto.createPublicKey wants the raw 32-byte Ed25519 key wrapped
  // in a SPKI DER prefix. Easier: use the built-in support for raw keys
  // via createPublicKey({ key, format: 'der', type: 'spki' }). But the
  // simplest portable path is to assemble the SPKI manually:
  //   30 2a 30 05 06 03 2b 65 70 03 21 00 <32 bytes of raw public key>
  const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
  const raw = Buffer.from(ED25519_PUBLIC_KEY_B64, "base64");
  const der = Buffer.concat([SPKI_PREFIX, raw]);
  return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
}

function verifyEd25519(payloadStr, signatureB64) {
  try {
    const pub = ed25519PublicKeyObject();
    const sigBuf = Buffer.from(signatureB64, "base64");
    // Ed25519 verify: passing null as the algorithm name tells Node to use
    // EdDSA which is the only operation Ed25519 keys support.
    return crypto.verify(null, Buffer.from(payloadStr, "utf8"), pub, sigBuf);
  } catch {
    return false;
  }
}

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

// Parse the signed_token "{json}|{signature_b64}" into the inner payload
// object after verifying the Ed25519 signature. Returns null if the
// signature fails or the token is malformed — caller treats this exactly
// like an expired license and shows the activation window.
//
// Anti-piracy property: a thief can't tamper with the payload (e.g. extend
// expires_at, upgrade tier from CTK to EVERYTHING, increase max_activations)
// because any byte change invalidates the Ed25519 signature, and they
// can't re-sign without the private key (which is on the server).
function verifyAndParseToken(signedToken) {
  if (typeof signedToken !== "string") return null;
  const sepIdx = signedToken.lastIndexOf("|");
  if (sepIdx < 0) return null;
  const payloadStr = signedToken.slice(0, sepIdx);
  const signature = signedToken.slice(sepIdx + 1);
  if (!verifyEd25519(payloadStr, signature)) return null;
  try {
    return JSON.parse(payloadStr);
  } catch {
    return null;
  }
}

// Clock-rollback detection. The license file persists the most-recent system
// clock the app has observed. If the user (or a thief who got hold of an
// expired license file) sets the system clock backwards in an attempt to
// keep using an expired license, this catches it: at boot, current clock <
// last_seen_at_ms means the clock was rolled back. Refuse.
//
// Combined with the hard JWT expires_at check, this means an expired
// license can't be revived offline by any clock manipulation we've thought
// of. The only escape is reformatting the OS, which is a high enough bar.
function clockRollbackDetected(lic) {
  if (!lic || typeof lic.last_seen_at_ms !== "number") return false;
  return Date.now() < lic.last_seen_at_ms - 60000; // 60s slack for NTP jitter
}

function licenseIsCurrent(lic) {
  if (!lic || !lic.signed_token || !lic.expires_at) return false;
  // 1. Signature + payload must verify with the baked Ed25519 public key.
  const payload = verifyAndParseToken(lic.signed_token);
  if (!payload) return false;
  // 2. Refuse if the OS clock has been rolled back since the last
  //    successful launch (catches the "set system clock back to 2025" trick).
  if (clockRollbackDetected(lic)) return false;
  // 3. Hard expiry check — works fully offline. After this passes the user
  //    is locked out regardless of internet status.
  try {
    const exp = new Date(payload.expires_at || lic.expires_at).getTime();
    if (!(exp > Date.now())) return false;
  } catch {
    return false;
  }
  return true;
}

// Update the license file's last-seen-at on every successful launch so
// subsequent launches catch clock-rollback attempts.
function touchLicenseLastSeen(lic) {
  if (!lic) return;
  try {
    lic.last_seen_at_ms = Date.now();
    writeLicense(lic);
  } catch {
    /* non-fatal */
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

    // Capture every stdout/stderr line so we can surface a useful error
    // instead of the bare "failed to start within Ns" if the timeout fires.
    let resolved = false;
    let stdoutBuf = "";
    let stderrBuf = "";
    solverProc.stdout.on("data", (buf) => {
      const s = buf.toString();
      stdoutBuf += s;
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
      const s = buf.toString();
      stderrBuf += s;
      process.stderr.write(`[solver-err] ${s}`);
    });
    solverProc.on("exit", (code) => {
      console.log(`solver exited code=${code}`);
      solverProc = null;
      if (!resolved) {
        const tail = (stderrBuf || stdoutBuf).split(/\r?\n/).slice(-12).join("\n");
        reject(new Error(
          `solver exited before reporting port (code=${code}).\n` +
          `Last output:\n${tail || "(no output captured)"}`
        ));
      }
    });

    // Cold-start budget: PyInstaller-bundled Python+Cantera typically
    // boots in 5-15s on a warm system, but the FIRST launch on a fresh
    // machine pays a Windows-Defender cloud-scan tax that can stretch
    // 30-90s while Defender analyzes the unknown 79 MB binary. Subsequent
    // launches drop back to the warm baseline. We give 120s on first run
    // to keep that case from looking like a build failure to the user.
    setTimeout(() => {
      if (!resolved) {
        const tail = (stderrBuf || stdoutBuf).split(/\r?\n/).slice(-12).join("\n");
        reject(new Error(
          `solver failed to start within 120s. This usually means Windows ` +
          `Defender is still scanning ctk-solver.exe (first-run cloud check) ` +
          `or the binary is on a slow / OneDrive-synced drive. Try moving ` +
          `the extracted folder to a local SSD path like C:\\Apps\\ and ` +
          `relaunching.\n\nLast output:\n${tail || "(no output captured)"}`
        ));
      }
    }, 120000);
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
  // CTK_DEBUG: confirm we have a real port before composing the arg.
  // If solverPort is null/undefined, the renderer's __CTK_API_BASE__
  // gets "http://127.0.0.1:null" and every fetch fails silently.
  console.log(`[CTK_DEBUG] showMainWindow: solverPort=${solverPort} licenseToken=${licenseToken ? 'present(len=' + licenseToken.length + ')' : 'NONE'}`);
  const extraArgs = [`--ctk-api-base=http://127.0.0.1:${solverPort}`];
  if (licenseToken) {
    // Renderer attaches this as X-License-Token on every /calc/* request — the
    // loopback solver's require_desktop_license dependency validates the
    // Ed25519 signature in addition to the CTK_LICENSE_TOKEN env var the
    // process was started with.
    extraArgs.push(`--ctk-license-token=${licenseToken}`);
    // Verified-payload claims (tier, features) are injected so App.jsx's
    // mode picker can lock the available modes to whatever the JWT
    // permits. localStorage tier overrides are ignored on the desktop.
    const payload = verifyAndParseToken(licenseToken);
    if (payload) {
      extraArgs.push(`--ctk-license-tier=${payload.tier || ""}`);
      extraArgs.push(
        `--ctk-license-features=${(payload.features || []).join(",")}`
      );
    }
  }
  // CTK_DEBUG: dump the full extraArgs list right before BrowserWindow.
  console.log("[CTK_DEBUG] showMainWindow extraArgs =", JSON.stringify(extraArgs));
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
  // CTK_DEBUG: open DevTools automatically so the user (and future-me)
  // can see the [CTK_DEBUG] logs from preload + renderer immediately.
  // Removed once the boot path stabilizes.
  mainWin.webContents.openDevTools({ mode: "detach" });

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
  // Re-verify the signature on every status call so a tampered license file
  // always reports "not activated" — the renderer can't be tricked into
  // thinking a hand-edited license file is valid by reading lic.tier.
  const payload = verifyAndParseToken(lic.signed_token);
  return {
    activated: true,
    current: licenseIsCurrent(lic),
    tier: payload ? payload.tier : null,
    features: payload ? payload.features : [],
    expires_at: payload ? payload.expires_at : lic.expires_at,
    max_activations: payload ? payload.max_activations : null,
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

  // Distinguish the THREE failure modes for clearer user messaging:
  //   - clock rolled back → "your system clock is wrong" (don't accuse of theft)
  //   - signature invalid → "license file corrupted, re-activate"
  //   - expired           → "your trial/subscription has ended"
  if (lic && clockRollbackDetected(lic)) {
    dialog.showErrorBox(
      "System clock changed",
      "Your computer's clock has been moved backwards since the last time " +
      "Combustion Toolkit ran. Set the clock to the correct date/time and " +
      "restart the app. If you believe this is in error, contact support."
    );
    app.quit();
    return;
  }

  if (!licenseIsCurrent(lic)) {
    lic = await showActivationWindow();
  }

  if (!licenseIsCurrent(lic)) {
    dialog.showErrorBox(
      "Activation required",
      "The desktop application requires a valid license. Sign up at " +
      "https://combustion-toolkit.proreadyengineer.com/ for a 14-day free " +
      "trial, then activate this app with the license key emailed to you."
    );
    app.quit();
    return;
  }

  // Successful launch — stamp the current clock as "last seen" so a future
  // clock-rollback attempt is caught next launch.
  touchLicenseLastSeen(lic);

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
