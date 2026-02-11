/**
 * AgentBets Partner Page
 * Partners connect wallet, apply for an integration API key, and check status.
 * Approval is required by admin before the key is activated.
 */

import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'

const API_BASE = import.meta.env.VITE_API_URL || '/api'

const COLORS = {
  bgDark: '#0a0a12',
  bgCard: '#0d0d16',
  bgCardHover: '#12121d',
  primary: '#14F195',
  primaryDark: '#0a8f5a',
  secondary: '#9945FF',
  accent: '#00D1FF',
  success: '#14F195',
  error: '#FF4757',
  warning: '#FFBE0B',
  textPrimary: '#ffffff',
  textSecondary: '#a0aec0',
  textMuted: '#5a6578',
  border: 'rgba(255,255,255,0.06)',
  borderLight: 'rgba(255,255,255,0.12)',
  gradientPrimary: 'linear-gradient(135deg, #14F195 0%, #9945FF 100%)',
  gradientMesh: 'radial-gradient(ellipse 80% 50% at 50% -20%, rgba(20, 241, 149, 0.15), transparent), radial-gradient(ellipse 60% 40% at 100% 0%, rgba(153, 69, 255, 0.1), transparent)'
}

const VALID_CATEGORIES = ['competition', 'performance', 'token', 'milestone', 'head-to-head', 'app', 'general']

export default function PartnerPage() {
  const navigate = useNavigate()
  const { publicKey, connected, signMessage } = useWallet()

  const [appStatus, setAppStatus] = useState(null) // null = loading, false = no app, object = application data
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)
  const [copied, setCopied] = useState(false)

  // Form state
  const [platformName, setPlatformName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [platformDescription, setPlatformDescription] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [selectedCategories, setSelectedCategories] = useState([])

  // Check application status when wallet connects
  const checkStatus = useCallback(async () => {
    if (!connected || !publicKey) {
      setAppStatus(null)
      return
    }

    try {
      const res = await fetch(`${API_BASE}/partner/status?wallet=${publicKey.toString()}`)
      const data = await res.json()
      if (data.found) {
        setAppStatus(data)
      } else {
        setAppStatus(false)
      }
    } catch (err) {
      console.error('Failed to check status:', err)
      setAppStatus(false)
    }
  }, [connected, publicKey])

  useEffect(() => {
    checkStatus()
  }, [checkStatus])

  // Submit application
  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!connected || !publicKey || !signMessage) {
      setError('Please connect your wallet first')
      return
    }

    if (!platformName.trim()) {
      setError('Platform name is required')
      return
    }

    setLoading(true)
    setError(null)
    setSuccess(null)

    try {
      // 1. Get challenge
      const challengeRes = await fetch(`${API_BASE}/partner/challenge?wallet=${publicKey.toString()}`)
      if (!challengeRes.ok) {
        const errData = await challengeRes.json()
        throw new Error(errData.error || 'Failed to get challenge')
      }
      const { message } = await challengeRes.json()

      // 2. Sign the challenge
      const encoded = new TextEncoder().encode(message)
      const signatureBytes = await signMessage(encoded)

      // 3. Encode signature as base58
      const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
      const encodeBase58 = (bytes) => {
        const uint = new Uint8Array(bytes)
        let num = BigInt(0)
        for (const b of uint) num = num * 256n + BigInt(b)
        let result = ''
        while (num > 0n) {
          result = ALPHABET[Number(num % 58n)] + result
          num = num / 58n
        }
        for (let i = 0; i < uint.length && uint[i] === 0; i++) result = '1' + result
        return result
      }
      const signature = encodeBase58(signatureBytes)

      // 4. Parse tags
      const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean)

      // 5. Submit application
      const res = await fetch(`${API_BASE}/partner/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: publicKey.toString(),
          signature,
          message,
          platformName: platformName.trim(),
          contactEmail: contactEmail.trim() || undefined,
          platformDescription: platformDescription.trim() || undefined,
          tagsFilter: tags.length > 0 ? tags : undefined,
          categoriesFilter: selectedCategories.length > 0 ? selectedCategories : undefined
        })
      })

      const data = await res.json()
      if (res.ok && data.success) {
        setSuccess(data.message)
        checkStatus()
      } else {
        setError(data.error || 'Failed to submit application')
      }
    } catch (err) {
      if (err.message.includes('User rejected')) {
        setError('Signature was rejected. Please try again and approve the message signing.')
      } else {
        setError(err.message)
      }
    } finally {
      setLoading(false)
    }
  }

  const copyApiKey = () => {
    if (appStatus?.apiKey) {
      navigator.clipboard.writeText(appStatus.apiKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const toggleCategory = (cat) => {
    setSelectedCategories(prev =>
      prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]
    )
  }

  // Render helper for status states
  const renderStatusContent = () => {
    if (!connected) {
      return renderHero()
    }

    if (appStatus === null) {
      return (
        <div style={styles.centerBox}>
          <div style={styles.spinner} />
          <p style={{ color: COLORS.textMuted, marginTop: '16px' }}>Checking application status...</p>
        </div>
      )
    }

    if (appStatus === false) {
      return renderApplicationForm()
    }

    // Has an application
    switch (appStatus.status) {
      case 'pending':
        return renderPendingStatus()
      case 'approved':
      case 'active':
        return renderApprovedStatus()
      case 'rejected':
        return renderRejectedStatus()
      default:
        return renderApplicationForm()
    }
  }

  const renderHero = () => (
    <div style={styles.heroSection}>
      <div style={styles.badge}>Platform Integration</div>
      <h1 style={styles.title}>Become an AgentBets Partner</h1>
      <p style={styles.subtitle}>
        Integrate prediction markets into your platform. Display markets, let users bet,
        and filter by topics relevant to your audience.
      </p>

      <div style={styles.benefitsGrid}>
        <div style={styles.benefitCard}>
          <div style={styles.benefitIcon}>{'\u{1F4CA}'}</div>
          <h3 style={styles.benefitTitle}>Market Feed API</h3>
          <p style={styles.benefitText}>Poll for new markets with tag and category filtering</p>
        </div>
        <div style={styles.benefitCard}>
          <div style={styles.benefitIcon}>{'\u{1F3AF}'}</div>
          <h3 style={styles.benefitTitle}>Embed Widget</h3>
          <p style={styles.benefitText}>Drop an iframe into your UI for instant market cards</p>
        </div>
        <div style={styles.benefitCard}>
          <div style={styles.benefitIcon}>{'\u26A1'}</div>
          <h3 style={styles.benefitTitle}>Blinks Transaction API</h3>
          <p style={styles.benefitText}>Let users bet inline via Solana Actions</p>
        </div>
      </div>

      <div style={styles.ctaSection}>
        <p style={{ color: COLORS.textSecondary, marginBottom: '16px', fontSize: '15px' }}>
          Connect your wallet to apply for a platform API key
        </p>
        <WalletMultiButton style={styles.walletButton} />
      </div>

      <div style={styles.docsLink}>
        <a href="/integrate.md" target="_blank" rel="noopener noreferrer" style={{ color: COLORS.primary, textDecoration: 'none' }}>
          Read the full integration guide {'\u2192'}
        </a>
      </div>
    </div>
  )

  const renderApplicationForm = () => (
    <div style={styles.formSection}>
      <div style={styles.badge}>Step 1 of 2</div>
      <h2 style={styles.formTitle}>Apply for API Access</h2>
      <p style={styles.formSubtext}>
        Fill out the form below and sign with your wallet to verify ownership.
        The AgentBets team will review your application.
      </p>

      <div style={styles.connectedWallet}>
        Connected: <span style={styles.walletAddr}>{publicKey?.toString().substring(0, 6)}...{publicKey?.toString().slice(-4)}</span>
        <WalletMultiButton style={styles.walletButtonSmall} />
      </div>

      {error && <div style={styles.errorBox}>{error}</div>}
      {success && <div style={styles.successBox}>{success}</div>}

      <form onSubmit={handleSubmit} style={styles.form}>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>Platform Name *</label>
          <input
            type="text"
            value={platformName}
            onChange={(e) => setPlatformName(e.target.value)}
            placeholder="e.g., Moltbook, MyDApp"
            style={styles.input}
            maxLength={100}
            required
          />
        </div>

        <div style={styles.fieldGroup}>
          <label style={styles.label}>Contact Email</label>
          <input
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="you@example.com"
            style={styles.input}
            maxLength={255}
          />
        </div>

        <div style={styles.fieldGroup}>
          <label style={styles.label}>Integration Description</label>
          <textarea
            value={platformDescription}
            onChange={(e) => setPlatformDescription(e.target.value)}
            placeholder="Tell us how you plan to use AgentBets markets on your platform..."
            style={styles.textarea}
            maxLength={1000}
            rows={4}
          />
          <span style={styles.charCount}>{platformDescription.length}/1000</span>
        </div>

        <div style={styles.fieldGroup}>
          <label style={styles.label}>Tag Filters</label>
          <input
            type="text"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="Comma-separated, e.g., moltbook, token-market, pumpfun"
            style={styles.input}
          />
          <span style={styles.hint}>Markets matching these tags will be highlighted in your feed</span>
        </div>

        <div style={styles.fieldGroup}>
          <label style={styles.label}>Category Filters</label>
          <div style={styles.chipGroup}>
            {VALID_CATEGORIES.map(cat => (
              <button
                type="button"
                key={cat}
                style={{
                  ...styles.chip,
                  ...(selectedCategories.includes(cat) ? styles.chipSelected : {})
                }}
                onClick={() => toggleCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>
          <span style={styles.hint}>Select categories relevant to your platform (optional)</span>
        </div>

        <button
          type="submit"
          style={{
            ...styles.submitButton,
            opacity: loading ? 0.6 : 1,
            cursor: loading ? 'wait' : 'pointer'
          }}
          disabled={loading}
        >
          {loading ? 'Signing & Submitting...' : 'Sign & Submit Application'}
        </button>
      </form>
    </div>
  )

  const renderPendingStatus = () => (
    <div style={styles.statusSection}>
      <div style={{ ...styles.statusIcon, background: `${COLORS.warning}20` }}>
        <span style={{ fontSize: '48px' }}>{'\u23F3'}</span>
      </div>
      <h2 style={styles.statusTitle}>Application Pending</h2>
      <p style={styles.statusText}>
        Your application for <strong>{appStatus.platformName}</strong> is under review.
        The AgentBets team will approve or reject it shortly.
      </p>

      <div style={styles.statusCard}>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Platform</span>
          <span style={styles.statusValue}>{appStatus.platformName}</span>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Applied</span>
          <span style={styles.statusValue}>{new Date(appStatus.createdAt).toLocaleDateString()}</span>
        </div>
        {appStatus.tagsFilter && appStatus.tagsFilter.length > 0 && (
          <div style={styles.statusRow}>
            <span style={styles.statusLabel}>Tags</span>
            <span style={styles.statusValue}>{appStatus.tagsFilter.join(', ')}</span>
          </div>
        )}
      </div>

      <p style={{ color: COLORS.textMuted, fontSize: '13px', marginTop: '24px' }}>
        Questions? Reach out to <a href="https://x.com/AgentBetsBot" target="_blank" rel="noopener noreferrer" style={{ color: COLORS.primary, textDecoration: 'none' }}>@AgentBetsBot</a> on X.
      </p>
    </div>
  )

  const renderApprovedStatus = () => (
    <div style={styles.statusSection}>
      <div style={{ ...styles.statusIcon, background: `${COLORS.success}20` }}>
        <span style={{ fontSize: '48px' }}>{'\u2705'}</span>
      </div>
      <h2 style={styles.statusTitle}>Application Approved!</h2>
      <p style={styles.statusText}>
        Your platform <strong>{appStatus.platformName}</strong> has been approved.
        Here is your API key:
      </p>

      <div style={styles.apiKeyBox}>
        <code style={styles.apiKeyText}>{appStatus.apiKey}</code>
        <button onClick={copyApiKey} style={styles.copyButton}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>

      <div style={styles.warningBox}>
        Store this key securely. It will always be visible here when you connect your wallet,
        but do not share it publicly.
      </div>

      <div style={styles.statusCard}>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Permissions</span>
          <span style={styles.statusValue}>{(appStatus.permissions || []).join(', ')}</span>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Rate Limit</span>
          <span style={styles.statusValue}>{appStatus.rateLimitPerMinute} requests/min</span>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Approved</span>
          <span style={styles.statusValue}>{appStatus.reviewedAt ? new Date(appStatus.reviewedAt).toLocaleDateString() : 'Active'}</span>
        </div>
      </div>

      <h3 style={{ ...styles.formTitle, fontSize: '18px', marginTop: '32px' }}>Quick Start</h3>
      <div style={styles.codeBlock}>
        <code>{`curl -H "X-API-Key: YOUR_KEY" \\
  ${window.location.origin}/api/markets/feed?status=active`}</code>
      </div>

      <div style={styles.docsLink}>
        <a href="/integrate.md" target="_blank" rel="noopener noreferrer" style={{ color: COLORS.primary, textDecoration: 'none' }}>
          Read the full integration guide {'\u2192'}
        </a>
      </div>
    </div>
  )

  const renderRejectedStatus = () => (
    <div style={styles.statusSection}>
      <div style={{ ...styles.statusIcon, background: `${COLORS.error}20` }}>
        <span style={{ fontSize: '48px' }}>{'\u274C'}</span>
      </div>
      <h2 style={styles.statusTitle}>Application Not Approved</h2>
      <p style={styles.statusText}>
        Unfortunately, your application for <strong>{appStatus.platformName}</strong> was not approved.
      </p>

      {appStatus.rejectionReason && (
        <div style={{ ...styles.warningBox, borderColor: COLORS.error, background: `${COLORS.error}10` }}>
          <strong>Reason:</strong> {appStatus.rejectionReason}
        </div>
      )}

      <p style={{ color: COLORS.textMuted, fontSize: '14px', marginTop: '24px' }}>
        If you believe this was a mistake or want to discuss, reach out to{' '}
        <a href="https://x.com/AgentBetsBot" target="_blank" rel="noopener noreferrer" style={{ color: COLORS.primary, textDecoration: 'none' }}>@AgentBetsBot</a> on X.
      </p>
    </div>
  )

  return (
    <div style={styles.page}>
      <div style={styles.meshBg} />

      {/* Header */}
      <header style={styles.header}>
        <div style={styles.logo} onClick={() => navigate('/')}>
          <span style={styles.logoIcon}>{'\u{1F52E}'}</span>
          <span style={styles.logoText}>AgentBets</span>
        </div>
        <div style={styles.headerRight}>
          <button onClick={() => navigate('/app')} style={styles.headerLink}>Markets</button>
          {connected && <WalletMultiButton style={styles.walletButtonSmall} />}
        </div>
      </header>

      {/* Main Content */}
      <main style={styles.main}>
        {renderStatusContent()}
      </main>

      {/* Footer */}
      <footer style={styles.footer}>
        <span style={{ color: COLORS.textMuted, fontSize: '13px' }}>
          AgentBets - Prediction Markets for AI Agents on Solana
        </span>
      </footer>
    </div>
  )
}

const styles = {
  page: {
    minHeight: '100vh',
    background: COLORS.bgDark,
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    color: COLORS.textPrimary,
    position: 'relative',
    overflow: 'hidden',
  },
  meshBg: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    background: COLORS.gradientMesh,
    pointerEvents: 'none',
    zIndex: 0,
  },
  header: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '20px 40px',
    borderBottom: `1px solid ${COLORS.border}`,
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    cursor: 'pointer',
  },
  logoIcon: { fontSize: '24px' },
  logoText: {
    fontSize: '20px',
    fontWeight: '800',
    background: COLORS.gradientPrimary,
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
  },
  headerLink: {
    background: 'none',
    border: 'none',
    color: COLORS.textSecondary,
    fontSize: '14px',
    cursor: 'pointer',
    padding: '8px 16px',
    borderRadius: '8px',
    transition: 'color 0.2s',
  },
  main: {
    position: 'relative',
    zIndex: 1,
    maxWidth: '720px',
    margin: '0 auto',
    padding: '48px 24px 80px',
  },
  footer: {
    position: 'relative',
    zIndex: 1,
    textAlign: 'center',
    padding: '24px',
    borderTop: `1px solid ${COLORS.border}`,
  },
  // Hero
  heroSection: {
    textAlign: 'center',
  },
  badge: {
    display: 'inline-block',
    padding: '6px 16px',
    borderRadius: '20px',
    background: `${COLORS.primary}15`,
    color: COLORS.primary,
    fontSize: '13px',
    fontWeight: '600',
    marginBottom: '24px',
  },
  title: {
    fontSize: '42px',
    fontWeight: '800',
    lineHeight: '1.2',
    marginBottom: '16px',
    background: COLORS.gradientPrimary,
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  subtitle: {
    fontSize: '17px',
    lineHeight: '1.6',
    color: COLORS.textSecondary,
    maxWidth: '560px',
    margin: '0 auto 40px',
  },
  benefitsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '16px',
    marginBottom: '48px',
  },
  benefitCard: {
    background: COLORS.bgCard,
    borderRadius: '16px',
    padding: '24px 16px',
    border: `1px solid ${COLORS.border}`,
    textAlign: 'center',
  },
  benefitIcon: { fontSize: '32px', marginBottom: '12px' },
  benefitTitle: { fontSize: '14px', fontWeight: '700', marginBottom: '8px', margin: '0 0 8px 0' },
  benefitText: { fontSize: '13px', color: COLORS.textMuted, lineHeight: '1.4', margin: 0 },
  ctaSection: { marginBottom: '24px' },
  docsLink: { marginTop: '32px', textAlign: 'center' },
  walletButton: {
    background: COLORS.gradientPrimary,
    borderRadius: '12px',
    fontSize: '15px',
    fontWeight: '700',
    padding: '14px 32px',
    height: 'auto',
  },
  walletButtonSmall: {
    background: `${COLORS.primary}20`,
    borderRadius: '8px',
    fontSize: '12px',
    height: '36px',
    padding: '0 12px',
  },
  // Form
  formSection: {},
  formTitle: {
    fontSize: '28px',
    fontWeight: '800',
    marginBottom: '12px',
  },
  formSubtext: {
    fontSize: '15px',
    color: COLORS.textSecondary,
    lineHeight: '1.5',
    marginBottom: '24px',
  },
  connectedWallet: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 16px',
    background: COLORS.bgCard,
    borderRadius: '12px',
    border: `1px solid ${COLORS.border}`,
    marginBottom: '24px',
    fontSize: '14px',
    color: COLORS.textMuted,
  },
  walletAddr: {
    fontFamily: 'JetBrains Mono, monospace',
    color: COLORS.primary,
    fontWeight: '600',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  },
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  label: {
    fontSize: '14px',
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  input: {
    background: COLORS.bgCard,
    border: `1px solid ${COLORS.border}`,
    borderRadius: '10px',
    padding: '12px 16px',
    fontSize: '14px',
    color: COLORS.textPrimary,
    outline: 'none',
    transition: 'border-color 0.2s',
    fontFamily: 'inherit',
  },
  textarea: {
    background: COLORS.bgCard,
    border: `1px solid ${COLORS.border}`,
    borderRadius: '10px',
    padding: '12px 16px',
    fontSize: '14px',
    color: COLORS.textPrimary,
    outline: 'none',
    resize: 'vertical',
    fontFamily: 'inherit',
    lineHeight: '1.5',
  },
  charCount: {
    fontSize: '11px',
    color: COLORS.textMuted,
    textAlign: 'right',
  },
  hint: {
    fontSize: '12px',
    color: COLORS.textMuted,
  },
  chipGroup: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
  },
  chip: {
    padding: '6px 14px',
    borderRadius: '8px',
    border: `1px solid ${COLORS.border}`,
    background: 'transparent',
    color: COLORS.textSecondary,
    fontSize: '13px',
    cursor: 'pointer',
    transition: 'all 0.2s',
    textTransform: 'capitalize',
  },
  chipSelected: {
    background: `${COLORS.primary}20`,
    borderColor: COLORS.primary,
    color: COLORS.primary,
    fontWeight: '600',
  },
  submitButton: {
    background: COLORS.gradientPrimary,
    border: 'none',
    borderRadius: '12px',
    padding: '14px 24px',
    fontSize: '15px',
    fontWeight: '700',
    color: '#fff',
    cursor: 'pointer',
    transition: 'opacity 0.2s',
    marginTop: '8px',
  },
  errorBox: {
    background: `${COLORS.error}15`,
    border: `1px solid ${COLORS.error}40`,
    borderRadius: '10px',
    padding: '12px 16px',
    color: COLORS.error,
    fontSize: '14px',
  },
  successBox: {
    background: `${COLORS.success}15`,
    border: `1px solid ${COLORS.success}40`,
    borderRadius: '10px',
    padding: '12px 16px',
    color: COLORS.success,
    fontSize: '14px',
  },
  // Status screens
  statusSection: {
    textAlign: 'center',
    paddingTop: '24px',
  },
  statusIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '96px',
    height: '96px',
    borderRadius: '50%',
    marginBottom: '24px',
  },
  statusTitle: {
    fontSize: '28px',
    fontWeight: '800',
    marginBottom: '12px',
  },
  statusText: {
    fontSize: '15px',
    color: COLORS.textSecondary,
    lineHeight: '1.6',
    marginBottom: '32px',
  },
  statusCard: {
    background: COLORS.bgCard,
    borderRadius: '16px',
    padding: '20px',
    border: `1px solid ${COLORS.border}`,
    textAlign: 'left',
    maxWidth: '400px',
    margin: '0 auto',
  },
  statusRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '10px 0',
    borderBottom: `1px solid ${COLORS.border}`,
    fontSize: '14px',
  },
  statusLabel: {
    color: COLORS.textMuted,
  },
  statusValue: {
    color: COLORS.textPrimary,
    fontWeight: '600',
  },
  // API Key display
  apiKeyBox: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    background: COLORS.bgCard,
    border: `1px solid ${COLORS.primary}40`,
    borderRadius: '12px',
    padding: '16px',
    marginBottom: '16px',
    maxWidth: '520px',
    margin: '0 auto 16px',
  },
  apiKeyText: {
    flex: 1,
    fontSize: '13px',
    fontFamily: 'JetBrains Mono, monospace',
    color: COLORS.primary,
    wordBreak: 'break-all',
    lineHeight: '1.4',
  },
  copyButton: {
    background: `${COLORS.primary}20`,
    border: `1px solid ${COLORS.primary}40`,
    borderRadius: '8px',
    padding: '8px 16px',
    color: COLORS.primary,
    fontSize: '13px',
    fontWeight: '600',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'all 0.2s',
  },
  warningBox: {
    background: `${COLORS.warning}10`,
    border: `1px solid ${COLORS.warning}30`,
    borderRadius: '10px',
    padding: '12px 16px',
    color: COLORS.warning,
    fontSize: '13px',
    maxWidth: '520px',
    margin: '0 auto 32px',
    textAlign: 'left',
  },
  codeBlock: {
    background: COLORS.bgCard,
    border: `1px solid ${COLORS.border}`,
    borderRadius: '10px',
    padding: '16px',
    textAlign: 'left',
    fontSize: '13px',
    fontFamily: 'JetBrains Mono, monospace',
    color: COLORS.textSecondary,
    overflowX: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  centerBox: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    paddingTop: '80px',
  },
  spinner: {
    width: '32px',
    height: '32px',
    border: `3px solid ${COLORS.border}`,
    borderTopColor: COLORS.primary,
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
}

// Inject keyframe
if (typeof document !== 'undefined') {
  const existing = document.getElementById('partner-page-styles')
  if (!existing) {
    const tag = document.createElement('style')
    tag.id = 'partner-page-styles'
    tag.textContent = `
      @keyframes spin { to { transform: rotate(360deg) } }
      @media (max-width: 640px) {
        .partner-benefits-grid { grid-template-columns: 1fr !important; }
      }
    `
    document.head.appendChild(tag)
  }
}
