import React from 'react'
import ReactDOM from 'react-dom/client'
import { WalletProvider } from './WalletProvider.jsx'
import App from './App.jsx'

// Global buffer polyfill for wallet adapters
import { Buffer } from 'buffer'
window.Buffer = Buffer

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <WalletProvider>
      <App />
    </WalletProvider>
  </React.StrictMode>
)
