import React, { useMemo } from 'react'
import { ConnectionProvider, WalletProvider as SolanaWalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare'
import { CoinbaseWalletAdapter } from '@solana/wallet-adapter-coinbase'
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom'
// clusterApiUrl not used - we default directly to mainnet RPC

// Import wallet adapter styles
import '@solana/wallet-adapter-react-ui/styles.css'

// Network: use VITE_SOLANA_RPC_URL env var, or default to mainnet
const DEFAULT_RPC_URL = 'https://api.mainnet.solana.com'

export function WalletProvider({ children }) {
  const endpoint = useMemo(
    () => import.meta.env.VITE_SOLANA_RPC_URL || DEFAULT_RPC_URL,
    []
  )

  // Configure supported wallets - Phantom, Solflare, Coinbase
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new CoinbaseWalletAdapter()
    ],
    []
  )

  // Disable WebSocket subscriptions to prevent infinite signatureSubscribe
  // retry loops when the RPC's WebSocket endpoint fails or rate-limits.
  // We use HTTP polling for tx confirmation instead.
  const connectionConfig = useMemo(() => ({
    commitment: 'confirmed',
    wsEndpoint: false, // disable WebSocket entirely
  }), [])

  return (
    <ConnectionProvider endpoint={endpoint} config={connectionConfig}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          {children}
        </WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  )
}

export default WalletProvider
