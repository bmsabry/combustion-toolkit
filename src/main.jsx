import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App, { BusyProvider } from './App.jsx'
import { AuthProvider } from './auth.jsx'

// BusyProvider is hoisted OUTSIDE App so the top-level bkCycle
// useBackendCalc (which lives in App's body) finds a real BusyCtx value.
// Nested inside App it would get the no-op default, so cycle-only updates
// would never register with the global "CALCULATIONS IN PROGRESS" overlay.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <BusyProvider>
        <App />
      </BusyProvider>
    </AuthProvider>
  </StrictMode>,
)
