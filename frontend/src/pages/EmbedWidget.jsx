/**
 * EmbedWidget - Lightweight embeddable market card for platform integration
 * 
 * Designed to be loaded in an iframe on partner platforms (Moltbook, Pump.fun, etc.)
 * No wallet adapter required - read-only display with CTA link to full app
 * 
 * URL: /embed/:marketId
 * Params: ?theme=dark|light&compact=true|false
 */

import React, { useState, useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'

const API_BASE = import.meta.env.VITE_API_URL || '/api'
const APP_BASE = import.meta.env.VITE_APP_URL || 'https://agentbets.gg'

// Theme colors
const THEMES = {
  dark: {
    bg: '#08080F',
    bgCard: '#0D0D16',
    border: 'rgba(255, 255, 255, 0.08)',
    borderLight: 'rgba(255, 255, 255, 0.12)',
    textPrimary: '#FFFFFF',
    textSecondary: '#D0D0DC',
    textMuted: '#9090A8',
    primary: '#14F195',
    primaryGlow: 'rgba(20, 241, 149, 0.15)',
    secondary: '#9945FF',
    success: '#14F195',
    error: '#FF4757',
    warning: '#FFBE0B',
    gradientPrimary: 'linear-gradient(135deg, #14F195 0%, #9945FF 100%)',
  },
  light: {
    bg: '#F8F9FA',
    bgCard: '#FFFFFF',
    border: 'rgba(0, 0, 0, 0.08)',
    borderLight: 'rgba(0, 0, 0, 0.12)',
    textPrimary: '#1A1A2E',
    textSecondary: '#4A4A5A',
    textMuted: '#8A8A9A',
    primary: '#0a8f5a',
    primaryGlow: 'rgba(10, 143, 90, 0.12)',
    secondary: '#7a35d4',
    success: '#0a8f5a',
    error: '#DC3545',
    warning: '#FFC107',
    gradientPrimary: 'linear-gradient(135deg, #0a8f5a 0%, #7a35d4 100%)',
  }
}

function formatTimeRemaining(endDate) {
  const now = new Date()
  const end = new Date(endDate)
  const diff = end - now

  if (diff <= 0) return 'Ended'

  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function formatVolume(lamports) {
  const usdc = (lamports || 0) / 1_000_000
  if (usdc >= 1000) return `$${(usdc / 1000).toFixed(1)}K`
  if (usdc >= 1) return `$${usdc.toFixed(0)}`
  return '$0'
}

function getCategoryIcon(category) {
  const icons = {
    'token': '\u{1F4B0}',
    'performance': '\u{1F4CA}',
    'milestone': '\u{1F3AF}',
    'competition': '\u{1F3C6}',
    'head-to-head': '\u2694\uFE0F',
    'app': '\u{1F4F1}',
    'general': '\u{1F52E}'
  }
  return icons[category] || icons['general']
}

export default function EmbedWidget() {
  const { marketId } = useParams()
  const [searchParams] = useSearchParams()
  const [market, setMarket] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const themeName = searchParams.get('theme') || 'dark'
  const compact = searchParams.get('compact') === 'true'
  const colors = THEMES[themeName] || THEMES.dark

  useEffect(() => {
    async function fetchMarket() {
      try {
        const res = await fetch(`${API_BASE}/markets/${marketId}`)
        if (!res.ok) throw new Error('Market not found')
        const data = await res.json()
        setMarket(data)
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    if (marketId) fetchMarket()
  }, [marketId])

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!marketId) return
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/markets/${marketId}`)
        if (res.ok) {
          const data = await res.json()
          setMarket(data)
        }
      } catch (e) { /* silent refresh */ }
    }, 30000)
    return () => clearInterval(interval)
  }, [marketId])

  if (loading) {
    return (
      <div style={{ ...styles.container(colors), justifyContent: 'center', alignItems: 'center' }}>
        <div style={styles.spinner(colors)} />
      </div>
    )
  }

  if (error || !market) {
    return (
      <div style={{ ...styles.container(colors), justifyContent: 'center', alignItems: 'center' }}>
        <p style={{ color: colors.textMuted, fontSize: '14px' }}>
          {error || 'Market not found'}
        </p>
      </div>
    )
  }

  const yesOdds = market.yesOdds !== undefined ? (market.yesOdds * 100).toFixed(0) : '50'
  const noOdds = market.noOdds !== undefined ? (market.noOdds * 100).toFixed(0) : '50'
  const isResolved = market.status === 'resolved'
  const isPending = market.status === 'pending_confirmation'
  const timeRemaining = formatTimeRemaining(market.endDate)
  const volume = formatVolume(market.totalVolume)
  const betUrl = `${APP_BASE}/app?market=${market.id}`

  if (compact) {
    return (
      <div style={styles.container(colors)}>
        <div style={styles.compactCard(colors)}>
          <div style={styles.compactTop}>
            <span style={{ fontSize: '12px', color: colors.textMuted }}>
              {getCategoryIcon(market.category)} {market.category}
            </span>
            <span style={{
              fontSize: '11px',
              fontWeight: '600',
              color: isResolved ? colors.success : (timeRemaining === 'Ended' ? colors.error : colors.warning),
            }}>
              {isResolved ? `Resolved: ${market.resolution}` : timeRemaining}
            </span>
          </div>
          <p style={styles.compactQuestion(colors)}>{market.question}</p>
          <div style={styles.compactBottom}>
            <div style={styles.oddsCompact}>
              <span style={{ color: colors.success, fontWeight: '700', fontSize: '14px' }}>
                YES {yesOdds}%
              </span>
              <span style={{ color: colors.textMuted, margin: '0 6px' }}>/</span>
              <span style={{ color: colors.error, fontWeight: '700', fontSize: '14px' }}>
                NO {noOdds}%
              </span>
            </div>
            <a href={betUrl} target="_blank" rel="noopener noreferrer" style={styles.compactCta(colors)}>
              Bet
            </a>
          </div>
        </div>
        <div style={styles.branding(colors)}>
          Powered by <a href={APP_BASE} target="_blank" rel="noopener noreferrer" style={{ color: colors.primary, textDecoration: 'none', fontWeight: '600' }}>AgentBets</a>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.container(colors)}>
      <div style={styles.card(colors)}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.categoryBadge(colors)}>
            {getCategoryIcon(market.category)} {market.category}
          </span>
          <span style={{
            ...styles.statusBadge,
            color: isResolved ? colors.success : isPending ? colors.warning : colors.textMuted,
            background: isResolved ? `${colors.success}15` : isPending ? `${colors.warning}15` : `${colors.textMuted}15`,
          }}>
            {isResolved ? `Resolved: ${market.resolution}` : isPending ? 'Pending' : timeRemaining}
          </span>
        </div>

        {/* Question */}
        <h3 style={styles.question(colors)}>{market.question}</h3>

        {/* Odds Bars */}
        <div style={styles.oddsContainer}>
          <div style={styles.oddsRow}>
            <div style={styles.oddsLabel}>
              <span style={{ color: colors.success, fontWeight: '700' }}>YES</span>
              <span style={{ color: colors.textSecondary, fontSize: '14px', fontWeight: '700' }}>{yesOdds}%</span>
            </div>
            <div style={styles.oddsBarTrack(colors)}>
              <div style={{
                ...styles.oddsBarFill,
                width: `${yesOdds}%`,
                background: `linear-gradient(90deg, ${colors.success}40, ${colors.success})`,
              }} />
            </div>
          </div>
          <div style={styles.oddsRow}>
            <div style={styles.oddsLabel}>
              <span style={{ color: colors.error, fontWeight: '700' }}>NO</span>
              <span style={{ color: colors.textSecondary, fontSize: '14px', fontWeight: '700' }}>{noOdds}%</span>
            </div>
            <div style={styles.oddsBarTrack(colors)}>
              <div style={{
                ...styles.oddsBarFill,
                width: `${noOdds}%`,
                background: `linear-gradient(90deg, ${colors.error}40, ${colors.error})`,
              }} />
            </div>
          </div>
        </div>

        {/* Stats Row */}
        <div style={styles.statsRow(colors)}>
          <span style={{ color: colors.textMuted, fontSize: '12px' }}>
            {volume} volume
          </span>
          <span style={{ color: colors.textMuted, fontSize: '12px' }}>
            {market.totalBets || 0} bets
          </span>
          {market.onChain && (
            <span style={{ fontSize: '11px', color: colors.primary, background: `${colors.primary}15`, padding: '2px 8px', borderRadius: '4px' }}>
              On-chain
            </span>
          )}
        </div>

        {/* CTA Button */}
        <a
          href={betUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={styles.ctaButton(colors)}
        >
          {isResolved ? 'View on AgentBets' : 'Bet on AgentBets'}
        </a>
      </div>

      {/* Branding */}
      <div style={styles.branding(colors)}>
        Powered by <a href={APP_BASE} target="_blank" rel="noopener noreferrer" style={{ color: colors.primary, textDecoration: 'none', fontWeight: '600' }}>AgentBets</a>
      </div>
    </div>
  )
}

const styles = {
  container: (c) => ({
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    background: c.bg,
    padding: '12px',
    minHeight: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
  }),
  card: (c) => ({
    background: c.bgCard,
    borderRadius: '16px',
    padding: '20px',
    border: `1px solid ${c.border}`,
    flex: 1,
  }),
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '12px',
  },
  categoryBadge: (c) => ({
    fontSize: '12px',
    color: c.textMuted,
    textTransform: 'capitalize',
  }),
  statusBadge: {
    fontSize: '11px',
    fontWeight: '600',
    padding: '4px 10px',
    borderRadius: '8px',
  },
  question: (c) => ({
    fontSize: '15px',
    fontWeight: '600',
    lineHeight: '1.5',
    marginBottom: '16px',
    marginTop: 0,
    color: c.textPrimary,
    display: '-webkit-box',
    WebkitLineClamp: 3,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  }),
  oddsContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    marginBottom: '16px',
  },
  oddsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  oddsLabel: {
    display: 'flex',
    justifyContent: 'space-between',
    width: '70px',
    fontSize: '13px',
    flexShrink: 0,
  },
  oddsBarTrack: (c) => ({
    flex: 1,
    height: '8px',
    borderRadius: '4px',
    background: `${c.border}`,
    overflow: 'hidden',
  }),
  oddsBarFill: {
    height: '100%',
    borderRadius: '4px',
    transition: 'width 0.5s ease',
  },
  statsRow: (c) => ({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px',
    paddingTop: '12px',
    borderTop: `1px solid ${c.border}`,
  }),
  ctaButton: (c) => ({
    display: 'block',
    width: '100%',
    padding: '12px',
    borderRadius: '12px',
    background: c.gradientPrimary,
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: '14px',
    textAlign: 'center',
    textDecoration: 'none',
    boxSizing: 'border-box',
    transition: 'opacity 0.2s ease',
  }),
  branding: (c) => ({
    textAlign: 'center',
    fontSize: '11px',
    color: c.textMuted,
    marginTop: '8px',
    padding: '4px 0',
  }),
  // Compact styles
  compactCard: (c) => ({
    background: c.bgCard,
    borderRadius: '12px',
    padding: '14px',
    border: `1px solid ${c.border}`,
    flex: 1,
  }),
  compactTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '8px',
  },
  compactQuestion: (c) => ({
    fontSize: '13px',
    fontWeight: '600',
    lineHeight: '1.4',
    margin: '0 0 10px 0',
    color: c.textPrimary,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  }),
  compactBottom: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  oddsCompact: {
    display: 'flex',
    alignItems: 'center',
  },
  compactCta: (c) => ({
    padding: '6px 16px',
    borderRadius: '8px',
    background: c.gradientPrimary,
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: '12px',
    textDecoration: 'none',
  }),
  spinner: (c) => ({
    width: '24px',
    height: '24px',
    border: `2px solid ${c.border}`,
    borderTopColor: c.primary,
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  }),
}

// Inject keyframes for spinner
if (typeof document !== 'undefined') {
  const styleTag = document.createElement('style')
  styleTag.textContent = `
    @keyframes spin { to { transform: rotate(360deg) } }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body, #root { height: 100%; }
  `
  document.head.appendChild(styleTag)
}
