import React, { useMemo } from 'react'
import { ConnectionProvider, WalletProvider as SolanaWalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { CoinbaseWalletAdapter } from '@solana/wallet-adapter-coinbase'
import { clusterApiUrl } from '@solana/web3.js'

// Import wallet adapter styles
import '@solana/wallet-adapter-react-ui/styles.css'

export function WalletProvider({ children }) {
  // Use devnet for the hackathon
  const endpoint = useMemo(() => clusterApiUrl('devnet'), [])

  // Configure supported wallets
  // Note: Phantom and Solflare are auto-detected via Wallet Standard protocol
  const wallets = useMemo(
    () => [
      new CoinbaseWalletAdapter()
    ],
    []
  )

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          {children}
        </WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  )
}

export default WalletProvider
