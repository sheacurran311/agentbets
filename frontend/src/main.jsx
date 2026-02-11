import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { WalletProvider } from './WalletProvider.jsx'
import LandingPage from './pages/LandingPage.jsx'
import EmbedWidget from './pages/EmbedWidget.jsx'
import PartnerPage from './pages/PartnerPage.jsx'
import App from './App.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <WalletProvider>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/embed/:marketId" element={<EmbedWidget />} />
          <Route path="/partner" element={<PartnerPage />} />
          <Route path="/app" element={<App />} />
          <Route path="/app/*" element={<App />} />
        </Routes>
      </WalletProvider>
    </BrowserRouter>
  </React.StrictMode>
)
