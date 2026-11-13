import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/share-tech-mono/400.css'
import './styles/tokens.css'
import './styles/hud.css'
import './styles/orb.css'
import OrbApp from './OrbApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OrbApp />
  </StrictMode>,
)
