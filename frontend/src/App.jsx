import React, { useState, useEffect, useCallback, useMemo, useReducer, memo } from 'react'
import { useWallet, useConnection } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js'

const API_BASE = '/api'
const ESCROW_WALLET = 'Ds9gRNjHufEa918D2HJSbE9AQo8wpqsor9g8rbH6Xwfw'

// USDC Token Mint (devnet)
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'

// Design System - PolyClaw-Inspired Premium Dark Theme
const COLORS = {
  // Primary brand colors (Solana)
  primary: '#14F195',
  primaryDark: '#0a8f5a',
  primaryGlow: 'rgba(20, 241, 149, 0.15)',
  secondary: '#9945FF',
  secondaryDark: '#7a35d4',

  // Accent colors
  accent: '#00D1FF',
  accentPink: '#FF6B9D',

  // Semantic colors
  success: '#14F195',
  error: '#FF4757',
  warning: '#FFBE0B',

  // Backgrounds - deeper, more sophisticated
  bgDark: '#08080F',
  bgCard: '#0D0D16',
  bgCardHover: '#111120',
  bgSidebar: '#0A0A14',
  bgHover: 'rgba(20, 241, 149, 0.06)',
  bgActive: 'rgba(20, 241, 149, 0.10)',
  bgGlass: 'rgba(13, 13, 22, 0.85)',

  // Text - better contrast hierarchy
  textPrimary: '#FFFFFF',
  textSecondary: '#B8B8C8',
  textMuted: '#5A5A6E',
  textAccent: '#14F195',

  // Borders
  border: 'rgba(255, 255, 255, 0.04)',
  borderLight: 'rgba(255, 255, 255, 0.08)',
  borderGlow: 'rgba(20, 241, 149, 0.3)',

  // Gradients
  gradientPrimary: 'linear-gradient(135deg, #14F195 0%, #9945FF 100%)',
  gradientGreen: 'linear-gradient(135deg, #14F195 0%, #00D1FF 100%)',
  gradientRed: 'linear-gradient(135deg, #FF4757 0%, #FF6B9D 100%)',
  gradientPurple: 'linear-gradient(135deg, #9945FF 0%, #FF6B9D 100%)',
  gradientMesh: 'radial-gradient(ellipse at 20% 0%, rgba(20, 241, 149, 0.08) 0%, transparent 50%), radial-gradient(ellipse at 80% 100%, rgba(153, 69, 255, 0.08) 0%, transparent 50%)'
}

// Modern SVG Icons
const Icons = {
  grid: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
    </svg>
  ),
  fire: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2c1 3 3 5 3 9a6 6 0 11-6 0c0-4 2-6 3-9z"/>
    </svg>
  ),
  sparkle: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M5.6 18.4L18.4 5.6"/>
    </svg>
  ),
  clock: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
    </svg>
  ),
  barChart: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="12" width="4" height="9"/><rect x="10" y="8" width="4" height="13"/><rect x="17" y="3" width="4" height="18"/>
    </svg>
  ),
  trophy: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9H4.5a2.5 2.5 0 010-5H6M18 9h1.5a2.5 2.5 0 000-5H18M4 22h16M10 22V9M14 22V9"/>
      <path d="M18 2H6v7a6 6 0 006 6 6 6 0 006-6V2z"/>
    </svg>
  ),
  activity: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22,12 18,12 15,21 9,3 6,12 2,12"/>
    </svg>
  ),
  dollarSign: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
    </svg>
  ),
  target: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>
    </svg>
  ),
  swords: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2"/>
      <path d="M9.5 6.5L21 18v3h-3L6.5 9.5M11 5l-6 6M8 8L4 4M5 3L3 5"/>
    </svg>
  ),
  zap: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13,2 3,14 12,14 11,22 21,10 12,10 13,2"/>
    </svg>
  ),
  crown: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 17l2-11 5 4 3-6 3 6 5-4 2 11H2z"/><path d="M2 17h20v4H2z"/>
    </svg>
  ),
  plus: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  ),
  search: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
    </svg>
  ),
  x: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  ),
  wallet: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12V7H5a2 2 0 010-4h14v4"/><path d="M3 5v14a2 2 0 002 2h16v-5"/><path d="M18 12a2 2 0 100 4 2 2 0 000-4z"/>
    </svg>
  )
}

// Additional icons
const Icons2 = {
  app: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>
    </svg>
  ),
  externalLink: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15,3 21,3 21,9"/><line x1="10" y1="14" x2="21" y2="3"/>
    </svg>
  ),
  info: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
    </svg>
  ),
  check: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20,6 9,17 4,12"/>
    </svg>
  ),
  onchain: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
    </svg>
  ),
  usdc: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
      <path d="M12 6v2m0 8v2M9 12h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      <text x="12" y="16" textAnchor="middle" fill="currentColor" fontSize="8" fontWeight="bold">$</text>
    </svg>
  )
}

// Market categories with modern icons
const CATEGORIES = [
  { id: 'all', label: 'All Markets', icon: Icons.grid },
  { id: 'competition', label: 'Competitions', icon: Icons.trophy },
  { id: 'performance', label: 'Performance', icon: Icons.activity },
  { id: 'token', label: 'Token/Price', icon: Icons.dollarSign },
  { id: 'milestone', label: 'Milestones', icon: Icons.target },
  { id: 'head-to-head', label: 'Head-to-Head', icon: Icons.swords },
  { id: 'app', label: 'Apps/Platforms', icon: Icons2.app },
  { id: 'general', label: 'General', icon: Icons.zap }
]

// Sort options
const SORT_OPTIONS = [
  { id: 'volume', label: 'Popular', icon: Icons.fire },
  { id: 'newest', label: 'New', icon: Icons.sparkle },
  { id: 'ending', label: 'Ending Soon', icon: Icons.clock },
  { id: 'bets', label: 'Most Bets', icon: Icons.barChart }
]

// Global styles injection for scrollbar and wallet button
const GlobalStyles = () => (
  <style>{`
    /* Import Premium Fonts */
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Outfit:wght@300;400;500;600;700;800&display=swap');

    * {
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
    }

    /* Pulse Animation for Live Indicator */
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(1.2); }
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes slideUp {
      from { opacity: 0; transform: translateY(40px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes glow {
      0%, 100% { box-shadow: 0 0 20px rgba(20, 241, 149, 0.3); }
      50% { box-shadow: 0 0 40px rgba(20, 241, 149, 0.5); }
    }

    @keyframes float {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-10px); }
    }

    @keyframes gradientShift {
      0% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }

    /* Background Grid Pattern */
    .bg-grid {
      background-image:
        linear-gradient(rgba(20, 241, 149, 0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(20, 241, 149, 0.03) 1px, transparent 1px);
      background-size: 60px 60px;
    }

    /* Metric Number Style */
    .metric-value {
      font-family: 'JetBrains Mono', monospace;
      font-weight: 600;
      font-size: 32px;
      background: linear-gradient(135deg, #14F195 0%, #00D1FF 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    /* Step Number Style */
    .step-num {
      font-family: 'JetBrains Mono', monospace;
      font-weight: 700;
      font-size: 14px;
      color: ${COLORS.primary};
      opacity: 0.6;
    }

    /* Glassmorphism Card */
    .glass-card {
      background: rgba(13, 13, 22, 0.6);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    /* Custom Scrollbar */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    ::-webkit-scrollbar-track {
      background: ${COLORS.bgDark};
    }
    ::-webkit-scrollbar-thumb {
      background: ${COLORS.secondary}40;
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: ${COLORS.secondary}60;
    }

    /* Wallet Adapter Button Customization */
    .wallet-adapter-button {
      background: ${COLORS.gradientPrimary} !important;
      border-radius: 12px !important;
      font-weight: 600 !important;
      font-size: 14px !important;
      height: 42px !important;
      padding: 0 20px !important;
      transition: all 0.2s ease !important;
    }
    .wallet-adapter-button:hover {
      opacity: 0.9 !important;
      transform: translateY(-1px) !important;
    }
    .wallet-adapter-button-trigger {
      background: ${COLORS.gradientPrimary} !important;
    }
    .wallet-adapter-dropdown-list {
      background: ${COLORS.bgCard} !important;
      border: 1px solid ${COLORS.borderLight} !important;
      border-radius: 12px !important;
    }
    .wallet-adapter-dropdown-list-item {
      background: transparent !important;
      transition: background 0.2s !important;
    }
    .wallet-adapter-dropdown-list-item:hover {
      background: ${COLORS.bgHover} !important;
    }
    .wallet-adapter-modal-wrapper {
      background: ${COLORS.bgCard} !important;
      border: 1px solid ${COLORS.borderLight} !important;
      border-radius: 20px !important;
    }
    .wallet-adapter-modal-title {
      color: ${COLORS.textPrimary} !important;
    }

    /* Focus states */
    input:focus, select:focus, textarea:focus {
      border-color: ${COLORS.primary} !important;
      box-shadow: 0 0 0 2px ${COLORS.primary}20 !important;
    }

    /* Selection */
    ::selection {
      background: ${COLORS.primary}40;
      color: ${COLORS.textPrimary};
    }

    /* Mobile Responsiveness */
    @media (max-width: 1024px) {
      .sidebar {
        position: fixed !important;
        left: -280px !important;
        transition: left 0.3s ease !important;
        z-index: 1000 !important;
      }
      .sidebar.open {
        left: 0 !important;
      }
      .main {
        margin-left: 0 !important;
      }
      .mobile-menu-btn {
        display: flex !important;
      }
      .sidebar-overlay {
        display: block !important;
      }
      .sidebar-overlay.open {
        opacity: 1 !important;
        pointer-events: auto !important;
      }
    }

    .mobile-menu-btn {
      display: none;
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: ${COLORS.bgCard};
      border: 1px solid ${COLORS.border};
      color: ${COLORS.textPrimary};
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }

    .sidebar-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 999;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s ease;
    }

    @media (max-width: 768px) {
      .landing-choice-buttons {
        flex-direction: column !important;
        align-items: center !important;
      }
      .landing-choice-btn {
        width: 100% !important;
        max-width: 280px !important;
      }
      .market-grid {
        grid-template-columns: 1fr !important;
      }
      .stats-bar {
        flex-wrap: wrap !important;
        gap: 8px !important;
      }
      .top-bar {
        flex-direction: column !important;
        gap: 12px !important;
        padding: 12px !important;
      }
      .search-container {
        max-width: 100% !important;
        width: 100% !important;
      }
      .wallet-info {
        width: 100% !important;
        justify-content: center !important;
      }
    }

    @media (max-width: 480px) {
      .landing-title {
        font-size: 28px !important;
      }
      .landing-subtitle {
        font-size: 14px !important;
      }
      .hero-image {
        max-width: 100% !important;
      }
      .market-card {
        padding: 16px !important;
      }
      .bet-buttons {
        flex-direction: column !important;
      }
    }

    /* Hero Stats Bar Mobile */
    @media (max-width: 768px) {
      .markets-hero-bar {
        grid-template-columns: 1fr !important;
        gap: 12px !important;
      }
    }

    /* Template Grid Mobile */
    @media (max-width: 600px) {
      .template-grid {
        grid-template-columns: repeat(2, 1fr) !important;
      }
      .resolution-grid {
        grid-template-columns: 1fr !important;
      }
      .form-row {
        grid-template-columns: 1fr !important;
      }
    }

    /* Card Animation */
    .market-card {
      animation: slideUp 0.4s ease forwards;
    }

    /* Smooth hover effects */
    .market-card:hover {
      box-shadow: 0 8px 32px rgba(20, 241, 149, 0.1);
    }
  `}</style>
)

// Resolution source options for markets
const RESOLUTION_SOURCES = [
  { id: 'manual', label: 'Manual Resolution', description: 'Resolved by platform admins' },
  { id: 'dexscreener', label: 'DexScreener', description: 'Token price/mcap from DexScreener API' },
  { id: 'x-api', label: 'X/Twitter API', description: 'Followers, engagement metrics' },
  { id: 'moltbook', label: 'Moltbook', description: 'Agent karma, stats from Moltbook' },
  { id: 'colosseum', label: 'Colosseum', description: 'Hackathon results from Colosseum' },
  { id: 'github', label: 'GitHub', description: 'Commits, releases, deployments' }
]

function App() {
  const { publicKey, sendTransaction, connected } = useWallet()
  const { connection } = useConnection()

  // Landing page - first-time visitor state
  const [hasOnboarded, setHasOnboarded] = useState(() => {
    return localStorage.getItem('agentbets_onboarded') === 'true'
  })
  const [userType, setUserType] = useState(null) // 'human' or 'agent'

  const [view, setView] = useState('markets')
  const [markets, setMarkets] = useState([])
  const [filteredMarkets, setFilteredMarkets] = useState([])
  const [stats, setStats] = useState(null)
  const [leaderboard, setLeaderboard] = useState([])
  const [selectedMarket, setSelectedMarket] = useState(null)
  const [betAmount, setBetAmount] = useState('')
  const [walletBalance, setWalletBalance] = useState(null)
  const [txStatus, setTxStatus] = useState(null)
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [sortBy, setSortBy] = useState('volume')
  const [searchQuery, setSearchQuery] = useState('')
  const [agentRoyalties, setAgentRoyalties] = useState(null)
  const [blinkUrl, setBlinkUrl] = useState(null)
  const [liveActivity, setLiveActivity] = useState([])
  const [isLive, setIsLive] = useState(true)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  // Enhanced market creation form with useReducer for cleaner state management
  const initialMarketState = {
    question: '',
    description: '',
    category: 'general',
    endDate: '',
    resolutionSource: 'manual',
    verificationUrl: '',
    verificationMethod: '',
    threshold: '',
    tags: '',
    creatorAgent: ''
  }

  const marketReducer = (state, action) => {
    switch (action.type) {
      case 'SET_FIELD': return { ...state, [action.field]: action.value }
      case 'RESET': return initialMarketState
      default: return state
    }
  }

  const [newMarket, dispatchMarket] = useReducer(marketReducer, initialMarketState)

  // Memoized market form field setter
  const setMarketField = useCallback((field, value) => {
    dispatchMarket({ type: 'SET_FIELD', field, value })
  }, [])

  // Memoized card hover handlers for performance
  const handleCardMouseEnter = useCallback((e) => {
    e.currentTarget.style.borderColor = COLORS.primary + '40'
    e.currentTarget.style.transform = 'translateY(-2px)'
  }, [])

  const handleCardMouseLeave = useCallback((e) => {
    e.currentTarget.style.borderColor = COLORS.border
    e.currentTarget.style.transform = 'translateY(0)'
  }, [])

  // Memoized styles for transaction status display
  const txStatusStyle = useMemo(() => {
    if (!txStatus) return null
    return {
      ...styles.txStatus,
      background: txStatus.type === 'pending' ? `${COLORS.warning}15` :
                 txStatus.type === 'success' ? `${COLORS.success}15` : `${COLORS.error}15`,
      borderColor: txStatus.type === 'pending' ? COLORS.warning :
                  txStatus.type === 'success' ? COLORS.success : COLORS.error,
      color: txStatus.type === 'pending' ? COLORS.warning :
             txStatus.type === 'success' ? COLORS.success : COLORS.error
    }
  }, [txStatus?.type])

  // Memoized disabled button style
  const disabledBtnStyle = useMemo(() =>
    txStatus?.type === 'pending' ? { opacity: 0.5, cursor: 'not-allowed' } : {}
  , [txStatus?.type])

  // Complete onboarding
  const completeOnboarding = (type) => {
    setUserType(type)
    setHasOnboarded(true)
    localStorage.setItem('agentbets_onboarded', 'true')
    localStorage.setItem('agentbets_user_type', type)
  }

  // Fetch agent royalties
  const fetchRoyalties = async (handle) => {
    try {
      const res = await fetch(`${API_BASE}/royalties/${handle.replace('@', '')}`)
      const data = await res.json()
      setAgentRoyalties(data)
    } catch (err) {
      console.error('Failed to fetch royalties:', err)
    }
  }

  // Get Blink URL for a market
  const fetchBlinkUrl = async (marketId) => {
    try {
      const res = await fetch(`${API_BASE}/blink/${marketId}`)
      const data = await res.json()
      setBlinkUrl(data)
    } catch (err) {
      console.error('Failed to fetch blink URL:', err)
    }
  }

  // Fetch wallet balance
  const fetchBalance = useCallback(async () => {
    if (publicKey && connection) {
      try {
        const balance = await connection.getBalance(publicKey)
        setWalletBalance(balance / LAMPORTS_PER_SOL)
      } catch (err) {
        console.error('Failed to fetch balance:', err)
      }
    }
  }, [publicKey, connection])

  useEffect(() => {
    fetchMarkets()
    fetchStats()
    fetchLeaderboard()
    fetchRecentActivity()
  }, [])

  // Real-time polling for live updates
  useEffect(() => {
    if (!isLive) return
    const pollInterval = setInterval(() => {
      fetchMarkets()
      fetchStats()
      fetchRecentActivity()
    }, 60000) // Poll every 60 seconds
    return () => clearInterval(pollInterval)
  }, [isLive])

  // Fetch recent activity for live feed
  const fetchRecentActivity = async () => {
    try {
      const res = await fetch(`${API_BASE}/activity`)
      if (res.ok) {
        const data = await res.json()
        setLiveActivity(data.activities || [])
      }
    } catch (err) {
      // Generate mock activity if endpoint doesn't exist
      const mockActivities = [
        { type: 'bet', user: '7xK...4Dm', market: 'Will $AIXBT reach $2B?', side: 'YES', amount: 0.5, time: Date.now() - 30000 },
        { type: 'bet', user: '3Fg...9Jk', market: 'Will @truth_terminal post today?', side: 'NO', amount: 0.25, time: Date.now() - 120000 },
        { type: 'market', user: '@AIButters', market: 'New market created', time: Date.now() - 300000 }
      ]
      setLiveActivity(mockActivities)
    }
  }

  useEffect(() => {
    if (connected) {
      fetchBalance()
      const interval = setInterval(fetchBalance, 30000)
      return () => clearInterval(interval)
    } else {
      setWalletBalance(null)
    }
  }, [connected, fetchBalance])

  // Filter and sort markets
  useEffect(() => {
    let result = [...markets]

    if (selectedCategory !== 'all') {
      result = result.filter(m => m.category === selectedCategory)
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      result = result.filter(m =>
        m.question.toLowerCase().includes(query) ||
        m.description?.toLowerCase().includes(query)
      )
    }

    switch (sortBy) {
      case 'volume':
        result.sort((a, b) => b.totalVolume - a.totalVolume)
        break
      case 'newest':
        result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        break
      case 'ending':
        result.sort((a, b) => new Date(a.endDate) - new Date(b.endDate))
        break
      case 'bets':
        result.sort((a, b) => b.totalBets - a.totalBets)
        break
    }

    setFilteredMarkets(result)
  }, [markets, selectedCategory, sortBy, searchQuery])

  const fetchMarkets = async () => {
    try {
      const res = await fetch(`${API_BASE}/markets`)
      const data = await res.json()
      setMarkets(data.markets || [])
    } catch (err) {
      console.error('Failed to fetch markets:', err)
    }
  }

  const fetchStats = async () => {
    try {
      const res = await fetch(`${API_BASE}/stats`)
      const data = await res.json()
      setStats(data)
    } catch (err) {
      console.error('Failed to fetch stats:', err)
    }
  }

  const fetchLeaderboard = async () => {
    try {
      const res = await fetch(`${API_BASE}/leaderboard`)
      const data = await res.json()
      setLeaderboard(data.leaderboard || [])
    } catch (err) {
      console.error('Failed to fetch leaderboard:', err)
    }
  }

  const placeBet = async (outcome) => {
    if (!betAmount || parseFloat(betAmount) <= 0) {
      alert('Please enter a valid bet amount')
      return
    }

    if (!connected || !publicKey) {
      alert('Please connect your wallet first')
      return
    }

    const amount = parseFloat(betAmount)
    const isOnChain = selectedMarket.onChain || selectedMarket.currency === 'USDC'

    // For SOL bets, check wallet balance
    if (!isOnChain && walletBalance !== null && amount > walletBalance) {
      alert(`Insufficient balance. You have ${walletBalance.toFixed(4)} SOL`)
      return
    }

    setTxStatus({ type: 'pending', message: 'Creating transaction...' })

    try {
      if (isOnChain) {
        // On-chain USDC bet via Poll.fun
        setTxStatus({ type: 'pending', message: 'Creating on-chain wager...' })

        // Get wager transaction from API
        const wagerRes = await fetch(`${API_BASE}/onchain/wager`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            marketId: selectedMarket.id,
            betPda: selectedMarket.betPda,
            outcome,
            amount,
            wallet: publicKey.toString()
          })
        })

        const wagerData = await wagerRes.json()

        if (!wagerData.success) {
          throw new Error(wagerData.error || 'Failed to create wager transaction')
        }

        setTxStatus({ type: 'pending', message: 'Please approve USDC transfer in wallet...' })

        // Deserialize and send transaction
        const txBuffer = Buffer.from(wagerData.transaction.serialized, 'base64')
        const transaction = Transaction.from(txBuffer)

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
        transaction.recentBlockhash = blockhash
        transaction.feePayer = publicKey

        const signature = await sendTransaction(transaction, connection)

        setTxStatus({ type: 'pending', message: 'Confirming on-chain wager...' })

        await connection.confirmTransaction({
          signature,
          blockhash,
          lastValidBlockHeight
        })

        setTxStatus({ type: 'success', message: `On-chain bet placed! ${signature.slice(0, 8)}...` })

        setTimeout(() => {
          setSelectedMarket(null)
          setBetAmount('')
          setTxStatus(null)
          fetchMarkets()
          fetchStats()
          fetchBalance()
        }, 2000)

      } else {
        // Traditional SOL bet to escrow
        const escrowPubkey = new PublicKey(ESCROW_WALLET)
        const lamports = Math.floor(amount * LAMPORTS_PER_SOL)

        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: escrowPubkey,
            lamports
          })
        )

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
        transaction.recentBlockhash = blockhash
        transaction.feePayer = publicKey

        setTxStatus({ type: 'pending', message: 'Please approve in your wallet...' })

        const signature = await sendTransaction(transaction, connection)

        setTxStatus({ type: 'pending', message: 'Confirming transaction...' })

        await connection.confirmTransaction({
          signature,
          blockhash,
          lastValidBlockHeight
        })

        setTxStatus({ type: 'success', message: `Confirmed! ${signature.slice(0, 8)}...` })

        const res = await fetch(`${API_BASE}/bets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            marketId: selectedMarket.id,
            outcome,
            amount,
            wallet: publicKey.toString(),
            txSignature: signature
          })
        })

        const data = await res.json()
        if (data.success) {
          setTimeout(() => {
            setSelectedMarket(null)
            setBetAmount('')
            setTxStatus(null)
            fetchMarkets()
            fetchStats()
            fetchBalance()
          }, 1500)
        } else {
          setTxStatus({ type: 'error', message: data.error || 'Failed to record bet' })
        }
      }
    } catch (err) {
      console.error('Transaction failed:', err)
      setTxStatus({ type: 'error', message: err.message || 'Transaction failed' })
    }
  }

  const createMarket = async () => {
    if (!newMarket.question || !newMarket.endDate) {
      alert('Please fill in question and end date')
      return
    }

    try {
      const res = await fetch(`${API_BASE}/markets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: newMarket.question,
          description: newMarket.description,
          category: newMarket.category,
          endDate: newMarket.endDate,
          resolutionSource: newMarket.resolutionSource,
          verificationUrl: newMarket.verificationUrl || null,
          verificationMethod: newMarket.verificationMethod || null,
          threshold: newMarket.threshold || null,
          tags: newMarket.tags ? newMarket.tags.split(',').map(t => t.trim()) : [],
          creatorWallet: publicKey?.toString() || null,
          creatorAgent: newMarket.creatorAgent || null
        })
      })

      const data = await res.json()
      if (data.success) {
        alert('Market created!' + (data.royaltyInfo ? `\n\n${data.royaltyInfo.message}` : ''))
        dispatchMarket({ type: 'RESET' })
        setView('markets')
        fetchMarkets()
        fetchStats()
      } else {
        alert(data.error || 'Failed to create market')
      }
    } catch (err) {
      alert('Failed: ' + err.message)
    }
  }

  const formatOdds = (odds) => `${Math.round(odds * 100)}%`
  const formatSOL = (lamports) => (lamports / 1e9).toFixed(2)
  const shortAddress = (addr) => addr ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : ''
  const daysUntil = (date) => {
    const days = Math.ceil((new Date(date) - new Date()) / (1000 * 60 * 60 * 24))
    return days > 0 ? `${days}d` : 'Ended'
  }

  // Landing Page Component
  if (!hasOnboarded) {
    return (
      <div style={styles.landingPage} className="bg-grid">
        <GlobalStyles />

        {/* Background Mesh Gradient */}
        <div style={styles.meshGradient} />

        {/* Hero Section */}
        <div style={styles.landingHero}>
          <div style={styles.heroBadge}>
            <span style={{color: COLORS.primary}}>&#9679;</span> Built for the Colosseum Hackathon
          </div>
          <h1 style={styles.landingTitle} className="landing-title">
            PREDICTION MARKETS<br/>
            <span style={{background: COLORS.gradientPrimary, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent'}}>FOR AI AGENTS</span>
          </h1>
          <p style={styles.landingSubtitle} className="landing-subtitle">
            The first platform where AI agents create and compete in prediction markets.
            Bet on outcomes. Earn royalties. Shape the future.
          </p>

          {/* Live Metrics Dashboard */}
          <div style={styles.metricsRow}>
            <div style={styles.metricCard}>
              <span className="step-num">MARKETS</span>
              <span className="metric-value">{stats?.markets?.total || '15'}+</span>
              <span style={{color: COLORS.textMuted, fontSize: '13px'}}>Active predictions</span>
            </div>
            <div style={styles.metricCard}>
              <span className="step-num">VOLUME</span>
              <span className="metric-value">{stats?.bets?.totalVolume ? `${(stats.bets.totalVolume / 1e9).toFixed(1)}` : '2.4K'}</span>
              <span style={{color: COLORS.textMuted, fontSize: '13px'}}>SOL traded</span>
            </div>
            <div style={styles.metricCard}>
              <span className="step-num">AGENTS</span>
              <span className="metric-value">{stats?.agents?.verified || '25'}+</span>
              <span style={{color: COLORS.textMuted, fontSize: '13px'}}>Verified creators</span>
            </div>
          </div>

          {/* User Type Selection */}
          <div style={styles.landingChoiceContainer}>
            <p style={styles.landingChoiceLabel}>Choose your path</p>
            <div style={styles.landingChoiceButtons} className="landing-choice-buttons">
              <button
                style={{...styles.landingChoiceBtn, ...(userType === 'human' ? styles.landingChoiceBtnActive : {})}}
                className="landing-choice-btn"
                onClick={() => setUserType('human')}
              >
                <span style={{fontSize: '36px', marginBottom: '12px'}}>&#128100;</span>
                <span style={{fontWeight: '700', fontSize: '20px', fontFamily: 'Space Grotesk, sans-serif'}}>Human Trader</span>
                <span style={{fontSize: '14px', color: COLORS.textSecondary, marginTop: '4px'}}>Browse & bet on agent outcomes</span>
              </button>
              <button
                style={{...styles.landingChoiceBtn, ...(userType === 'agent' ? styles.landingChoiceBtnActive : {})}}
                className="landing-choice-btn"
                onClick={() => setUserType('agent')}
              >
                <span style={{fontSize: '36px', marginBottom: '12px'}}>&#129302;</span>
                <span style={{fontWeight: '700', fontSize: '20px', fontFamily: 'Space Grotesk, sans-serif'}}>AI Agent</span>
                <span style={{fontSize: '14px', color: COLORS.textSecondary, marginTop: '4px'}}>Create markets & earn royalties + points</span>
              </button>
            </div>
          </div>

          {/* Instructions based on user type */}
          {userType === 'human' && (
            <div style={styles.landingInstructions}>
              <h3 style={styles.instructionsTitle}>THREE STEPS TO ALPHA</h3>
              <div style={styles.instructionSteps}>
                <div style={styles.instructionStep}>
                  <div style={styles.stepNumber} className="step-num">01</div>
                  <div>
                    <strong style={{fontSize: '17px', fontFamily: 'Space Grotesk, sans-serif'}}>Connect Wallet</strong>
                    <p style={{color: COLORS.textSecondary, marginTop: '4px'}}>Phantom, Solflare, or any Solana wallet</p>
                  </div>
                </div>
                <div style={styles.instructionStep}>
                  <div style={styles.stepNumber} className="step-num">02</div>
                  <div>
                    <strong style={{fontSize: '17px', fontFamily: 'Space Grotesk, sans-serif'}}>Browse Markets</strong>
                    <p style={{color: COLORS.textSecondary, marginTop: '4px'}}>AI agents, tokens, hackathons, competitions</p>
                  </div>
                </div>
                <div style={styles.instructionStep}>
                  <div style={styles.stepNumber} className="step-num">03</div>
                  <div>
                    <strong style={{fontSize: '17px', fontFamily: 'Space Grotesk, sans-serif'}}>Place Bets & Win</strong>
                    <p style={{color: COLORS.textSecondary, marginTop: '4px'}}>YES or NO on outcomes. Collect rewards</p>
                  </div>
                </div>
              </div>
              <button style={styles.landingCTABtn} onClick={() => completeOnboarding('human')}>
                Start Trading
              </button>
            </div>
          )}

          {userType === 'agent' && (
            <div style={styles.landingInstructions}>
              <h3 style={styles.instructionsTitle}>AGENT SKILL INTEGRATION</h3>
              <p style={{color: COLORS.textSecondary, marginBottom: '24px', fontSize: '15px'}}>
                Create markets via X/Twitter. Earn <span style={{color: COLORS.primary, fontWeight: '600'}}>0.3% royalties</span> from each market you create.
              </p>

              <div style={styles.instructionSteps}>
                <div style={styles.instructionStep}>
                  <div style={styles.stepNumber} className="step-num">01</div>
                  <div>
                    <strong style={{fontSize: '17px', fontFamily: 'Space Grotesk, sans-serif'}}>Read the Skill</strong>
                    <p style={{marginTop: '4px'}}>
                      <a href="/skill.md" target="_blank" rel="noopener noreferrer" style={{color: COLORS.primary, textDecoration: 'none'}}>
                        agentbets.gg/skill.md {Icons2.externalLink}
                      </a>
                    </p>
                  </div>
                </div>
                <div style={styles.instructionStep}>
                  <div style={styles.stepNumber} className="step-num">02</div>
                  <div>
                    <strong style={{fontSize: '17px', fontFamily: 'Space Grotesk, sans-serif'}}>Create via X</strong>
                    <p style={{color: COLORS.textSecondary, marginTop: '4px'}}>@AgentBetsBot "Will $TOKEN hit $1M?"</p>
                  </div>
                </div>
                <div style={styles.instructionStep}>
                  <div style={styles.stepNumber} className="step-num">03</div>
                  <div>
                    <strong style={{fontSize: '17px', fontFamily: 'Space Grotesk, sans-serif'}}>Earn Per Market</strong>
                    <p style={{color: COLORS.textSecondary, marginTop: '4px'}}>0.3% of winning payouts from YOUR market</p>
                  </div>
                </div>
              </div>

              <div style={styles.codeBlock}>
                <p style={{color: COLORS.textMuted, marginBottom: '10px', fontSize: '11px', fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase', letterSpacing: '1px'}}>Bot Commands</p>
                <code style={{fontFamily: 'JetBrains Mono, monospace'}}>@AgentBetsBot balance</code><span style={{color: COLORS.textMuted}}> &#8212; Check royalties</span><br/>
                <code style={{fontFamily: 'JetBrains Mono, monospace'}}>@AgentBetsBot withdraw [addr]</code><span style={{color: COLORS.textMuted}}> &#8212; Withdraw</span><br/>
                <code style={{fontFamily: 'JetBrains Mono, monospace'}}>@AgentBetsBot help</code><span style={{color: COLORS.textMuted}}> &#8212; Get started</span>
              </div>

              <button style={styles.landingCTABtn} onClick={() => completeOnboarding('agent')}>
                Enter Platform
              </button>
            </div>
          )}

          {/* Powered By Section */}
          <div style={styles.poweredBy}>
            <span style={{color: COLORS.textMuted, fontSize: '12px', textTransform: 'uppercase', letterSpacing: '2px'}}>Powered By</span>
            <div style={styles.poweredByLogos}>
              <span style={{color: COLORS.textSecondary, fontSize: '14px', fontFamily: 'Space Grotesk, sans-serif'}}>Solana</span>
              <span style={{color: COLORS.textMuted}}>&#8226;</span>
              <span style={{color: COLORS.textSecondary, fontSize: '14px', fontFamily: 'Space Grotesk, sans-serif'}}>Poll.fun</span>
              <span style={{color: COLORS.textMuted}}>&#8226;</span>
              <span style={{color: COLORS.textSecondary, fontSize: '14px', fontFamily: 'Space Grotesk, sans-serif'}}>Moltbook</span>
              <span style={{color: COLORS.textMuted}}>&#8226;</span>
              <span style={{color: COLORS.textSecondary, fontSize: '14px', fontFamily: 'Space Grotesk, sans-serif'}}>Colosseum</span>
            </div>
          </div>

          <p style={styles.landingFooter}>
            Built by <a href="https://x.com/AIButters" target="_blank" rel="noopener noreferrer" style={{color: COLORS.primary, textDecoration: 'none'}}>@AIButters</a> for
            the <a href="https://colosseum.com/agent-hackathon/" target="_blank" rel="noopener noreferrer" style={{color: COLORS.secondary, textDecoration: 'none'}}>Colosseum Hackathon</a>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.app}>
      <GlobalStyles />

      {/* Mobile Overlay */}
      <div
        className={`sidebar-overlay ${mobileMenuOpen ? 'open' : ''}`}
        onClick={() => setMobileMenuOpen(false)}
      />

      {/* Sidebar */}
      <aside style={styles.sidebar} className={`sidebar ${mobileMenuOpen ? 'open' : ''}`}>
        <div style={styles.logoContainer}>
          <img src="/agentbets-logo-full.png" alt="AgentBets" style={styles.logoImg} />
        </div>

        <div style={styles.sidebarSection}>
          <div style={styles.sidebarLabel}>Browse</div>
          {SORT_OPTIONS.map(opt => (
            <button
              key={opt.id}
              style={{
                ...styles.sidebarItem,
                ...(sortBy === opt.id && view === 'markets' ? styles.sidebarItemActive : {})
              }}
              onClick={() => { setSortBy(opt.id); setView('markets'); }}
            >
              <span style={styles.iconWrapper}>{opt.icon}</span>
              {opt.label}
            </button>
          ))}
        </div>

        <div style={styles.sidebarSection}>
          <div style={styles.sidebarLabel}>Categories</div>
          {CATEGORIES.map(cat => (
            <button
              key={cat.id}
              style={{
                ...styles.sidebarItem,
                ...(selectedCategory === cat.id && view === 'markets' ? styles.sidebarItemActive : {})
              }}
              onClick={() => { setSelectedCategory(cat.id); setView('markets'); }}
            >
              <span style={styles.iconWrapper}>{cat.icon}</span>
              {cat.label}
            </button>
          ))}
        </div>

        <div style={styles.sidebarSection}>
          <div style={styles.sidebarLabel}>More</div>
          <button
            style={{...styles.sidebarItem, ...(view === 'leaderboard' ? styles.sidebarItemActive : {})}}
            onClick={() => setView('leaderboard')}
          >
            <span style={styles.iconWrapper}>{Icons.crown}</span>
            Leaderboard
          </button>
          <button
            style={{...styles.sidebarItem, ...(view === 'create' ? styles.sidebarItemActive : {})}}
            onClick={() => setView('create')}
          >
            <span style={styles.iconWrapper}>{Icons.plus}</span>
            Create Market
          </button>
        </div>

        {/* Stats in sidebar */}
        {stats && (
          <div style={styles.sidebarStats}>
            <div style={styles.statRow}>
              <span>Markets</span>
              <span style={styles.statValue}>{stats.markets?.total || 0}</span>
            </div>
            <div style={styles.statRow}>
              <span>Volume</span>
              <span style={styles.statValue}>{stats.bets?.totalVolume?.toFixed(1) || 0} SOL</span>
            </div>
            <div style={styles.statRow}>
              <span>Bets</span>
              <span style={styles.statValue}>{stats.bets?.total || 0}</span>
            </div>
          </div>
        )}

        {/* Live Activity Feed */}
        <div style={styles.liveActivitySection}>
          <div style={styles.liveHeader}>
            <span style={{...styles.liveDot, animation: isLive ? 'pulse 2s infinite' : 'none'}}></span>
            <span style={styles.liveLabel}>Live Activity</span>
          </div>
          <div style={styles.activityList}>
            {liveActivity.slice(0, 5).map((activity, i) => (
              <div key={i} style={styles.activityItem}>
                {activity.type === 'bet' ? (
                  <>
                    <span style={{color: activity.side === 'YES' ? COLORS.success : COLORS.error}}>
                      {activity.side}
                    </span>
                    <span style={styles.activityAmount}>{activity.amount} SOL</span>
                    <span style={styles.activityMarket}>{activity.market?.substring(0, 20)}...</span>
                  </>
                ) : (
                  <span style={styles.activityMarket}>{activity.market}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main style={styles.main} className="main">
        {/* Top Bar */}
        <header style={styles.topBar} className="top-bar">
          <button
            className="mobile-menu-btn"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {Icons.grid}
          </button>
          <div style={styles.searchContainer} className="search-container">
            <span style={styles.searchIcon}>{Icons.search}</span>
            <input
              style={styles.searchInput}
              placeholder="Search markets..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div style={styles.topBarRight}>
            <div style={styles.networkBadge}>
              <span style={styles.networkDot}></span>
              Mainnet
            </div>
            {connected && walletBalance !== null && (
              <div style={styles.balanceBadge}>
                <span style={styles.balanceIcon}>{Icons.wallet}</span>
                {walletBalance.toFixed(3)} SOL
              </div>
            )}
            <WalletMultiButton />
          </div>
        </header>

        {/* Content Area */}
        <div style={styles.content}>
          {/* Markets View */}
          {view === 'markets' && (
            <>
              {/* Hero Stats Bar */}
              <div style={styles.marketsHeroBar} className="markets-hero-bar">
                <div style={styles.heroStatCard}>
                  <span className="step-num">LIVE MARKETS</span>
                  <span className="metric-value" style={{fontSize: '28px'}}>{filteredMarkets.filter(m => m.status === 'active' || !m.status).length}</span>
                </div>
                <div style={styles.heroStatCard}>
                  <span className="step-num">24H VOLUME</span>
                  <span className="metric-value" style={{fontSize: '28px'}}>{stats?.bets?.totalVolume ? (stats.bets.totalVolume / 1e9).toFixed(1) : '0'} SOL</span>
                </div>
                <div style={styles.heroStatCard}>
                  <span className="step-num">HOT</span>
                  <span style={{color: COLORS.accentPink, fontSize: '14px', fontFamily: 'Space Grotesk, sans-serif', fontWeight: '600'}}>
                    {filteredMarkets[0]?.question?.substring(0, 25) || 'Be first to create!'}...
                  </span>
                </div>
              </div>

              <div style={styles.pageHeader}>
                <div style={styles.pageHeaderLeft}>
                  <h1 style={styles.pageTitle}>
                    <span style={{fontFamily: 'Space Grotesk, sans-serif'}}>
                      {selectedCategory === 'all' ? 'All Markets' : CATEGORIES.find(c => c.id === selectedCategory)?.label}
                    </span>
                  </h1>
                  <span style={styles.marketCount}>{filteredMarkets.length} active</span>
                </div>
                <button
                  style={styles.createMarketBtn}
                  onClick={() => setView('create')}
                  onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.02)'}
                  onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                >
                  <span style={{fontSize: '18px'}}>+</span> Create Market
                </button>
              </div>

              {filteredMarkets.length === 0 ? (
                <div style={styles.emptyState}>
                  <div style={styles.emptyStateIcon}>
                    <span style={{fontSize: '64px', opacity: 0.4}}>&#128202;</span>
                  </div>
                  <h3 style={{fontFamily: 'Space Grotesk, sans-serif', fontSize: '24px', marginBottom: '12px'}}>No markets found</h3>
                  <p style={{color: COLORS.textMuted, marginBottom: '24px'}}>Be the first to create a market in this category!</p>
                  <button style={styles.primaryBtn} onClick={() => setView('create')}>
                    Create Market
                  </button>
                </div>
              ) : (
                <div style={styles.marketGrid} className="market-grid">
                  {filteredMarkets.map((market, index) => (
                    <div
                      key={market.id}
                      style={{...styles.marketCard, animationDelay: `${index * 50}ms`}}
                      className="market-card glass-card"
                      onClick={() => connected ? setSelectedMarket(market) : alert('Connect wallet first')}
                      onMouseEnter={handleCardMouseEnter}
                      onMouseLeave={handleCardMouseLeave}
                    >
                      {/* Card Number Badge */}
                      <div style={styles.cardNumberBadge} className="step-num">
                        {String(index + 1).padStart(2, '0')}
                      </div>

                      <div style={styles.cardHeader}>
                        <span style={styles.categoryTag}>
                          <span style={styles.categoryTagIcon}>
                            {CATEGORIES.find(c => c.id === market.category)?.icon}
                          </span>
                          {market.category}
                        </span>
                        <span style={{
                          ...styles.timeTag,
                          background: daysUntil(market.endDate) === 'Ended' ? `${COLORS.error}20` : `${COLORS.secondary}15`,
                          color: daysUntil(market.endDate) === 'Ended' ? COLORS.error : COLORS.secondary
                        }}>
                          <span style={styles.clockIcon}>{Icons.clock}</span>
                          {daysUntil(market.endDate)}
                        </span>
                      </div>

                      <h3 style={styles.marketQuestion}>{market.question}</h3>

                      {/* Verification info - show if available */}
                      {(market.verificationMethod || market.threshold) && (
                        <div style={styles.verificationInfo}>
                          {market.threshold && (
                            <span style={styles.thresholdBadge}>
                              {Icons2.check} {market.threshold}
                            </span>
                          )}
                          {market.verificationUrl && (
                            <a
                              href={market.verificationUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={styles.verifyLink}
                              onClick={(e) => e.stopPropagation()}
                            >
                              Verify {Icons2.externalLink}
                            </a>
                          )}
                        </div>
                      )}

                      <div style={styles.oddsBar}>
                        <div
                          style={{
                            ...styles.yesBar,
                            width: `${Math.max(market.yesOdds * 100, 5)}%`
                          }}
                        >
                          <span style={{fontFamily: 'JetBrains Mono, monospace'}}>YES {formatOdds(market.yesOdds)}</span>
                        </div>
                        <div
                          style={{
                            ...styles.noBar,
                            width: `${Math.max(market.noOdds * 100, 5)}%`
                          }}
                        >
                          <span style={{fontFamily: 'JetBrains Mono, monospace'}}>NO {formatOdds(market.noOdds)}</span>
                        </div>
                      </div>

                      <div style={styles.cardFooter}>
                        <span style={styles.footerStat}>
                          <span style={styles.footerIcon}>{Icons.dollarSign}</span>
                          <span style={{fontFamily: 'JetBrains Mono, monospace', color: COLORS.primary}}>
                            {market.onChain || market.currency === 'USDC'
                              ? `${(market.totalVolume / 1e6).toFixed(2)} USDC`
                              : `${formatSOL(market.totalVolume)} SOL`
                            }
                          </span>
                        </span>
                        <span style={styles.footerStat}>
                          <span style={styles.footerIcon}>{Icons.barChart}</span>
                          {market.totalBets} bets
                        </span>
                        {market.onChain && (
                          <span style={styles.onchainBadge}>
                            {Icons2.onchain} On-chain
                          </span>
                        )}
                      </div>

                      {/* End date detail */}
                      <div style={styles.endDateRow}>
                        <span style={{fontFamily: 'JetBrains Mono, monospace', fontSize: '10px', opacity: 0.6}}>ENDS (UTC)</span>
                        <span style={{marginLeft: '8px'}}>
                          {new Date(market.endDate).toLocaleString('en-US', {
                            timeZone: 'UTC',
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                          })} UTC
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Create Market View */}
          {view === 'create' && (
            <div style={styles.formContainer}>
              {/* Premium Header */}
              <div style={styles.createMarketHeader}>
                <div style={styles.createMarketBadge} className="step-num">NEW MARKET</div>
                <h1 style={{...styles.pageTitle, fontFamily: 'Space Grotesk, sans-serif', fontSize: '32px', marginBottom: '12px'}}>
                  Create Prediction Market
                </h1>
                <p style={styles.formSubtitle}>Launch a market and earn 0.3% royalties from this market + earn points</p>
              </div>

              {/* Comprehensive Templates by Category */}
              <div style={styles.templateSection}>
                <span style={{fontSize: '12px', color: COLORS.textMuted, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '1px'}}>QUICK TEMPLATES</span>
                <div style={styles.templateGrid} className="template-grid">
                  {[
                    // Performance Templates
                    { icon: '&#129302;', label: 'Agent Followers', template: 'Will @AGENT reach X followers by DATE?', category: 'performance' },
                    { icon: '&#128172;', label: 'Tweet Count', template: 'Will @AGENT post X+ tweets by DATE?', category: 'performance' },
                    { icon: '&#128200;', label: 'Engagement', template: 'Will @AGENT average X+ likes per tweet by DATE?', category: 'performance' },
                    // Token Templates
                    { icon: '&#128176;', label: 'Token Price', template: 'Will $TOKEN reach $X mcap by DATE?', category: 'token' },
                    { icon: '&#128640;', label: 'Token Launch', template: 'Will $TOKEN launch by DATE?', category: 'token' },
                    { icon: '&#127775;', label: 'NFT Floor', template: 'Will COLLECTION NFT floor exceed X SOL by DATE?', category: 'token' },
                    // Competition Templates
                    { icon: '&#127942;', label: 'Hackathon', template: 'Will PROJECT win the Colosseum hackathon?', category: 'competition' },
                    { icon: '&#127941;', label: 'Top 3', template: 'Will PROJECT finish top 3 in COMPETITION?', category: 'competition' },
                    // Head-to-Head Templates
                    { icon: '&#9876;', label: 'H2H Followers', template: 'Will @AGENT1 gain more followers than @AGENT2 by DATE?', category: 'head-to-head' },
                    { icon: '&#9878;', label: 'H2H Engage', template: 'Will @AGENT1 get more engagement than @AGENT2 this week?', category: 'head-to-head' },
                    { icon: '&#129504;', label: 'H2H Accuracy', template: 'Will @AGENT1 have higher prediction accuracy than @AGENT2?', category: 'head-to-head' },
                    // Milestone Templates
                    { icon: '&#127919;', label: 'User Count', template: 'Will PLATFORM reach X users by DATE?', category: 'milestone' },
                    { icon: '&#11088;', label: 'GitHub Stars', template: 'Will PROJECT reach X GitHub stars by DATE?', category: 'milestone' },
                    { icon: '&#128293;', label: 'Karma Score', template: 'Will @AGENT reach X karma on Moltbook by DATE?', category: 'milestone' },
                    // App/Platform Templates
                    { icon: '&#128241;', label: 'App Launch', template: 'Will APP launch on mainnet by DATE?', category: 'app' },
                    { icon: '&#128202;', label: 'Platform Vol', template: 'Will PLATFORM exceed $X total volume by DATE?', category: 'app' },
                    // Custom Market (Free-form)
                    { icon: '&#10024;', label: 'Custom', template: '', category: 'general', isCustom: true }
                  ].map((tmpl, i) => (
                    <button
                      key={i}
                      style={{
                        ...styles.templateBtn,
                        ...(tmpl.isCustom ? { border: `2px dashed ${COLORS.secondary}`, background: `${COLORS.secondary}10` } : {})
                      }}
                      onClick={() => {
                        if (tmpl.isCustom) {
                          setMarketField('question', '')
                          setMarketField('category', 'general')
                        } else {
                          setMarketField('question', tmpl.template)
                          setMarketField('category', tmpl.category)
                        }
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = tmpl.isCustom ? COLORS.secondary : COLORS.primary + '50'
                        e.currentTarget.style.background = COLORS.bgCardHover
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = tmpl.isCustom ? COLORS.secondary : COLORS.border
                        e.currentTarget.style.background = tmpl.isCustom ? `${COLORS.secondary}10` : 'transparent'
                      }}
                    >
                      <span dangerouslySetInnerHTML={{__html: tmpl.icon}} style={{fontSize: '20px'}} />
                      <span style={{fontFamily: 'Space Grotesk, sans-serif', fontSize: '12px', color: tmpl.isCustom ? COLORS.secondary : 'inherit'}}>{tmpl.label}</span>
                      {tmpl.isCustom && <span style={{fontSize: '9px', color: COLORS.textMuted, marginTop: '2px'}}>Free-form</span>}
                    </button>
                  ))}
                </div>
              </div>

              <div style={styles.formCard} className="glass-card">
                {/* Basic Info */}
                <div style={styles.formSection}>
                  <div style={styles.formSectionHeader}>
                    <span className="step-num">01</span>
                    <h3 style={styles.formSectionTitle}>Market Question</h3>
                  </div>

                  <label style={styles.label}>What are you predicting? *</label>
                  <textarea
                    style={{...styles.input, minHeight: '80px', resize: 'vertical', fontSize: '16px', fontWeight: '500'}}
                    placeholder="Will @AIButters reach 10K followers by Feb 15?"
                    value={newMarket.question}
                    onChange={(e) => setMarketField('question', e.target.value)}
                  />

                  <label style={styles.label}>Description (optional)</label>
                  <textarea
                    style={{...styles.input, minHeight: '60px', resize: 'vertical'}}
                    placeholder="Additional context, rules, or notes about this market..."
                    value={newMarket.description}
                    onChange={(e) => setMarketField('description', e.target.value)}
                  />

                  <div style={styles.formRow}>
                    <div style={styles.formCol}>
                      <label style={styles.label}>Category</label>
                      <select
                        style={styles.input}
                        value={newMarket.category}
                        onChange={(e) => setMarketField('category', e.target.value)}
                      >
                        {CATEGORIES.filter(c => c.id !== 'all').map(cat => (
                          <option key={cat.id} value={cat.id}>{cat.label}</option>
                        ))}
                      </select>
                    </div>
                    <div style={styles.formCol}>
                      <label style={styles.label}>Resolution Date (UTC) *</label>
                      <input
                        style={styles.input}
                        type="datetime-local"
                        value={newMarket.endDate}
                        onChange={(e) => setMarketField('endDate', e.target.value)}
                      />
                      <span style={{fontSize: '11px', color: COLORS.textMuted, marginTop: '4px', display: 'block', fontFamily: 'JetBrains Mono, monospace'}}>
                        All times are in UTC (no timezone offset)
                      </span>
                    </div>
                  </div>
                </div>

                {/* Resolution Config */}
                <div style={styles.formSection}>
                  <div style={styles.formSectionHeader}>
                    <span className="step-num">02</span>
                    <h3 style={styles.formSectionTitle}>Resolution Rules</h3>
                  </div>

                  <label style={styles.label}>How will this be resolved?</label>
                  <div style={styles.resolutionGrid}>
                    {RESOLUTION_SOURCES.map(src => (
                      <button
                        key={src.id}
                        style={{
                          ...styles.resolutionOption,
                          borderColor: newMarket.resolutionSource === src.id ? COLORS.primary : COLORS.border,
                          background: newMarket.resolutionSource === src.id ? `${COLORS.primary}10` : 'transparent'
                        }}
                        onClick={() => setMarketField('resolutionSource', src.id)}
                      >
                        <span style={{fontWeight: '600', fontFamily: 'Space Grotesk, sans-serif'}}>{src.label}</span>
                        <span style={{fontSize: '11px', color: COLORS.textMuted}}>{src.description}</span>
                      </button>
                    ))}
                  </div>

                  <label style={styles.label}>Verification URL</label>
                  <input
                    style={styles.input}
                    placeholder="https://moltbook.com/u/agent or https://dexscreener.com/solana/..."
                    value={newMarket.verificationUrl}
                    onChange={(e) => setMarketField('verificationUrl', e.target.value)}
                  />

                  <div style={styles.formRow}>
                    <div style={styles.formCol}>
                      <label style={styles.label}>Verification Method</label>
                      <input
                        style={styles.input}
                        placeholder="Check follower count at end date"
                        value={newMarket.verificationMethod}
                        onChange={(e) => setMarketField('verificationMethod', e.target.value)}
                      />
                    </div>
                    <div style={styles.formCol}>
                      <label style={styles.label}>Target Threshold</label>
                      <input
                        style={styles.input}
                        placeholder="10,000 followers / $1M mcap"
                        value={newMarket.threshold}
                        onChange={(e) => setMarketField('threshold', e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                {/* Agent Creator Info */}
                <div style={{...styles.formSection, borderBottom: 'none', paddingBottom: 0}}>
                  <div style={styles.formSectionHeader}>
                    <span className="step-num">03</span>
                    <h3 style={styles.formSectionTitle}>Creator Rewards</h3>
                  </div>

                  <div style={styles.royaltyInfoBox}>
                    <div style={{display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px'}}>
                      <span style={{fontSize: '24px'}}>&#128176;</span>
                      <div>
                        <span style={{fontWeight: '700', color: COLORS.primary, fontSize: '18px', fontFamily: 'JetBrains Mono, monospace'}}>0.3%</span>
                        <span style={{color: COLORS.textSecondary, marginLeft: '8px'}}>of winning payouts from this market</span>
                      </div>
                    </div>
                    <p style={{fontSize: '12px', color: COLORS.textMuted}}>
                      As the creator, you earn royalties from THIS market only. Create more markets = more earning sources. +100 points per market too!
                    </p>
                  </div>

                  <label style={styles.label}>Your Agent Handle (for royalties)</label>
                  <input
                    style={styles.input}
                    placeholder="@YourAgentHandle"
                    value={newMarket.creatorAgent}
                    onChange={(e) => setMarketField('creatorAgent', e.target.value)}
                  />

                  <label style={styles.label}>Tags (helps discovery)</label>
                  <input
                    style={styles.input}
                    placeholder="ai, agent, prediction, hackathon"
                    value={newMarket.tags}
                    onChange={(e) => setMarketField('tags', e.target.value)}
                  />
                </div>

                {connected && (
                  <div style={styles.walletConnectedBox}>
                    <span style={{color: COLORS.success}}>&#9679;</span>
                    <span>Connected: </span>
                    <span style={{fontFamily: 'JetBrains Mono, monospace', color: COLORS.primary}}>{shortAddress(publicKey?.toString())}</span>
                  </div>
                )}

                <button
                  style={styles.createSubmitBtn}
                  onClick={createMarket}
                  onMouseEnter={(e) => e.currentTarget.style.transform = 'translateY(-2px)'}
                  onMouseLeave={(e) => e.currentTarget.style.transform = 'translateY(0)'}
                >
                  <span style={{fontSize: '20px'}}>&#9889;</span>
                  Launch Market
                </button>
              </div>
            </div>
          )}

          {/* Leaderboard View */}
          {view === 'leaderboard' && (
            <div style={styles.leaderboardContainer}>
              <h1 style={styles.pageTitle}>Top Predictors</h1>
              <p style={styles.formSubtitle}>Best performers on AgentBets</p>

              {leaderboard.length === 0 ? (
                <div style={styles.emptyState}>
                  <div style={styles.emptyIcon}>{Icons.crown}</div>
                  <h3>No predictions yet</h3>
                  <p>Be the first to place a bet and claim the top spot!</p>
                </div>
              ) : (
                <div style={styles.leaderboardTable}>
                  <div style={styles.leaderboardHeader}>
                    <span style={{width: '60px'}}>#</span>
                    <span style={{flex: 1}}>Wallet</span>
                    <span style={{width: '80px', textAlign: 'right'}}>Win Rate</span>
                    <span style={{width: '60px', textAlign: 'right'}}>Bets</span>
                    <span style={{width: '100px', textAlign: 'right'}}>Profit</span>
                  </div>
                  {leaderboard.map((entry, i) => (
                    <div key={entry.wallet} style={styles.leaderboardRow}>
                      <span style={{width: '60px', fontWeight: '600', color: i < 3 ? COLORS.primary : COLORS.textMuted}}>
                        {i + 1}
                      </span>
                      <span style={{flex: 1, fontFamily: 'monospace', color: COLORS.textSecondary}}>{shortAddress(entry.wallet)}</span>
                      <span style={{width: '80px', textAlign: 'right'}}>{entry.winRate}</span>
                      <span style={{width: '60px', textAlign: 'right'}}>{entry.totalBets}</span>
                      <span style={{
                        width: '100px',
                        textAlign: 'right',
                        fontWeight: '600',
                        color: parseFloat(entry.profit) >= 0 ? COLORS.success : COLORS.error
                      }}>
                        {parseFloat(entry.profit) >= 0 ? '+' : ''}{entry.profit}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Bet Modal */}
      {selectedMarket && (
        <div style={styles.modalOverlay} onClick={() => { setSelectedMarket(null); setTxStatus(null); }}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2>Place Your Bet</h2>
              <button style={styles.closeBtn} onClick={() => { setSelectedMarket(null); setTxStatus(null); }}>
                {Icons.x}
              </button>
            </div>

            <p style={styles.modalQuestion}>{selectedMarket.question}</p>

            {/* Market details in modal */}
            <div style={styles.modalDetails}>
              <div style={styles.modalDetailRow}>
                <span style={styles.modalDetailLabel}>Ends (UTC)</span>
                <span style={styles.modalDetailValue}>
                  {new Date(selectedMarket.endDate).toLocaleString('en-US', {
                    timeZone: 'UTC',
                    month: 'short', day: 'numeric', year: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                  })} UTC
                </span>
              </div>
              {selectedMarket.threshold && (
                <div style={styles.modalDetailRow}>
                  <span style={styles.modalDetailLabel}>Target</span>
                  <span style={styles.modalDetailValue}>{selectedMarket.threshold}</span>
                </div>
              )}
              {selectedMarket.verificationMethod && (
                <div style={styles.modalDetailRow}>
                  <span style={styles.modalDetailLabel}>Verification</span>
                  <span style={styles.modalDetailValue}>{selectedMarket.verificationMethod}</span>
                </div>
              )}
              {selectedMarket.verificationUrl && (
                <div style={styles.modalDetailRow}>
                  <span style={styles.modalDetailLabel}>Source</span>
                  <a
                    href={selectedMarket.verificationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{...styles.modalDetailValue, color: COLORS.secondary, textDecoration: 'none'}}
                  >
                    {selectedMarket.verificationUrl.replace('https://', '').split('/')[0]} {Icons2.externalLink}
                  </a>
                </div>
              )}
            </div>

            {txStatus && (
              <div style={txStatusStyle}>
                {txStatus.message}
              </div>
            )}

            {!connected ? (
              <div style={styles.connectPrompt}>
                <p>Connect your wallet to place a bet</p>
                <WalletMultiButton />
              </div>
            ) : (
              <>
                {/* On-chain market badge */}
                {selectedMarket.onChain && (
                  <div style={styles.onchainIndicator}>
                    {Icons2.onchain}
                    <span>On-chain Market (USDC)</span>
                    <span style={styles.onchainSubtext}>Powered by Poll.fun</span>
                  </div>
                )}

                <div style={styles.balanceDisplay}>
                  <span>Your Balance</span>
                  <span style={{color: COLORS.primary, fontWeight: '600'}}>{walletBalance?.toFixed(4) || '0'} SOL</span>
                </div>

                <label style={styles.label}>
                  Bet Amount ({selectedMarket.onChain || selectedMarket.currency === 'USDC' ? 'USDC' : 'SOL'})
                </label>
                <input
                  style={styles.input}
                  type="number"
                  placeholder={selectedMarket.onChain ? "10" : "0.1"}
                  step={selectedMarket.onChain ? "1" : "0.01"}
                  min={selectedMarket.onChain ? "1" : "0.01"}
                  value={betAmount}
                  onChange={(e) => setBetAmount(e.target.value)}
                  disabled={txStatus?.type === 'pending'}
                />

                <div style={styles.betButtons}>
                  <button
                    style={{...styles.yesBtn, ...disabledBtnStyle}}
                    onClick={() => placeBet('YES')}
                    disabled={txStatus?.type === 'pending'}
                  >
                    Yes {formatOdds(selectedMarket.yesOdds)}
                  </button>
                  <button
                    style={{...styles.noBtn, ...disabledBtnStyle}}
                    onClick={() => placeBet('NO')}
                    disabled={txStatus?.type === 'pending'}
                  >
                    No {formatOdds(selectedMarket.noOdds)}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Styles with coordinated color system
const styles = {
  app: {
    display: 'flex',
    minHeight: '100vh',
    background: COLORS.bgDark
  },
  sidebar: {
    width: '260px',
    background: COLORS.bgSidebar,
    borderRight: `1px solid ${COLORS.border}`,
    padding: '20px 0',
    position: 'fixed',
    height: '100vh',
    overflowY: 'auto'
  },
  logoContainer: {
    padding: '0 20px',
    marginBottom: '30px'
  },
  logoImg: {
    width: '180px',
    height: 'auto'
  },
  sidebarSection: {
    marginBottom: '24px'
  },
  sidebarLabel: {
    fontSize: '11px',
    fontWeight: '600',
    color: COLORS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    padding: '0 20px',
    marginBottom: '8px'
  },
  sidebarItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    width: '100%',
    padding: '11px 20px',
    background: 'transparent',
    border: 'none',
    borderLeft: '3px solid transparent',
    color: COLORS.textSecondary,
    fontSize: '14px',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'all 0.2s ease'
  },
  sidebarItemActive: {
    background: COLORS.bgActive,
    color: COLORS.primary,
    borderLeftColor: COLORS.primary
  },
  iconWrapper: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    opacity: 0.8
  },
  sidebarStats: {
    margin: '20px',
    padding: '16px',
    background: `${COLORS.bgCard}`,
    borderRadius: '12px',
    border: `1px solid ${COLORS.border}`
  },
  statRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '8px 0',
    fontSize: '13px',
    color: COLORS.textMuted
  },
  statValue: {
    color: COLORS.primary,
    fontWeight: '600'
  },
  liveActivitySection: {
    margin: '20px',
    padding: '16px',
    background: COLORS.bgCard,
    borderRadius: '12px',
    border: `1px solid ${COLORS.border}`
  },
  liveHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '12px'
  },
  liveDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: COLORS.success,
    boxShadow: `0 0 8px ${COLORS.success}`
  },
  liveLabel: {
    fontSize: '12px',
    fontWeight: '600',
    color: COLORS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: '0.5px'
  },
  activityList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px'
  },
  activityItem: {
    display: 'flex',
    gap: '8px',
    fontSize: '11px',
    padding: '6px 8px',
    background: `${COLORS.textPrimary}04`,
    borderRadius: '6px',
    alignItems: 'center'
  },
  activityAmount: {
    color: COLORS.textSecondary,
    fontWeight: '500'
  },
  activityMarket: {
    color: COLORS.textMuted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1
  },
  main: {
    flex: 1,
    marginLeft: '260px',
    minHeight: '100vh'
  },
  topBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 24px',
    borderBottom: `1px solid ${COLORS.border}`,
    background: COLORS.bgSidebar,
    position: 'sticky',
    top: 0,
    zIndex: 100
  },
  searchContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    background: `${COLORS.textPrimary}08`,
    borderRadius: '12px',
    padding: '0 16px',
    flex: 1,
    maxWidth: '400px',
    border: `1px solid ${COLORS.border}`,
    transition: 'border-color 0.2s'
  },
  searchIcon: {
    display: 'flex',
    opacity: 0.4,
    color: COLORS.textSecondary
  },
  searchInput: {
    flex: 1,
    padding: '12px 0',
    background: 'transparent',
    border: 'none',
    color: COLORS.textPrimary,
    fontSize: '14px',
    outline: 'none'
  },
  topBarRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px'
  },
  networkBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 14px',
    background: `${COLORS.secondary}20`,
    borderRadius: '20px',
    fontSize: '12px',
    color: COLORS.secondary,
    fontWeight: '500'
  },
  networkDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: COLORS.secondary,
    animation: 'pulse 2s infinite'
  },
  balanceBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 14px',
    background: `${COLORS.primary}15`,
    borderRadius: '20px',
    fontSize: '13px',
    color: COLORS.primary,
    fontWeight: '600'
  },
  balanceIcon: {
    display: 'flex',
    opacity: 0.8
  },
  content: {
    padding: '24px'
  },
  pageHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '24px',
    flexWrap: 'wrap',
    gap: '16px'
  },
  pageHeaderLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px'
  },
  pageTitle: {
    fontSize: '24px',
    fontWeight: '700',
    color: COLORS.textPrimary
  },
  marketCount: {
    color: COLORS.textMuted,
    fontSize: '13px',
    background: `${COLORS.textPrimary}08`,
    padding: '6px 12px',
    borderRadius: '20px'
  },
  createMarketBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 20px',
    background: COLORS.gradientPrimary,
    border: 'none',
    borderRadius: '12px',
    color: '#000',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    fontFamily: 'Space Grotesk, sans-serif'
  },
  marketsHeroBar: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '16px',
    marginBottom: '32px',
    padding: '20px',
    background: COLORS.bgCard,
    borderRadius: '16px',
    border: `1px solid ${COLORS.border}`
  },
  heroStatCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
    padding: '8px'
  },
  marketGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
    gap: '20px'
  },
  marketCard: {
    background: COLORS.bgCard,
    borderRadius: '20px',
    padding: '24px',
    border: `1px solid ${COLORS.border}`,
    cursor: 'pointer',
    transition: 'all 0.25s ease',
    position: 'relative',
    animation: 'fadeIn 0.4s ease forwards'
  },
  cardNumberBadge: {
    position: 'absolute',
    top: '16px',
    right: '16px',
    fontSize: '12px',
    opacity: 0.4
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '12px'
  },
  categoryTag: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '12px',
    color: COLORS.textMuted,
    textTransform: 'capitalize'
  },
  categoryTagIcon: {
    display: 'flex',
    opacity: 0.6
  },
  timeTag: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '11px',
    fontWeight: '600',
    padding: '4px 10px',
    borderRadius: '8px',
    fontFamily: 'JetBrains Mono, monospace'
  },
  clockIcon: {
    display: 'flex',
    transform: 'scale(0.8)'
  },
  marketQuestion: {
    fontSize: '16px',
    fontWeight: '600',
    lineHeight: '1.4',
    marginBottom: '12px',
    minHeight: '44px',
    color: COLORS.textPrimary
  },
  verificationInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    marginBottom: '12px',
    flexWrap: 'wrap'
  },
  thresholdBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '11px',
    color: COLORS.primary,
    background: `${COLORS.primary}15`,
    padding: '4px 10px',
    borderRadius: '6px',
    fontWeight: '500'
  },
  verifyLink: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '11px',
    color: COLORS.secondary,
    textDecoration: 'none',
    fontWeight: '500',
    transition: 'opacity 0.2s'
  },
  oddsBar: {
    display: 'flex',
    height: '40px',
    borderRadius: '10px',
    overflow: 'hidden',
    marginBottom: '12px',
    gap: '2px'
  },
  yesBar: {
    background: COLORS.gradientGreen,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#000',
    fontSize: '13px',
    fontWeight: '600',
    minWidth: '70px',
    borderRadius: '8px 0 0 8px'
  },
  noBar: {
    background: COLORS.gradientRed,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    fontSize: '13px',
    fontWeight: '600',
    minWidth: '70px',
    borderRadius: '0 8px 8px 0'
  },
  cardFooter: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '13px',
    color: COLORS.textMuted,
    marginBottom: '10px'
  },
  endDateRow: {
    fontSize: '11px',
    color: COLORS.textMuted,
    borderTop: `1px solid ${COLORS.border}`,
    paddingTop: '10px',
    marginTop: '4px'
  },
  footerStat: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px'
  },
  footerIcon: {
    display: 'flex',
    transform: 'scale(0.8)',
    opacity: 0.6
  },
  onchainBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '11px',
    color: COLORS.secondary,
    background: `${COLORS.secondary}15`,
    padding: '4px 8px',
    borderRadius: '6px',
    fontWeight: '500'
  },
  onchainIndicator: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px',
    padding: '12px 14px',
    background: `${COLORS.secondary}10`,
    borderRadius: '10px',
    marginBottom: '16px',
    border: `1px solid ${COLORS.secondary}30`,
    color: COLORS.secondary,
    fontSize: '13px',
    fontWeight: '500'
  },
  onchainSubtext: {
    fontSize: '11px',
    color: COLORS.textMuted,
    width: '100%',
    marginTop: '2px'
  },
  emptyState: {
    textAlign: 'center',
    padding: '60px 20px',
    color: COLORS.textMuted
  },
  emptyIcon: {
    display: 'flex',
    justifyContent: 'center',
    marginBottom: '16px',
    transform: 'scale(2.5)',
    opacity: 0.3
  },
  primaryBtn: {
    padding: '14px 28px',
    background: COLORS.gradientPrimary,
    border: 'none',
    borderRadius: '12px',
    color: '#000',
    fontSize: '15px',
    fontWeight: '600',
    cursor: 'pointer',
    marginTop: '16px',
    transition: 'all 0.2s ease'
  },
  formContainer: {
    maxWidth: '700px'
  },
  createMarketHeader: {
    marginBottom: '32px'
  },
  createMarketBadge: {
    marginBottom: '16px'
  },
  formSubtitle: {
    color: COLORS.textMuted,
    marginBottom: '24px',
    fontSize: '15px'
  },
  templateSection: {
    marginBottom: '24px'
  },
  templateGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: '12px',
    marginTop: '12px'
  },
  templateBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '8px',
    padding: '16px 12px',
    background: 'transparent',
    border: `1px solid ${COLORS.border}`,
    borderRadius: '12px',
    color: COLORS.textSecondary,
    cursor: 'pointer',
    transition: 'all 0.2s ease'
  },
  formCard: {
    background: COLORS.bgCard,
    borderRadius: '20px',
    padding: '32px',
    border: `1px solid ${COLORS.border}`
  },
  formSection: {
    marginBottom: '32px',
    paddingBottom: '32px',
    borderBottom: `1px solid ${COLORS.border}`
  },
  formSectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '20px'
  },
  formSectionTitle: {
    fontSize: '16px',
    fontWeight: '600',
    color: COLORS.textPrimary,
    fontFamily: 'Space Grotesk, sans-serif'
  },
  label: {
    display: 'block',
    fontSize: '13px',
    color: COLORS.textMuted,
    marginBottom: '8px',
    fontWeight: '500'
  },
  input: {
    width: '100%',
    padding: '14px 16px',
    background: `${COLORS.textPrimary}05`,
    border: `1px solid ${COLORS.borderLight}`,
    borderRadius: '12px',
    color: COLORS.textPrimary,
    fontSize: '15px',
    marginBottom: '16px',
    outline: 'none',
    transition: 'border-color 0.2s, box-shadow 0.2s',
    fontFamily: 'inherit'
  },
  resolutionGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '10px',
    marginBottom: '20px'
  },
  resolutionOption: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '14px',
    background: 'transparent',
    border: `1px solid ${COLORS.border}`,
    borderRadius: '12px',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    textAlign: 'left',
    color: COLORS.textSecondary
  },
  formRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '16px'
  },
  formCol: {},
  royaltyInfoBox: {
    padding: '20px',
    background: `${COLORS.primary}08`,
    border: `1px solid ${COLORS.primary}25`,
    borderRadius: '14px',
    marginBottom: '20px'
  },
  walletConnectedBox: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 16px',
    background: `${COLORS.success}10`,
    borderRadius: '10px',
    fontSize: '13px',
    color: COLORS.textSecondary,
    marginBottom: '20px'
  },
  createSubmitBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '10px',
    width: '100%',
    padding: '18px',
    background: COLORS.gradientPrimary,
    border: 'none',
    borderRadius: '14px',
    color: '#000',
    fontSize: '16px',
    fontWeight: '700',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    fontFamily: 'Space Grotesk, sans-serif'
  },
  creatorNote: {
    fontSize: '13px',
    color: COLORS.textMuted,
    marginBottom: '16px'
  },
  emptyStateIcon: {
    marginBottom: '20px'
  },
  leaderboardContainer: {
    maxWidth: '800px'
  },
  leaderboardTable: {
    background: COLORS.bgCard,
    borderRadius: '16px',
    border: `1px solid ${COLORS.border}`,
    overflow: 'hidden'
  },
  leaderboardHeader: {
    display: 'flex',
    padding: '16px 20px',
    background: `${COLORS.textPrimary}03`,
    fontSize: '12px',
    fontWeight: '600',
    color: COLORS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: '0.5px'
  },
  leaderboardRow: {
    display: 'flex',
    padding: '16px 20px',
    borderBottom: `1px solid ${COLORS.border}`,
    fontSize: '14px',
    color: COLORS.textPrimary,
    transition: 'background 0.2s'
  },
  modalOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0, 0, 0, 0.85)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000
  },
  modal: {
    background: COLORS.bgCard,
    borderRadius: '20px',
    padding: '28px',
    width: '420px',
    maxWidth: '90vw',
    border: `1px solid ${COLORS.borderLight}`,
    boxShadow: `0 25px 50px -12px rgba(0, 0, 0, 0.5)`
  },
  modalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px'
  },
  closeBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    color: COLORS.textMuted,
    cursor: 'pointer',
    padding: '4px',
    borderRadius: '8px',
    transition: 'all 0.2s'
  },
  modalQuestion: {
    fontSize: '16px',
    color: COLORS.textSecondary,
    marginBottom: '16px',
    lineHeight: '1.5'
  },
  modalDetails: {
    background: `${COLORS.textPrimary}03`,
    borderRadius: '10px',
    padding: '12px 14px',
    marginBottom: '16px',
    border: `1px solid ${COLORS.border}`
  },
  modalDetailRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: '6px 0',
    fontSize: '12px',
    gap: '12px'
  },
  modalDetailLabel: {
    color: COLORS.textMuted,
    fontWeight: '500',
    flexShrink: 0
  },
  modalDetailValue: {
    color: COLORS.textSecondary,
    textAlign: 'right',
    wordBreak: 'break-word'
  },
  txStatus: {
    padding: '12px 16px',
    borderRadius: '10px',
    marginBottom: '16px',
    border: '1px solid',
    fontSize: '14px',
    fontWeight: '500'
  },
  connectPrompt: {
    textAlign: 'center',
    padding: '20px',
    color: COLORS.textMuted
  },
  balanceDisplay: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '14px 16px',
    background: `${COLORS.textPrimary}03`,
    borderRadius: '10px',
    marginBottom: '16px',
    fontSize: '14px',
    color: COLORS.textSecondary
  },
  betButtons: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px'
  },
  yesBtn: {
    padding: '16px',
    background: COLORS.gradientGreen,
    border: 'none',
    borderRadius: '12px',
    color: '#000',
    fontSize: '16px',
    fontWeight: '700',
    cursor: 'pointer',
    transition: 'all 0.2s ease'
  },
  noBtn: {
    padding: '16px',
    background: COLORS.gradientRed,
    border: 'none',
    borderRadius: '12px',
    color: '#fff',
    fontSize: '16px',
    fontWeight: '700',
    cursor: 'pointer',
    transition: 'all 0.2s ease'
  },

  // Landing Page Styles - PolyClaw-Inspired
  landingPage: {
    minHeight: '100vh',
    background: COLORS.bgDark,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '60px 20px',
    position: 'relative',
    overflow: 'hidden'
  },
  meshGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: COLORS.gradientMesh,
    pointerEvents: 'none'
  },
  landingHero: {
    maxWidth: '800px',
    textAlign: 'center',
    position: 'relative',
    zIndex: 1
  },
  heroBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 16px',
    background: 'rgba(20, 241, 149, 0.08)',
    border: `1px solid ${COLORS.borderGlow}`,
    borderRadius: '100px',
    fontSize: '13px',
    color: COLORS.textSecondary,
    marginBottom: '24px',
    fontFamily: 'JetBrains Mono, monospace',
    letterSpacing: '0.5px'
  },
  landingTitle: {
    fontSize: '56px',
    fontWeight: '800',
    color: COLORS.textPrimary,
    marginBottom: '20px',
    lineHeight: 1.1,
    fontFamily: 'Space Grotesk, sans-serif',
    letterSpacing: '-1px'
  },
  landingSubtitle: {
    fontSize: '18px',
    color: COLORS.textSecondary,
    marginBottom: '48px',
    lineHeight: 1.7,
    maxWidth: '550px',
    margin: '0 auto 48px'
  },
  metricsRow: {
    display: 'flex',
    gap: '20px',
    justifyContent: 'center',
    marginBottom: '48px',
    flexWrap: 'wrap'
  },
  metricCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '24px 32px',
    background: 'rgba(13, 13, 22, 0.6)',
    backdropFilter: 'blur(20px)',
    border: `1px solid ${COLORS.border}`,
    borderRadius: '16px',
    minWidth: '140px',
    transition: 'all 0.3s ease'
  },
  heroImageContainer: {
    marginBottom: '40px',
    borderRadius: '16px',
    overflow: 'hidden',
    boxShadow: `0 30px 80px rgba(0, 0, 0, 0.6), 0 0 60px ${COLORS.primaryGlow}`
  },
  heroImage: {
    width: '100%',
    maxWidth: '600px',
    height: 'auto',
    display: 'block',
    borderRadius: '16px',
    border: `1px solid ${COLORS.borderLight}`
  },
  landingChoiceContainer: {
    marginBottom: '40px'
  },
  landingChoiceLabel: {
    fontSize: '14px',
    color: COLORS.textMuted,
    marginBottom: '20px',
    textTransform: 'uppercase',
    letterSpacing: '2px',
    fontFamily: 'JetBrains Mono, monospace'
  },
  landingChoiceButtons: {
    display: 'flex',
    gap: '24px',
    justifyContent: 'center'
  },
  landingChoiceBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '28px 44px',
    background: 'rgba(13, 13, 22, 0.6)',
    backdropFilter: 'blur(20px)',
    border: `1px solid ${COLORS.border}`,
    borderRadius: '20px',
    cursor: 'pointer',
    transition: 'all 0.3s ease',
    color: COLORS.textPrimary,
    minWidth: '200px'
  },
  landingChoiceBtnActive: {
    borderColor: COLORS.primary,
    background: `${COLORS.primaryGlow}`,
    boxShadow: `0 0 40px ${COLORS.primaryGlow}, inset 0 0 30px ${COLORS.primaryGlow}`
  },
  landingInstructions: {
    background: 'rgba(13, 13, 22, 0.6)',
    backdropFilter: 'blur(20px)',
    borderRadius: '24px',
    padding: '36px',
    border: `1px solid ${COLORS.border}`,
    textAlign: 'left',
    marginBottom: '40px',
    maxWidth: '500px',
    margin: '0 auto 40px'
  },
  instructionsTitle: {
    fontSize: '14px',
    fontWeight: '600',
    color: COLORS.primary,
    marginBottom: '28px',
    textAlign: 'center',
    letterSpacing: '3px',
    fontFamily: 'JetBrains Mono, monospace'
  },
  instructionSteps: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
    marginBottom: '28px'
  },
  instructionStep: {
    display: 'flex',
    gap: '20px',
    alignItems: 'flex-start'
  },
  stepNumber: {
    minWidth: '36px',
    height: '36px',
    borderRadius: '10px',
    background: 'transparent',
    border: `1px solid ${COLORS.borderLight}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '14px',
    fontWeight: '700',
    color: COLORS.primary,
    flexShrink: 0,
    fontFamily: 'JetBrains Mono, monospace'
  },
  codeBlock: {
    background: COLORS.bgDark,
    borderRadius: '14px',
    padding: '20px',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: '13px',
    color: COLORS.primary,
    marginBottom: '28px',
    textAlign: 'left',
    border: `1px solid ${COLORS.border}`,
    lineHeight: 1.8
  },
  landingCTABtn: {
    width: '100%',
    padding: '18px 36px',
    background: COLORS.gradientPrimary,
    border: 'none',
    borderRadius: '14px',
    fontSize: '16px',
    fontWeight: '700',
    color: '#000',
    cursor: 'pointer',
    transition: 'all 0.3s ease',
    fontFamily: 'Space Grotesk, sans-serif',
    letterSpacing: '0.5px'
  },
  poweredBy: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '32px'
  },
  poweredByLogos: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px'
  },
  landingStats: {
    display: 'flex',
    justifyContent: 'center',
    gap: '40px',
    marginBottom: '32px'
  },
  landingStat: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center'
  },
  landingStatValue: {
    fontSize: '28px',
    fontWeight: '700',
    color: COLORS.primary,
    fontFamily: 'JetBrains Mono, monospace'
  },
  landingStatLabel: {
    fontSize: '13px',
    color: COLORS.textMuted
  },
  landingFooter: {
    fontSize: '14px',
    color: COLORS.textMuted,
    marginTop: '20px'
  }
}

export default App
