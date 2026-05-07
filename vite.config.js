import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

// Bake the current git short SHA into the bundle as __BUILD_SHA__.
// Used by useBackendCalc's localStorage cache to invalidate persisted
// entries automatically whenever a new build ships. If git is missing
// or the working tree isn't a repo (Render checkout edge cases),
// fall back to the build timestamp — slightly less efficient (cache
// invalidated on every build instead of every commit) but safe.
let buildSha
try {
  buildSha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
} catch {
  buildSha = `t${Date.now()}`
}

export default defineConfig({
  // Relative base so the same build works both on Render (served at /)
  // and inside Electron (loaded via file://). Without this, Vite emits
  // <script src="/assets/...">, which Electron resolves to C:\assets\
  // (filesystem root), causing ERR_FILE_NOT_FOUND and a blank window.
  base: './',
  plugins: [react()],
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha),
  },
})
