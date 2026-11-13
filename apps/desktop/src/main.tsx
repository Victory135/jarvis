import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/rajdhani/500.css'
import '@fontsource/rajdhani/600.css'
import '@fontsource/rajdhani/700.css'
import '@fontsource/share-tech-mono/400.css'
import './styles/tokens.css'
import './styles/hud.css'
import './styles/screens.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
