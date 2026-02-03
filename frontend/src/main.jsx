import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { WalletProvider } from './WalletProvider.jsx'
import LandingPage from './pages/LandingPage.jsx'
import App from './App.jsx'

// Global buffer polyfill for wallet adapters
import { Buffer } from 'buffer'
window.Buffer = Buffer

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <WalletProvider>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/app" element={<App />} />
          <Route path="/app/*" element={<App />} />
        </Routes>
      </WalletProvider>
    </BrowserRouter>
  </React.StrictMode>
)
