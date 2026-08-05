import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

// The boot screen in index.html has been showing since the first frame. React's
// own Splash is laid out to match it, so this fades out over an identical
// picture and only the status line underneath changes.
const boot = document.getElementById('boot')
if (boot) {
  requestAnimationFrame(() => {
    boot.classList.add('gone')
    boot.addEventListener('transitionend', () => boot.remove(), { once: true })
    // A hidden tab never fires transitionend, and a boot screen that outlives
    // the app is worse than an abrupt one.
    window.setTimeout(() => boot.remove(), 600)
  })
}
