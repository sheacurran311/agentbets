import React, { useState, useEffect, useCallback, useMemo, useReducer, memo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWallet, useConnection } from '@solana/wallet-adapter-react'
import { WalletMultiButton, useWalletModal } from '@solana/wallet-adapter-react-ui'
import { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js'

// Configuration from environment variables (with defaults for development)
const API_BASE = import.meta.env.VITE_API_URL || '/api'
const ESCROW_WALLET = import.meta.env.VITE_ESCROW_WALLET || '48sWTmPygvc4w2RqKMao6zXWPGzpnnD1uecXJbCkRnQM'
const ADMIN_WALLET = import.meta.env.VITE_ADMIN_WALLET || 'ESutJq7VqRER499A78W9BJCjdtZAqMJWy6hjf4HCjtsG'

// USDC Token Mint (mainnet) - 6 decimals
const USDC_MINT = import.meta.env.VITE_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDC_DECIMALS = 6

// Input Sanitization - Prevent XSS and injection attacks
const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input
  return input
    // Remove any HTML tags
    .replace(/<[^>]*>/g, '')
    // Escape HTML entities
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    // Remove potential javascript: protocol
    .replace(/javascript:/gi, '')
    // Remove potential data: protocol (can be used for XSS)
    .replace(/data:/gi, '')
    // Remove event handlers like onclick, onerror, etc.
    .replace(/on\w+\s*=/gi, '')
    // Remove script-related content
    .replace(/\beval\s*\(/gi, '')
    .replace(/\bFunction\s*\(/gi, '')
    // Trim whitespace
    .trim()
}

// Validate and sanitize date input
const sanitizeDate = (dateString) => {
  if (!dateString) return null
  // Only allow ISO date format (YYYY-MM-DDTHH:MM)
  const dateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
  if (!dateRegex.test(dateString)) return null
  
  // Parse as UTC
  const parts = dateString.split('T');
  const [datePart, timePart] = parts;
  const [year, month, day] = datePart.split('-');
  const [hours, minutes] = timePart.split(':');
  
  const date = new Date(Date.UTC(
    parseInt(year),
    parseInt(month) - 1,
    parseInt(day),
    parseInt(hours),
    parseInt(minutes)
  ));
  
  // Check if date is valid and in the future (UTC)
  const now = new Date();
  if (isNaN(date.getTime()) || date <= now) return null
  
  return dateString
}

// Validate category against allowed values
const VALID_CATEGORIES = ['competition', 'performance', 'token', 'milestone', 'head-to-head', 'app', 'general']
const sanitizeCategory = (category) => {
  if (VALID_CATEGORIES.includes(category)) return category
  return 'general' // Default to general if invalid
}

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
  textSecondary: '#D0D0DC',
  textMuted: '#9090A8',
  textAccent: '#14F195',

  // Borders
  border: 'rgba(255, 255, 255, 0.08)',
  borderLight: 'rgba(255, 255, 255, 0.12)',
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
  ),
  shield: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  )
}

// Market categories with modern icons
const CATEGORIES = [
  { id: 'all', label: 'Active Markets', icon: Icons.grid },
  { id: 'competition', label: 'Competitions', icon: Icons.trophy },
  { id: 'performance', label: 'Performance', icon: Icons.activity },
  { id: 'token', label: 'Token/Price', icon: Icons.dollarSign },
  { id: 'milestone', label: 'Milestones', icon: Icons.target },
  { id: 'head-to-head', label: 'Head-to-Head', icon: Icons.swords },
  { id: 'app', label: 'Apps/Platforms', icon: Icons2.app },
  { id: 'general', label: 'General', icon: Icons.zap },
  { id: 'ended', label: 'Ended', icon: Icons.clock }
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

    /* Select dropdown styling for dark theme */
    select {
      background-color: ${COLORS.bgCard} !important;
      color: ${COLORS.textPrimary} !important;
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      -moz-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2314F195' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 12px center;
      padding-right: 36px !important;
    }
    select option {
      background-color: ${COLORS.bgCard} !important;
      color: ${COLORS.textPrimary} !important;
      padding: 12px 16px;
    }
    select option:hover, select option:focus, select option:checked {
      background-color: ${COLORS.bgCardHover} !important;
      color: ${COLORS.primary} !important;
    }

    /* Date and time input styling for dark theme */
    input[type="date"], input[type="time"], input[type="datetime-local"] {
      background-color: ${COLORS.bgDark} !important;
      color: ${COLORS.textPrimary} !important;
      color-scheme: dark;
    }
    input[type="date"]::-webkit-calendar-picker-indicator,
    input[type="time"]::-webkit-calendar-picker-indicator,
    input[type="datetime-local"]::-webkit-calendar-picker-indicator {
      filter: invert(1);
      cursor: pointer;
      opacity: 0.7;
    }
    input[type="date"]::-webkit-calendar-picker-indicator:hover,
    input[type="time"]::-webkit-calendar-picker-indicator:hover,
    input[type="datetime-local"]::-webkit-calendar-picker-indicator:hover {
      opacity: 1;
    }

    /* Selection */
    ::selection {
      background: ${COLORS.primary}40;
      color: ${COLORS.textPrimary};
    }

    /* Prevent horizontal overflow */
    html, body {
      overflow-x: hidden !important;
      max-width: 100vw !important;
    }

    * {
      box-sizing: border-box;
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
        width: 100% !important;
        max-width: 100vw !important;
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
      transform: translateY(-4px);
    }

    /* Market Grid Responsive */
    @media (max-width: 1200px) {
      .market-grid {
        grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)) !important;
        gap: 20px !important;
      }
    }

    @media (max-width: 768px) {
      .market-grid {
        grid-template-columns: 1fr !important;
        gap: 16px !important;
        padding: 0 8px !important;
      }
      .market-card {
        min-height: auto !important;
        max-width: none !important;
        padding: 20px !important;
      }
    }

    @media (max-width: 480px) {
      .market-card {
        padding: 16px !important;
        border-radius: 16px !important;
      }
    }

    /* Modal Responsive */
    .bet-modal {
      transition: all 0.3s ease;
    }

    /* Responsive modal for tablets */
    @media (max-width: 900px) {
      .bet-modal {
        width: 95vw !important;
        max-width: 95vw !important;
      }
      .modal-main-layout {
        grid-template-columns: 1fr !important;
        gap: 16px !important;
      }
      .modal-betting-panel {
        order: -1 !important;
      }
    }

    @media (max-width: 600px) {
      .bet-modal {
        width: 100% !important;
        max-width: 100% !important;
        max-height: 95vh !important;
        border-radius: 20px 20px 0 0 !important;
        position: fixed !important;
        bottom: 0 !important;
        margin: 0 !important;
        padding: 20px !important;
      }
      .modal-main-layout {
        grid-template-columns: 1fr !important;
        gap: 12px !important;
      }
      .pool-stats-row {
        grid-template-columns: repeat(2, 1fr) !important;
      }
    }

    /* Smooth scrolling for modal */
    .bet-modal::-webkit-scrollbar {
      width: 6px;
    }

    .bet-modal::-webkit-scrollbar-track {
      background: transparent;
    }

    .bet-modal::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
    }

    .bet-modal::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.2);
    }
  `}</style>
)

/**
 * Mini Sparkline Chart Component
 * Renders a small SVG line chart for odds or price history
 */
const MiniSparkline = memo(({ data, color = COLORS.primary, height = 32, showDots = false }) => {
  if (!data || data.length < 2) {
    // Show a flat line if no data
    return (
      <svg width="100%" height={height} viewBox="0 0 100 32" preserveAspectRatio="xMidYMid meet">
        <line x1="0" y1="16" x2="100" y2="16" stroke={color} strokeWidth="1.5" opacity="0.3" strokeDasharray="4" />
      </svg>
    );
  }

  const values = data.map(d => typeof d === 'number' ? d : d.value || d.yesOdds || 0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  // Create path points
  const points = values.map((val, i) => {
    const x = (i / (values.length - 1)) * 100;
    const y = 32 - ((val - min) / range) * 28 - 2; // 2px padding top/bottom
    return `${x},${y}`;
  });

  const pathD = `M${points.join(' L')}`;

  // Create area fill path
  const areaD = `M0,32 L${points.join(' L')} L100,32 Z`;

  // Calculate last point coordinates for the marker
  const lastX = 100;
  const lastY = 32 - ((values[values.length - 1] - min) / range) * 28 - 2;

  return (
    <svg width="100%" height={height} viewBox="0 0 100 32" preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
      {/* Area fill */}
      <path d={areaD} fill={`${color}15`} />
      {/* Line */}
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* End dot - using vector-effect to prevent stretching */}
      {showDots && values.length > 0 && (
        <circle 
          cx={lastX} 
          cy={lastY} 
          r="2.5" 
          fill={color}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
});

/**
 * Verification Badge Component
 * Shows the verification source with appropriate icon
 */
const VerificationBadge = memo(({ source, url }) => {
  const getSourceInfo = () => {
    switch(source) {
      case 'coingecko':
        return { icon: '🦎', label: 'CoinGecko', color: COLORS.success };
      case 'dexscreener':
        return { icon: '📊', label: 'DexScreener', color: COLORS.secondary };
      case 'x-api':
        return { icon: '𝕏', label: 'X API', color: '#1DA1F2' };
      case 'moltbook':
        return { icon: '📖', label: 'Moltbook', color: COLORS.accent };
      case 'github':
        return { icon: '🐙', label: 'GitHub', color: '#6e5494' };
      case 'colosseum':
        return { icon: '🏛️', label: 'Colosseum', color: COLORS.warning };
      default:
        return { icon: '🔍', label: 'Manual', color: COLORS.textMuted };
    }
  };

  const info = getSourceInfo();

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      fontSize: '10px',
      color: info.color,
      background: `${info.color}15`,
      padding: '3px 8px',
      borderRadius: '4px',
      fontWeight: '500'
    }}>
      <span>{info.icon}</span>
      <span>{info.label}</span>
    </div>
  );
});

/**
 * Format countdown timer from a future date
 */
const formatCountdown = (endDateString, _tick = 0) => {
  if (!endDateString) return '';
  
  // Parse the datetime-local format (YYYY-MM-DDTHH:MM) as UTC
  const parts = endDateString.split('T');
  if (parts.length !== 2) return '';
  
  const [datePart, timePart] = parts;
  const [year, month, day] = datePart.split('-');
  const [hours, minutes] = timePart.split(':');
  
  // Create UTC date
  const endDate = new Date(Date.UTC(
    parseInt(year),
    parseInt(month) - 1,
    parseInt(day),
    parseInt(hours),
    parseInt(minutes || 0)
  ));
  
  const now = new Date();
  const diffMs = endDate.getTime() - now.getTime();
  
  if (diffMs <= 0) return 'Expired';
  
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hours_left = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes_left = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const seconds_left = Math.floor((diffMs % (1000 * 60)) / 1000);
  
  if (days > 0) return `${days}d ${hours_left}h ${minutes_left}m`;
  if (hours_left > 0) return `${hours_left}h ${minutes_left}m ${seconds_left}s`;
  if (minutes_left > 0) return `${minutes_left}m ${seconds_left}s`;
  return `${seconds_left}s`;
};

/**
 * Format datetime-local string as readable UTC date
 */
const formatDateTimeLocal = (dateTimeString) => {
  if (!dateTimeString) return '';
  
  // Parse the datetime-local format (YYYY-MM-DDTHH:MM) as UTC
  const parts = dateTimeString.split('T');
  if (parts.length !== 2) return '';
  
  const [datePart, timePart] = parts;
  const [year, month, day] = datePart.split('-');
  const [hours, minutes] = timePart.split(':');
  
  // Create UTC date
  const date = new Date(Date.UTC(
    parseInt(year),
    parseInt(month) - 1,
    parseInt(day),
    parseInt(hours),
    parseInt(minutes || 0)
  ));
  
  return date.toLocaleString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }) + ' UTC';
};

function App() {
  const navigate = useNavigate()
  const { publicKey, sendTransaction, signTransaction, connected } = useWallet()
  const { connection } = useConnection()
  const { setVisible: setWalletModalVisible } = useWalletModal()

  const [view, setView] = useState('markets')
  const [markets, setMarkets] = useState([])
  const [filteredMarkets, setFilteredMarkets] = useState([])
  const [stats, setStats] = useState(null)
  const [leaderboard, setLeaderboard] = useState([])
  const [selectedMarket, setSelectedMarket] = useState(null)
  const [betAmount, setBetAmount] = useState('')
  const [walletBalance, setWalletBalance] = useState(null)
  const [txStatus, setTxStatus] = useState(null)
  const [betConfirmation, setBetConfirmation] = useState(null)
  const [gaslessConfig, setGaslessConfig] = useState(null)
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [sortBy, setSortBy] = useState('volume')
  const [searchQuery, setSearchQuery] = useState('')
  const [agentRoyalties, setAgentRoyalties] = useState(null)
  const [blinkUrl, setBlinkUrl] = useState(null)
  const [liveActivity, setLiveActivity] = useState([])
  const [isLive, setIsLive] = useState(true)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [oddsHistoryCache, setOddsHistoryCache] = useState({}) // Cache for odds history per market
  const [pendingResolutions, setPendingResolutions] = useState([]) // Markets awaiting admin confirmation
  const [adminConfirming, setAdminConfirming] = useState(null) // Currently confirming market ID
  const [showDatePicker, setShowDatePicker] = useState(false) // Date picker modal visibility
  const [countdownTick, setCountdownTick] = useState(0) // Ticker for countdown updates

  // Check if connected wallet is admin
  const isAdmin = publicKey?.toString() === ADMIN_WALLET

  // Enhanced market creation form with useReducer for cleaner state management
  const initialMarketState = {
    question: '',
    category: 'general',
    endDate: ''
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

  // Fetch gasless relay configuration
  const fetchGaslessConfig = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/gasless/config`)
      const data = await res.json()
      if (data.success && data.enabled) {
        setGaslessConfig(data)
        console.log(`[Gasless] Relay active: ${data.feeUsdc} USDC/tx, payer: ${data.feePayerPubkey?.slice(0, 8)}...`)
      }
    } catch (err) {
      console.log('[Gasless] Config not available:', err.message)
    }
  }, [])

  useEffect(() => {
    fetchGaslessConfig()
  }, [fetchGaslessConfig])

  // Fetch USDC token balance with retry logic for rate-limited RPCs
  const fetchBalance = useCallback(async () => {
    if (!publicKey || !connection) return

    const MAX_RETRIES = 3
    const usdcMint = new PublicKey(USDC_MINT)

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Get USDC token accounts for this wallet
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
          publicKey,
          { mint: usdcMint }
        )
        
        if (tokenAccounts.value.length > 0) {
          // Get the USDC balance from the first token account
          const usdcBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount
          setWalletBalance(usdcBalance)
        } else {
          // No USDC token account exists - balance is 0
          setWalletBalance(0)
        }
        return // Success - exit retry loop
      } catch (err) {
        console.warn(`[Balance] Attempt ${attempt}/${MAX_RETRIES} failed:`, err.message)
        
        if (attempt < MAX_RETRIES) {
          // Exponential backoff: 1s, 2s before retrying
          await new Promise(r => setTimeout(r, attempt * 1000))
        } else {
          console.error('[Balance] All retries failed, trying getTokenAccountBalance fallback')
          // Final fallback: derive the Associated Token Account directly and query its balance
          // This uses a lighter RPC call (getTokenAccountBalance) instead of getParsedTokenAccountsByOwner
          try {
            const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
            const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
            const [ata] = PublicKey.findProgramAddressSync(
              [publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), usdcMint.toBuffer()],
              ASSOCIATED_TOKEN_PROGRAM_ID
            )
            const accInfo = await connection.getTokenAccountBalance(ata)
            if (accInfo?.value) {
              setWalletBalance(accInfo.value.uiAmount || 0)
            } else {
              setWalletBalance(0)
            }
          } catch (fallbackErr) {
            console.error('[Balance] Fallback also failed:', fallbackErr.message)
            // Keep existing balance if we had one, only set null if we never fetched
            setWalletBalance(prev => prev !== null ? prev : null)
          }
        }
      }
    }
  }, [publicKey, connection])

  useEffect(() => {
    fetchMarkets()
    fetchStats()
    fetchLeaderboard()
    fetchRecentActivity()
  }, [])

  // Fetch pending resolutions when admin wallet connects
  useEffect(() => {
    if (isAdmin) {
      fetchPendingResolutions()
    }
  }, [isAdmin])

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
        { type: 'bet', user: '7xK...4Dm', market: 'Will $AIXBT reach $2B?', side: 'YES', amount: 50, time: Date.now() - 30000 },
        { type: 'bet', user: '3Fg...9Jk', market: 'Will @truth_terminal post today?', side: 'NO', amount: 25, time: Date.now() - 120000 },
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

  // Helper: is a market ended/resolved/closed?
  const isMarketEnded = useCallback((m) => {
    if (['resolved', 'closed', 'settled', 'distributed'].includes(m.status)) return true
    if (m.endDate && new Date(m.endDate) < new Date()) return true
    return false
  }, [])

  // Filter and sort markets
  useEffect(() => {
    let result = [...markets]

    // "all" shows only active (not ended) markets
    // "ended" shows only ended/resolved/closed markets
    // other categories filter by category within active markets
    if (selectedCategory === 'all') {
      result = result.filter(m => !isMarketEnded(m))
    } else if (selectedCategory === 'ended') {
      result = result.filter(m => isMarketEnded(m))
    } else {
      result = result.filter(m => m.category === selectedCategory && !isMarketEnded(m))
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
  }, [markets, selectedCategory, sortBy, searchQuery, isMarketEnded])

  const fetchMarkets = async () => {
    try {
      const res = await fetch(`${API_BASE}/markets`)
      const data = await res.json()
      const marketList = data.markets || []
      setMarkets(marketList)
      
      // Fetch odds history for first 12 markets (visible on initial load)
      const historyPromises = marketList.slice(0, 12).map(async (market) => {
        try {
          const histRes = await fetch(`${API_BASE}/markets/${market.id}/history?limit=10`)
          const histData = await histRes.json()
          return { marketId: market.id, history: histData.history || [] }
        } catch {
          return { marketId: market.id, history: [] }
        }
      })
      
      const historyResults = await Promise.all(historyPromises)
      const newCache = {}
      historyResults.forEach(({ marketId, history }) => {
        newCache[marketId] = history
      })
      setOddsHistoryCache(prev => ({ ...prev, ...newCache }))
    } catch (err) {
      console.error('Failed to fetch markets:', err)
    }
  }

  // Fetch odds history for a specific market (for lazy loading)
  const fetchOddsHistory = useCallback(async (marketId) => {
    if (oddsHistoryCache[marketId]) return oddsHistoryCache[marketId]
    
    try {
      const res = await fetch(`${API_BASE}/markets/${marketId}/history?limit=10`)
      const data = await res.json()
      const history = data.history || []
      setOddsHistoryCache(prev => ({ ...prev, [marketId]: history }))
      return history
    } catch {
      return []
    }
  }, [oddsHistoryCache])

  // Force-refresh odds history for a market (bypasses cache, used after placing bets)
  const refreshOddsHistory = useCallback(async (marketId) => {
    try {
      const res = await fetch(`${API_BASE}/markets/${marketId}/history?limit=10`)
      const data = await res.json()
      const history = data.history || []
      setOddsHistoryCache(prev => ({ ...prev, [marketId]: history }))
      return history
    } catch {
      return []
    }
  }, [])

  // Fetch odds history and refresh balance when a market is selected (for modal)
  useEffect(() => {
    if (selectedMarket) {
      // Refresh balance when modal opens so it's always current
      if (connected) fetchBalance()
      if (!oddsHistoryCache[selectedMarket.id]) {
        fetchOddsHistory(selectedMarket.id)
      }
      // Sync on-chain data so pools/volume/bets are always current
      if (selectedMarket.betPda) {
        fetch(`${API_BASE}/onchain/sync/${selectedMarket.id}`, { method: 'POST' })
          .then(res => res.json())
          .then(data => {
            if (data.success && data.changed) {
              // Refresh market list with synced data
              fetchMarkets()
              refreshOddsHistory(selectedMarket.id)
              // Update the selected market in place so the modal shows fresh data
              if (data.market) {
                setSelectedMarket(prev => prev ? { ...prev, ...data.market } : prev)
              }
            }
          })
          .catch(() => {}) // Ignore sync failures silently
      }
    }
  }, [selectedMarket?.id])

  // Update countdown every second when date picker is open
  useEffect(() => {
    if (!showDatePicker) return;
    
    const interval = setInterval(() => {
      setCountdownTick(prev => prev + 1);
    }, 1000);
    
    return () => clearInterval(interval);
  }, [showDatePicker]);

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

  // Fetch pending resolutions for admin panel
  const fetchPendingResolutions = async () => {
    if (!isAdmin) return
    try {
      const res = await fetch(`${API_BASE}/markets/pending-resolutions`)
      const data = await res.json()
      setPendingResolutions(data.markets || [])
    } catch (err) {
      console.error('Failed to fetch pending resolutions:', err)
    }
  }

  // Admin: Confirm resolution
  const confirmResolution = async (marketId, outcome) => {
    if (!isAdmin || !publicKey) {
      alert('Admin wallet required')
      return
    }
    
    setAdminConfirming(marketId)
    try {
      const res = await fetch(`${API_BASE}/markets/${marketId}/confirm-resolution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          finalOutcome: outcome,
          adminWallet: publicKey.toString(),
          adminNotes: 'Confirmed via admin panel'
        })
      })
      
      const data = await res.json()
      if (data.success) {
        alert(`Market resolved as ${outcome}! ${data.message || ''}`)
        fetchPendingResolutions()
        fetchMarkets()
      } else {
        alert(data.error || 'Failed to confirm resolution')
      }
    } catch (err) {
      alert('Error confirming resolution: ' + err.message)
    } finally {
      setAdminConfirming(null)
    }
  }

  // Decode Solana on-chain errors into human-readable messages
  const decodeSolanaError = useCallback((err) => {
    if (!err) return 'Unknown error'
    const errStr = typeof err === 'string' ? err : JSON.stringify(err)

    // Poll.fun program custom errors (code 6000+)
    const pollFunErrors = {
      6000: 'Invalid USDC mint',
      6001: 'Invalid update authority',
      6002: 'Invalid withdraw authority',
      6003: 'Question is empty',
      6004: 'Expected user count is zero',
      6005: 'Minimum vote count is zero',
      6006: 'Minimum vote count > expected user count',
      6007: 'Expected user count > 5',
      6008: 'Minimum vote count > 5',
      6009: 'You have already placed a wager on this bet',
      6010: 'Insufficient USDC balance',
      6011: 'Invalid amount',
      6012: 'Market is not accepting wagers (not in Pending status)',
      6013: 'Resolved outcome is already set',
      6014: 'Invalid side',
      6015: 'User has not placed a wager',
      6016: 'User has already voted',
      6017: 'Must initiate a vote first',
      6018: 'Market must be resolved before settling',
      6019: 'Invalid outcome — must be For or Against'
    }

    // Check for InstructionError with Custom code
    const customMatch = errStr.match(/"Custom":(\d+)/)
    if (customMatch) {
      const code = parseInt(customMatch[1])
      if (pollFunErrors[code]) return pollFunErrors[code]
      // SPL Token errors
      if (code === 0) return 'Account not rent-exempt (insufficient SOL for fees)'
      if (code === 1) return 'Insufficient token balance'
      if (code === 4) return 'Owner mismatch on token account'
      return `On-chain error (code ${code})`
    }

    // Common error patterns
    if (errStr.includes('InsufficientFundsForRent')) return 'Insufficient SOL for account rent'
    if (errStr.includes('AccountNotFound')) return 'Account not found on-chain'
    if (errStr.includes('User rejected')) return 'Transaction rejected by wallet'

    return errStr
  }, [])

  // Poll-based transaction confirmation to avoid WebSocket signatureSubscribe errors.
  // connection.confirmTransaction() uses WebSocket subscriptions internally, which can
  // enter an infinite retry loop when the RPC's WebSocket endpoint fails or rate-limits.
  const pollTransactionConfirmation = useCallback(async (signature, timeoutMs = 60000) => {
    const start = Date.now()
    const pollIntervalMs = 2000

    while (Date.now() - start < timeoutMs) {
      try {
        const { value } = await connection.getSignatureStatuses([signature])
        const status = value?.[0]

        if (status) {
          if (status.err) {
            throw new Error(decodeSolanaError(status.err))
          }
          // 'confirmed' or 'finalized' means success
          if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
            return status
          }
        }
      } catch (err) {
        // If it's our own thrown error (tx failed on-chain), re-throw
        if (err.message?.startsWith('Transaction failed:')) throw err
        // Otherwise it's a network blip — keep polling
        console.warn('Polling signature status failed, retrying...', err.message)
      }

      await new Promise(r => setTimeout(r, pollIntervalMs))
    }

    throw new Error('Transaction confirmation timed out after 60s. Check your wallet or explorer.')
  }, [connection])

  const placeBet = async (outcome) => {
    // If not connected, trigger wallet modal
    if (!connected || !publicKey) {
      setWalletModalVisible(true)
      return
    }

    if (!betAmount || parseFloat(betAmount) <= 0) {
      alert('Please enter a valid bet amount')
      return
    }

    const amount = parseFloat(betAmount)
    const gasFee = gaslessConfig?.feeUsdc || 0
    const totalCost = amount + gasFee

    // Check USDC wallet balance (bet + gas fee)
    if (walletBalance === null) {
      alert('No USDC balance found. Please add USDC to your wallet first.')
      return
    }
    if (totalCost > walletBalance) {
      alert(`Insufficient USDC balance. You need ${totalCost.toFixed(4)} USDC (${amount} bet + ${gasFee} gas fee). You have ${walletBalance.toFixed(2)} USDC`)
      return
    }

    setTxStatus({ type: 'pending', message: 'Creating transaction...' })

    try {
      // Request gasless transaction from API (API pays SOL gas, user pays USDC fee)
      const useGasless = !!gaslessConfig?.enabled
      setTxStatus({ type: 'pending', message: useGasless ? 'Creating gasless wager...' : 'Creating on-chain wager...' })

      const wagerRes = await fetch(`${API_BASE}/onchain/wager`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketId: selectedMarket.id,
          betPda: selectedMarket.betPda,
          outcome,
          amount,
          wallet: publicKey.toString(),
          gasless: useGasless
        })
      })

      const wagerData = await wagerRes.json()

      if (!wagerData.success) {
        throw new Error(wagerData.error || 'Failed to create wager transaction')
      }

      setTxStatus({ type: 'pending', message: useGasless
        ? `Approve ${amount} USDC bet + ${gasFee} USDC gas fee in wallet...`
        : 'Please approve USDC transfer in wallet...'
      })

      if (wagerData.gasless && wagerData.transaction) {
        // GASLESS: Transaction is pre-signed by API as feePayer
        // User signs their part, then we broadcast manually (skip preflight
        // since simulation fails on partially-signed transactions)
        const txBuffer = Buffer.from(wagerData.transaction, 'base64')
        const transaction = Transaction.from(txBuffer)

        // Use signTransaction (not sendTransaction) to avoid wallet's built-in simulation
        const signed = await signTransaction(transaction)

        // Broadcast the fully-signed transaction, skipping preflight simulation
        const signature = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: true,
          preflightCommitment: 'confirmed'
        })

        setTxStatus({ type: 'pending', message: 'Confirming on-chain wager...' })

        // Use polling instead of WebSocket-based confirmTransaction to avoid
        // infinite signatureSubscribe retry loops
        await pollTransactionConfirmation(signature)

        setTxStatus({ type: 'success', message: 'Bet confirmed on-chain!' })

        // Record bet in API so market data (volume, pools, odds) updates.
        // Don't send txSignature — the RPC often hasn't indexed the tx yet,
        // which causes verifyBetTransaction to fail with "Transaction not found".
        // We already confirmed on-chain via polling, so verification is redundant.
        try {
          const recordRes = await fetch(`${API_BASE}/bets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              marketId: selectedMarket.id,
              outcome,
              amount, // raw USDC — backend converts to micro internally
              wallet: publicKey.toString()
            })
          })
          if (!recordRes.ok) {
            const errData = await recordRes.json().catch(() => ({}))
            console.warn('Failed to record bet in API:', recordRes.status, errData.error || errData.message)
          }
        } catch (recordErr) {
          console.warn('Failed to record bet in API:', recordErr.message)
        }

        // Show confirmation screen and refresh data immediately
        setBetConfirmation({
          signature,
          amount,
          outcome,
          marketQuestion: selectedMarket.question,
          gasless: true
        })
        fetchMarkets()
        fetchStats()
        fetchBalance()
        refreshOddsHistory(selectedMarket.id)
        return // Don't fall through to the traditional path
      } else {
        // TRADITIONAL: Build transaction from instructions
        const transaction = new Transaction()

        // Add user init instruction if needed
        if (wagerData.userInitInstruction) {
          const initIx = wagerData.userInitInstruction
          transaction.add({
            programId: new PublicKey(initIx.programId),
            keys: initIx.keys.map(k => ({
              pubkey: new PublicKey(k.pubkey),
              isSigner: k.isSigner,
              isWritable: k.isWritable
            })),
            data: Buffer.from(initIx.data, 'base64')
          })
        }

        // Add wager instruction
        if (wagerData.instruction) {
          const ix = wagerData.instruction
          transaction.add({
            programId: new PublicKey(ix.programId),
            keys: ix.keys.map(k => ({
              pubkey: new PublicKey(k.pubkey),
              isSigner: k.isSigner,
              isWritable: k.isWritable
            })),
            data: Buffer.from(ix.data, 'base64')
          })
        }

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
        transaction.recentBlockhash = blockhash
        transaction.feePayer = publicKey

        const signature = await sendTransaction(transaction, connection)

        setTxStatus({ type: 'pending', message: 'Confirming on-chain wager...' })

        // Use polling instead of WebSocket-based confirmTransaction to avoid
        // infinite signatureSubscribe retry loops
        await pollTransactionConfirmation(signature)

        setTxStatus({ type: 'success', message: 'Bet confirmed on-chain!' })

        // Record bet in API so market data (volume, pools, odds) updates.
        // Don't send txSignature — the RPC often hasn't indexed the tx yet,
        // which causes verifyBetTransaction to fail with "Transaction not found".
        // We already confirmed on-chain via polling, so verification is redundant.
        try {
          const recordRes = await fetch(`${API_BASE}/bets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              marketId: selectedMarket.id,
              outcome,
              amount, // raw USDC — backend converts to micro internally
              wallet: publicKey.toString()
            })
          })
          if (!recordRes.ok) {
            const errData = await recordRes.json().catch(() => ({}))
            console.warn('Failed to record bet in API:', recordRes.status, errData.error || errData.message)
          }
        } catch (recordErr) {
          console.warn('Failed to record bet in API:', recordErr.message)
        }

        // Show confirmation screen and refresh data immediately
        setBetConfirmation({
          signature,
          amount,
          outcome,
          marketQuestion: selectedMarket.question,
          gasless: false
        })
        fetchMarkets()
        fetchStats()
        fetchBalance()
        refreshOddsHistory(selectedMarket.id)
      }

    } catch (err) {
      console.error('Transaction failed:', err)
      const friendlyMsg = decodeSolanaError(err.message || err)
      setTxStatus({ type: 'error', message: friendlyMsg })
    }
  }

  const createMarket = async () => {
    // Require wallet connection for market creation
    if (!connected || !publicKey) {
      setWalletModalVisible(true)
      return
    }

    if (!newMarket.question || !newMarket.endDate) {
      alert('Please fill in question and end date')
      return
    }

    // Sanitize all inputs before submission
    const sanitizedQuestion = sanitizeInput(newMarket.question)
    const sanitizedCategory = sanitizeCategory(newMarket.category)
    const sanitizedEndDate = sanitizeDate(newMarket.endDate)

    // Validate sanitized inputs
    if (!sanitizedQuestion || sanitizedQuestion.length === 0) {
      alert('Invalid question. Please remove any special characters and try again.')
      return
    }

    if (sanitizedQuestion.length > 256) {
      alert('Question must be 256 characters or less')
      return
    }

    if (!sanitizedEndDate) {
      alert('Invalid date. Please select a future date and time (at least 10 minutes from now).')
      return
    }

    // Additional validation: ensure end date is at least 10 minutes in the future
    const parts = sanitizedEndDate.split('T');
    const [datePart, timePart] = parts;
    const [year, month, day] = datePart.split('-');
    const [hours, minutes] = timePart.split(':');
    const endDate = new Date(Date.UTC(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      parseInt(hours),
      parseInt(minutes)
    ));
    const now = new Date();
    const tenMinutesFromNow = new Date(now.getTime() + 10 * 60 * 1000);
    
    if (endDate <= tenMinutesFromNow) {
      alert('End date must be at least 10 minutes in the future.')
      return
    }

    try {
      // Use on-chain endpoint - bot creates PDA with its keypair
      const res = await fetch(`${API_BASE}/onchain/markets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: sanitizedQuestion,
          category: sanitizedCategory,
          endDate: sanitizedEndDate,
          proposerWallet: publicKey.toString() // Proposer wallet (bot is on-chain creator)
        })
      })

      const data = await res.json()
      if (data.success) {
        alert(`Market created on-chain!\n\nBet PDA: ${data.betPda}\n\nThe bot will resolve this market at the end date.`)
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
          <img
            src="/agentbets-logo-transparent.png"
            alt="AgentBets"
            style={{...styles.logoImg, cursor: 'pointer'}}
            onClick={() => navigate('/')}
            title="Back to home"
          />
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

        {/* Admin Section - Only visible to admin wallet */}
        {isAdmin && (
          <div style={{...styles.sidebarSection, ...styles.adminSection}}>
            <div style={styles.sidebarLabel}>Admin</div>
            <button
              style={{...styles.sidebarItem, ...(view === 'admin' ? styles.sidebarItemActive : {})}}
              onClick={() => { setView('admin'); fetchPendingResolutions(); }}
            >
              <span style={styles.iconWrapper}>{Icons.shield}</span>
              Pending Resolutions
              {pendingResolutions.length > 0 && (
                <span style={{
                  marginLeft: 'auto',
                  background: COLORS.warning,
                  color: '#000',
                  padding: '2px 8px',
                  borderRadius: '10px',
                  fontSize: '11px',
                  fontWeight: '700'
                }}>
                  {pendingResolutions.length}
                </span>
              )}
            </button>
          </div>
        )}

        {/* Stats in sidebar */}
        {stats && (
          <div style={styles.sidebarStats}>
            <div style={styles.statRow}>
              <span>Markets</span>
              <span style={styles.statValue}>{stats.markets?.total || 0}</span>
            </div>
            <div style={styles.statRow}>
              <span>Volume</span>
              <span style={styles.statValue}>${stats.bets?.totalVolumeUSDC?.toLocaleString() || 0}</span>
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
                    <span style={styles.activityAmount}>${activity.amount} USDC</span>
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
              MAINNET
            </div>
            {connected && walletBalance !== null && (
              <div style={styles.balanceBadge}>
                <span style={styles.balanceIcon}>{Icons.wallet}</span>
                {walletBalance.toFixed(2)} USDC
              </div>
            )}
            {connected && walletBalance === null && (
              <a 
                href="https://jup.ag/swap/SOL-USDC" 
                target="_blank" 
                rel="noopener noreferrer"
                style={{...styles.balanceBadge, background: 'rgba(255,100,100,0.1)', borderColor: 'rgba(255,100,100,0.3)', textDecoration: 'none', cursor: 'pointer'}}
                title="Swap SOL for USDC on Jupiter"
              >
                <span style={styles.balanceIcon}>{Icons.wallet}</span>
                Get USDC
              </a>
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
                  <span className="metric-value" style={{fontSize: '28px'}}>{stats?.markets?.active || filteredMarkets.filter(m => m.status === 'active' || !m.status).length}</span>
                </div>
                <div style={styles.heroStatCard}>
                  <span className="step-num">VOLUME</span>
                  <span className="metric-value" style={{fontSize: '28px'}}>${stats?.bets?.totalVolumeUSDC?.toLocaleString() || '0'}</span>
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
                      {selectedCategory === 'all' ? 'Active Markets' : CATEGORIES.find(c => c.id === selectedCategory)?.label}
                    </span>
                  </h1>
                  <span style={styles.marketCount}>
                    {filteredMarkets.length} {selectedCategory === 'ended' ? 'ended' : 'active'}
                  </span>
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
                  <p style={{color: COLORS.textMuted, marginBottom: '24px'}}>
                    {selectedCategory === 'ended' ? 'No ended markets yet.' : 'Be the first to create a market in this category!'}
                  </p>
                  <button style={styles.primaryBtn} onClick={() => setView('create')}>
                    Create Market
                  </button>
                </div>
              ) : (
                <div style={styles.marketGrid} className="market-grid">
                  {filteredMarkets.map((market, index) => {
                    const ended = isMarketEnded(market)
                    return (
                    <div
                      key={market.id}
                      style={{
                        ...styles.marketCard,
                        animationDelay: `${index * 50}ms`,
                        ...(ended ? { opacity: 0.5, filter: 'grayscale(60%)', pointerEvents: 'auto' } : {})
                      }}
                      className="market-card glass-card"
                      onClick={() => setSelectedMarket(market)}
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
                        {market.status === 'pending_confirmation' ? (
                          <span style={styles.pendingBadge}>
                            &#9888; Awaiting Confirmation
                          </span>
                        ) : market.status === 'resolved' ? (
                          <span style={{
                            ...styles.timeTag,
                            background: `${COLORS.success}20`,
                            color: COLORS.success
                          }}>
                            &#9989; Resolved: {market.resolution}
                          </span>
                        ) : (
                          <span style={{
                            ...styles.timeTag,
                            background: daysUntil(market.endDate) === 'Ended' ? `${COLORS.error}20` : `${COLORS.secondary}15`,
                            color: daysUntil(market.endDate) === 'Ended' ? COLORS.error : COLORS.secondary
                          }}>
                            <span style={styles.clockIcon}>{Icons.clock}</span>
                            {daysUntil(market.endDate)}
                          </span>
                        )}
                      </div>

                      <h3 style={styles.marketQuestion}>{market.question}</h3>
                      
                      {/* Show pending confirmation info */}
                      {market.status === 'pending_confirmation' && market.proposedResolution && (
                        <div style={{
                          padding: '8px 12px',
                          background: `${COLORS.warning}10`,
                          borderRadius: '8px',
                          marginBottom: '12px',
                          fontSize: '12px',
                          color: COLORS.warning
                        }}>
                          Bot proposes: <strong>{market.proposedResolution.outcome}</strong>
                          {market.proposedResolution.confidence && ` (${market.proposedResolution.confidence}% confidence)`}
                        </div>
                      )}

                      {/* Verification info and source badge */}
                      <div style={styles.verificationInfo}>
                        {market.resolutionSource && market.resolutionSource !== 'manual' && (
                          <VerificationBadge source={market.resolutionSource} url={market.verificationUrl} />
                        )}
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

                      {/* Mini Sparkline Chart for Odds History */}
                      <div style={styles.miniChartContainer}>
                        <MiniSparkline 
                          data={oddsHistoryCache[market.id] || []}
                          color={market.yesOdds > 0.5 ? COLORS.success : COLORS.error}
                          height={28}
                          showDots={true}
                        />
                      </div>

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
                            ${(market.totalVolume / 1e6).toFixed(0)} USDC
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
                        <span style={{fontFamily: 'JetBrains Mono, monospace', fontSize: '10px', color: COLORS.textMuted}}>
                          {ended ? 'ENDED (UTC)' : 'ENDS (UTC)'}
                        </span>
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
                  )})}
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
                <p style={styles.formSubtitle}>Launch a market and earn 0.3% creator fee from this market + earn points</p>
              </div>

              {/* Comprehensive Templates by Category */}
              <div style={styles.templateSection}>
                <span style={{fontSize: '12px', color: COLORS.textMuted, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '1px'}}>QUICK TEMPLATES</span>
                <div style={styles.templateGrid} className="template-grid">
                  {[
                    // Performance Templates
                    { icon: '&#129302;', label: 'Agent Followers', template: 'Will @AGENT reach X followers by DATE?', category: 'performance' },
                    { icon: '&#128200;', label: 'Engagement', template: 'Will @AGENT average X+ likes per tweet by DATE?', category: 'performance' },
                    // Token Templates
                    { icon: '&#128176;', label: 'Token Price', template: 'Will $TOKEN reach $X mcap by DATE?', category: 'token' },
                    { icon: '&#128640;', label: 'Token Launch', template: 'Will $TOKEN launch by DATE?', category: 'token' },
                    // Competition Templates
                    { icon: '&#127942;', label: 'Hackathon', template: 'Will PROJECT win the Colosseum hackathon?', category: 'competition' },
                    { icon: '&#127941;', label: 'Top 3', template: 'Will PROJECT finish top 3 in COMPETITION?', category: 'competition' },
                    // Head-to-Head Templates
                    { icon: '&#9876;', label: 'H2H Followers', template: 'Will @AGENT1 gain more followers than @AGENT2 by DATE?', category: 'head-to-head' },
                    { icon: '&#9878;', label: 'H2H Engage', template: 'Will @AGENT1 get more engagement than @AGENT2 this week?', category: 'head-to-head' },
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
                {/* Simplified Form - Only Question, Category, End Date */}
                <div style={{...styles.formSection, borderBottom: 'none', paddingBottom: 0}}>
                  
                  <label style={styles.label}>What are you predicting? *</label>
                  <textarea
                    style={{...styles.input, minHeight: '100px', resize: 'vertical', fontSize: '18px', fontWeight: '500', lineHeight: '1.5'}}
                    placeholder="Will $BUTTERS hit $1M mcap by Feb 28?"
                    value={newMarket.question}
                    onChange={(e) => setMarketField('question', e.target.value)}
                    maxLength={256}
                  />
                  <span style={{fontSize: '11px', color: COLORS.textMuted, marginTop: '4px', display: 'block'}}>
                    {newMarket.question.length}/256 characters - Be specific with measurable outcomes
                  </span>

                  <div style={{...styles.formRow, marginTop: '24px'}}>
                    <div style={styles.formCol}>
                      <label style={styles.label}>Category</label>
                      <select
                        style={styles.input}
                        value={newMarket.category}
                        onChange={(e) => setMarketField('category', e.target.value)}
                      >
                        {CATEGORIES.filter(c => c.id !== 'all' && c.id !== 'ended').map(cat => (
                          <option key={cat.id} value={cat.id}>{cat.label}</option>
                        ))}
                      </select>
                    </div>
                    <div style={styles.formCol}>
                      <label style={styles.label}>End Date (UTC) *</label>
                      <button
                        type="button"
                        style={{
                          ...styles.input,
                          textAlign: 'left',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          color: newMarket.endDate ? COLORS.textPrimary : COLORS.textMuted
                        }}
                        onClick={() => setShowDatePicker(true)}
                      >
                        <span>
                          {newMarket.endDate 
                            ? new Date(newMarket.endDate).toLocaleString('en-US', {
                                timeZone: 'UTC',
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit'
                              }) + ' UTC'
                            : 'Select date and time...'
                          }
                        </span>
                        <span style={{color: COLORS.primary}}>&#128197;</span>
                      </button>
                    </div>
                  </div>

                  {/* How it works info */}
                  <div style={{...styles.resolutionInfoBox, marginTop: '24px'}}>
                    <div style={{display: 'flex', alignItems: 'flex-start', gap: '12px'}}>
                      <span style={{fontSize: '20px'}}>&#129302;</span>
                      <div>
                        <strong style={{color: COLORS.textPrimary}}>How Resolution Works</strong>
                        <p style={{margin: '8px 0 0 0', color: COLORS.textSecondary, fontSize: '13px', lineHeight: '1.6'}}>
                          @AgentBetsBot automatically detects the resolution source from your question 
                          (token prices via CoinGecko, followers via X API, etc.) and proposes an outcome at the end date.
                          An admin then confirms before funds are distributed.
                        </p>
                      </div>
                    </div>
                  </div>
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
                  {connected ? 'Launch Market' : 'Connect Wallet to Launch'}
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

          {/* Admin Panel View */}
          {view === 'admin' && isAdmin && (
            <div style={styles.adminPanel}>
              <h1 style={styles.pageTitle}>Admin Panel</h1>
              <p style={styles.formSubtitle}>Review and confirm pending market resolutions</p>

              {pendingResolutions.length === 0 ? (
                <div style={styles.emptyState}>
                  <div style={styles.emptyStateIcon}>
                    <span style={{fontSize: '64px', opacity: 0.4}}>&#9989;</span>
                  </div>
                  <h3 style={{fontFamily: 'Space Grotesk, sans-serif', fontSize: '24px', marginBottom: '12px'}}>All caught up!</h3>
                  <p style={{color: COLORS.textMuted}}>No markets pending confirmation</p>
                </div>
              ) : (
                <div style={styles.marketGrid}>
                  {pendingResolutions.map((market) => (
                    <div key={market.id} style={styles.adminCard}>
                      <div style={{marginBottom: '12px'}}>
                        <span style={styles.pendingBadge}>
                          &#9888; Pending Confirmation
                        </span>
                      </div>
                      
                      <h3 style={{...styles.marketQuestion, marginBottom: '16px'}}>{market.question}</h3>
                      
                      <div style={{fontSize: '13px', color: COLORS.textSecondary, marginBottom: '16px'}}>
                        <div style={{marginBottom: '6px'}}>
                          <strong>Category:</strong> {market.category}
                        </div>
                        <div style={{marginBottom: '6px'}}>
                          <strong>Ended:</strong> {new Date(market.endDate).toLocaleString()}
                        </div>
                        <div style={{marginBottom: '6px'}}>
                          <strong>Volume:</strong> ${((market.totalVolume || 0) / 1e6).toFixed(2)} USDC
                        </div>
                        <div>
                          <strong>Total Bets:</strong> {market.totalBets || 0}
                        </div>
                      </div>

                      {/* Bot's Proposed Resolution */}
                      {market.proposedResolution && (
                        <div style={styles.proposalBox}>
                          <div style={{fontWeight: '700', marginBottom: '10px', color: COLORS.textPrimary}}>
                            &#129302; Bot Proposal
                          </div>
                          <div style={{fontSize: '13px', color: COLORS.textSecondary}}>
                            <div style={{marginBottom: '6px'}}>
                              <strong>Outcome:</strong>{' '}
                              <span style={{
                                color: market.proposedResolution.outcome === 'YES' ? COLORS.success : COLORS.error,
                                fontWeight: '700'
                              }}>
                                {market.proposedResolution.outcome}
                              </span>
                            </div>
                            <div style={{marginBottom: '6px'}}>
                              <strong>Confidence:</strong> {market.proposedResolution.confidence || 0}%
                            </div>
                            {market.proposedResolution.evidence && (
                              <>
                                <div style={{marginBottom: '6px'}}>
                                  <strong>Source:</strong> {market.proposedResolution.evidence.source || market.resolutionSource}
                                </div>
                                {market.proposedResolution.evidence.actualValue && (
                                  <div style={{marginBottom: '6px'}}>
                                    <strong>Actual Value:</strong> {market.proposedResolution.evidence.actualValue}
                                  </div>
                                )}
                                {market.proposedResolution.evidence.threshold && (
                                  <div style={{marginBottom: '6px'}}>
                                    <strong>Threshold:</strong> {market.proposedResolution.evidence.threshold}
                                  </div>
                                )}
                              </>
                            )}
                            <div style={{fontSize: '11px', color: COLORS.textMuted, marginTop: '8px'}}>
                              Proposed: {new Date(market.proposedResolution.proposedAt).toLocaleString()}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Action Buttons */}
                      <div style={styles.adminBtnGroup}>
                        <button
                          style={{
                            ...styles.confirmYesBtn,
                            opacity: adminConfirming === market.id ? 0.6 : 1,
                            cursor: adminConfirming === market.id ? 'wait' : 'pointer'
                          }}
                          onClick={() => confirmResolution(market.id, 'YES')}
                          disabled={adminConfirming === market.id}
                        >
                          {adminConfirming === market.id ? 'Confirming...' : 'Confirm YES'}
                        </button>
                        <button
                          style={{
                            ...styles.confirmNoBtn,
                            opacity: adminConfirming === market.id ? 0.6 : 1,
                            cursor: adminConfirming === market.id ? 'wait' : 'pointer'
                          }}
                          onClick={() => confirmResolution(market.id, 'NO')}
                          disabled={adminConfirming === market.id}
                        >
                          {adminConfirming === market.id ? 'Confirming...' : 'Confirm NO'}
                        </button>
                      </div>
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
        <div style={styles.modalOverlay} onClick={() => { setSelectedMarket(null); setTxStatus(null); setBetConfirmation(null); }}>
          <div style={{
            ...styles.modal,
            ...(isMarketEnded(selectedMarket) ? { opacity: 0.5, filter: 'grayscale(60%)' } : {})
          }} className="bet-modal" onClick={(e) => e.stopPropagation()}>

            {/* Bet Confirmation Screen */}
            {betConfirmation ? (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '40px 20px',
                textAlign: 'center',
                minHeight: '350px'
              }}>
                {/* Green checkmark */}
                <div style={{
                  width: '72px',
                  height: '72px',
                  borderRadius: '50%',
                  background: `${COLORS.success}20`,
                  border: `3px solid ${COLORS.success}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '24px',
                  animation: 'fadeIn 0.3s ease'
                }}>
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={COLORS.success} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>

                <h2 style={{
                  fontSize: '24px',
                  fontWeight: '700',
                  color: COLORS.success,
                  marginBottom: '8px'
                }}>Bet Confirmed!</h2>

                <p style={{
                  fontSize: '14px',
                  color: COLORS.textMuted,
                  marginBottom: '24px',
                  maxWidth: '400px',
                  lineHeight: '1.5'
                }}>
                  Your wager has been confirmed on the Solana blockchain.
                </p>

                {/* Bet details card */}
                <div style={{
                  background: `${COLORS.bgCard}`,
                  border: `1px solid ${COLORS.borderLight}`,
                  borderRadius: '16px',
                  padding: '20px 28px',
                  marginBottom: '24px',
                  width: '100%',
                  maxWidth: '400px'
                }}>
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '12px'
                  }}>
                    <span style={{ color: COLORS.textMuted, fontSize: '13px' }}>Amount</span>
                    <span style={{ color: COLORS.primary, fontWeight: '700', fontSize: '16px', fontFamily: 'JetBrains Mono, monospace' }}>
                      {betConfirmation.amount} USDC
                    </span>
                  </div>
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '12px'
                  }}>
                    <span style={{ color: COLORS.textMuted, fontSize: '13px' }}>Side</span>
                    <span style={{
                      fontWeight: '700',
                      fontSize: '14px',
                      color: betConfirmation.outcome === 'YES' ? COLORS.success : COLORS.error,
                      background: betConfirmation.outcome === 'YES' ? `${COLORS.success}15` : `${COLORS.error}15`,
                      padding: '4px 12px',
                      borderRadius: '8px'
                    }}>
                      {betConfirmation.outcome}
                    </span>
                  </div>
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '12px'
                  }}>
                    <span style={{ color: COLORS.textMuted, fontSize: '13px' }}>Gas</span>
                    <span style={{ color: COLORS.textSecondary, fontSize: '13px' }}>
                      {betConfirmation.gasless ? 'Gasless (USDC fee)' : 'SOL'}
                    </span>
                  </div>
                  <div style={{
                    borderTop: `1px solid ${COLORS.borderLight}`,
                    paddingTop: '12px',
                    marginTop: '4px'
                  }}>
                    <p style={{
                      color: COLORS.textSecondary,
                      fontSize: '12px',
                      lineHeight: '1.5',
                      margin: 0
                    }}>
                      {betConfirmation.marketQuestion}
                    </p>
                  </div>
                </div>

                {/* Solscan link */}
                <a
                  href={`https://solscan.io/tx/${betConfirmation.signature}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    color: COLORS.secondary,
                    fontSize: '13px',
                    textDecoration: 'none',
                    marginBottom: '28px',
                    padding: '8px 16px',
                    borderRadius: '8px',
                    background: `${COLORS.secondary}10`,
                    border: `1px solid ${COLORS.secondary}25`,
                    transition: 'background 0.2s'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = `${COLORS.secondary}20`}
                  onMouseLeave={(e) => e.currentTarget.style.background = `${COLORS.secondary}10`}
                >
                  View on Solscan
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', opacity: 0.7 }}>
                    {betConfirmation.signature.slice(0, 8)}...{betConfirmation.signature.slice(-6)}
                  </span>
                  {Icons2.externalLink}
                </a>

                {/* Done button */}
                <button
                  onClick={() => {
                    setSelectedMarket(null)
                    setBetConfirmation(null)
                    setTxStatus(null)
                    setBetAmount('')
                  }}
                  style={{
                    background: `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.secondary})`,
                    color: '#000',
                    border: 'none',
                    borderRadius: '12px',
                    padding: '14px 48px',
                    fontSize: '16px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    transition: 'transform 0.2s, box-shadow 0.2s',
                    boxShadow: `0 4px 15px ${COLORS.primary}40`
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.03)'; e.currentTarget.style.boxShadow = `0 6px 20px ${COLORS.primary}60` }}
                  onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = `0 4px 15px ${COLORS.primary}40` }}
                >
                  Done
                </button>
              </div>
            ) : (
            <>
            <div style={styles.modalHeader}>
              <h2 style={{fontSize: '20px', fontWeight: '600', color: COLORS.textPrimary}}>
                {isMarketEnded(selectedMarket) ? 'Market Ended' : 'Place Your Bet'}
              </h2>
              <button style={styles.closeBtn} onClick={() => { setSelectedMarket(null); setTxStatus(null); setBetConfirmation(null); }}>
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

            {/* Main Content: Chart + Betting Side by Side */}
            <div style={styles.modalMainLayout} className="modal-main-layout">
              {/* LEFT: Chart Section - Main Focus */}
              <div style={styles.modalChartSection}>
                <h4 style={styles.chartTitle}>Odds History</h4>

                {/* Large Real-time Line Chart */}
                <div style={styles.modalLargeChart}>
                  {(() => {
                    const history = oddsHistoryCache[selectedMarket.id] || [];
                    
                    // Build data points with proper timestamps
                    const now = new Date();
                    const marketCreated = selectedMarket.createdAt ? new Date(selectedMarket.createdAt) : new Date(now.getTime() - 24 * 60 * 60 * 1000);
                    
                    const dataPoints = history.length >= 2
                      ? history.map(d => ({
                          time: d.timestamp ? new Date(d.timestamp).getTime() : 0,
                          yesOdds: d.yesOdds,
                          noOdds: d.noOdds
                        })).sort((a, b) => a.time - b.time)
                      : [
                          { time: marketCreated.getTime(), yesOdds: 0.5, noOdds: 0.5 },
                          { time: now.getTime(), yesOdds: selectedMarket.yesOdds, noOdds: selectedMarket.noOdds }
                        ];
                    
                    const chartWidth = 500;
                    const chartHeight = 220;
                    const padding = { left: 35, right: 15, top: 10, bottom: 40 };
                    const innerWidth = chartWidth - padding.left - padding.right;
                    const innerHeight = chartHeight - padding.top - padding.bottom;
                    
                    // Time range for x-axis
                    const timeMin = dataPoints[0].time;
                    const timeMax = dataPoints[dataPoints.length - 1].time;
                    const timeRange = timeMax - timeMin || 1;
                    
                    // Calculate x position from timestamp
                    const xForTime = (t) => padding.left + ((t - timeMin) / timeRange) * innerWidth;
                    
                    // Calculate path points for YES and NO using actual timestamps
                    const yesPoints = dataPoints.map(d => {
                      const x = xForTime(d.time);
                      const y = padding.top + (1 - d.yesOdds) * innerHeight;
                      return `${x},${y}`;
                    });
                    
                    const noPoints = dataPoints.map(d => {
                      const x = xForTime(d.time);
                      const y = padding.top + (1 - d.noOdds) * innerHeight;
                      return `${x},${y}`;
                    });
                    
                    const yesPath = `M${yesPoints.join(' L')}`;
                    const noPath = `M${noPoints.join(' L')}`;
                    const yesAreaPath = `M${padding.left},${chartHeight - padding.bottom} L${yesPoints.join(' L')} L${xForTime(timeMax)},${chartHeight - padding.bottom} Z`;
                    
                    // Generate time axis labels (up to 5 evenly spaced)
                    const spanMs = timeRange;
                    const spanHours = spanMs / (1000 * 60 * 60);
                    const labelCount = Math.min(5, dataPoints.length);
                    const timeLabels = [];
                    for (let i = 0; i < labelCount; i++) {
                      const t = timeMin + (i / (labelCount - 1)) * timeRange;
                      const date = new Date(t);
                      let label;
                      if (spanHours < 24) {
                        // Show hours:minutes
                        label = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                      } else if (spanHours < 24 * 30) {
                        // Show month/day
                        label = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
                      } else {
                        // Show month/day/year
                        label = date.toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' });
                      }
                      timeLabels.push({ x: xForTime(t), label });
                    }
                    
                    return (
                      <svg width="100%" height="220" viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="xMidYMid meet" style={{display: 'block'}}>
                        {/* Y-axis grid lines and labels */}
                        {[0, 25, 50, 75, 100].map(pct => {
                          const y = padding.top + ((100 - pct) / 100) * innerHeight;
                          return (
                            <g key={pct}>
                              <line x1={padding.left} y1={y} x2={chartWidth - padding.right} y2={y} stroke={COLORS.border} strokeWidth="1" strokeDasharray="4"/>
                              <text x={padding.left - 5} y={y + 3} fill={COLORS.textMuted} fontSize="10" fontFamily="JetBrains Mono" textAnchor="end">{pct}%</text>
                            </g>
                          );
                        })}
                        
                        {/* X-axis time labels */}
                        {timeLabels.map((tl, i) => (
                          <g key={i}>
                            <line x1={tl.x} y1={chartHeight - padding.bottom} x2={tl.x} y2={chartHeight - padding.bottom + 4} stroke={COLORS.border} strokeWidth="1"/>
                            <text x={tl.x} y={chartHeight - padding.bottom + 16} fill={COLORS.textMuted} fontSize="9" fontFamily="JetBrains Mono" textAnchor="middle">{tl.label}</text>
                          </g>
                        ))}
                        
                        {/* X-axis baseline */}
                        <line x1={padding.left} y1={chartHeight - padding.bottom} x2={chartWidth - padding.right} y2={chartHeight - padding.bottom} stroke={COLORS.border} strokeWidth="1"/>
                        
                        {/* YES area fill */}
                        <path d={yesAreaPath} fill={`${COLORS.success}15`} />
                        
                        {/* YES line */}
                        <path d={yesPath} fill="none" stroke={COLORS.success} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                        
                        {/* NO line */}
                        <path d={noPath} fill="none" stroke={COLORS.error} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                        
                        {/* Data point dots on lines */}
                        {dataPoints.map((d, i) => (
                          <g key={i}>
                            <circle cx={xForTime(d.time)} cy={padding.top + (1 - d.yesOdds) * innerHeight} r={i === dataPoints.length - 1 ? 5 : 3} fill={COLORS.success} opacity={i === dataPoints.length - 1 ? 1 : 0.6} />
                            <circle cx={xForTime(d.time)} cy={padding.top + (1 - d.noOdds) * innerHeight} r={i === dataPoints.length - 1 ? 5 : 3} fill={COLORS.error} opacity={i === dataPoints.length - 1 ? 1 : 0.6} />
                          </g>
                        ))}
                        
                        {/* Current value labels at the last point */}
                        <text x={xForTime(timeMax) + 2} y={padding.top + (1 - selectedMarket.yesOdds) * innerHeight - 8} fill={COLORS.success} fontSize="10" fontFamily="JetBrains Mono" fontWeight="700" textAnchor="end">
                          {Math.round(selectedMarket.yesOdds * 100)}%
                        </text>
                        <text x={xForTime(timeMax) + 2} y={padding.top + (1 - selectedMarket.noOdds) * innerHeight + 14} fill={COLORS.error} fontSize="10" fontFamily="JetBrains Mono" fontWeight="700" textAnchor="end">
                          {Math.round(selectedMarket.noOdds * 100)}%
                        </text>
                      </svg>
                    );
                  })()}
                </div>

                {/* Chart Legend */}
                <div style={styles.chartLegendLarge}>
                  <div style={styles.chartLegendItemLarge}>
                    <span style={{...styles.chartLegendDotLarge, background: COLORS.success}}></span>
                    <span style={{color: COLORS.success, fontWeight: '700', fontSize: '18px'}}>{formatOdds(selectedMarket.yesOdds)}</span>
                    <span style={{color: COLORS.textMuted, fontSize: '13px', marginLeft: '4px'}}>YES</span>
                  </div>
                  <div style={styles.chartLegendItemLarge}>
                    <span style={{...styles.chartLegendDotLarge, background: COLORS.error}}></span>
                    <span style={{color: COLORS.error, fontWeight: '700', fontSize: '18px'}}>{formatOdds(selectedMarket.noOdds)}</span>
                    <span style={{color: COLORS.textMuted, fontSize: '13px', marginLeft: '4px'}}>NO</span>
                  </div>
                </div>

                {/* Pool Stats Row */}
                <div style={styles.poolStatsRow} className="pool-stats-row">
                  <div style={styles.poolStatItemCompact}>
                    <span style={styles.poolStatLabelSmall}>Volume</span>
                    <span style={{...styles.poolStatValueSmall, color: COLORS.primary}}>
                      ${(selectedMarket.totalVolume / 1e6).toFixed(0)}
                    </span>
                  </div>
                  <div style={styles.poolStatItemCompact}>
                    <span style={styles.poolStatLabelSmall}>Bets</span>
                    <span style={styles.poolStatValueSmall}>{selectedMarket.totalBets || 0}</span>
                  </div>
                  <div style={styles.poolStatItemCompact}>
                    <span style={styles.poolStatLabelSmall}>YES Pool</span>
                    <span style={{...styles.poolStatValueSmall, color: COLORS.success}}>
                      ${(selectedMarket.yesPool / 1e6).toFixed(0)}
                    </span>
                  </div>
                  <div style={styles.poolStatItemCompact}>
                    <span style={styles.poolStatLabelSmall}>NO Pool</span>
                    <span style={{...styles.poolStatValueSmall, color: COLORS.error}}>
                      ${(selectedMarket.noPool / 1e6).toFixed(0)}
                    </span>
                  </div>
                </div>
              </div>

              {/* RIGHT: Betting Panel */}
              <div style={styles.modalBettingPanel} className="modal-betting-panel">
                {/* On-chain market badge */}
                {selectedMarket.onChain && (
                  <div style={styles.onchainIndicatorCompact}>
                    {Icons2.onchain}
                    <span>On-chain (USDC)</span>
                  </div>
                )}

                {/* USDC Balance Display */}
                {connected && walletBalance !== null && (
                  <div style={styles.balanceDisplayCompact}>
                    <span style={{color: COLORS.textMuted, fontSize: '12px'}}>USDC Balance</span>
                    <span style={{color: COLORS.primary, fontWeight: '600', fontSize: '14px'}}>{walletBalance?.toFixed(2)} USDC</span>
                  </div>
                )}
                {connected && walletBalance === null && (
                  <div style={{...styles.balanceDisplayCompact, borderColor: 'rgba(255,100,100,0.3)', flexDirection: 'column', gap: '6px'}}>
                    <span style={{color: '#ff6b6b', fontSize: '12px'}}>No USDC found in wallet</span>
                    <a 
                      href="https://jup.ag/swap/SOL-USDC" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      style={{
                        color: COLORS.primary, 
                        fontSize: '11px', 
                        textDecoration: 'underline',
                        cursor: 'pointer'
                      }}
                    >
                      Swap SOL for USDC on Jupiter →
                    </a>
                  </div>
                )}

                {/* Bet Amount Input */}
                <div style={styles.betInputSection}>
                  <label style={styles.labelCompact}>Amount (USDC)</label>
                  <input
                    style={styles.inputLarge}
                    type="number"
                    placeholder="10"
                    step="1"
                    min="1"
                    value={betAmount}
                    onChange={(e) => setBetAmount(e.target.value)}
                    disabled={txStatus?.type === 'pending' || isMarketEnded(selectedMarket)}
                  />
                  {gaslessConfig?.enabled && betAmount && parseFloat(betAmount) > 0 && (
                    <div style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '8px 12px',
                      background: `${COLORS.success}10`,
                      borderRadius: '8px',
                      border: `1px solid ${COLORS.success}30`,
                      marginTop: '6px',
                      fontSize: '12px'
                    }}>
                      <span style={{color: COLORS.success, fontWeight: '600'}}>No SOL needed</span>
                      <span style={{color: COLORS.textMuted}}>
                        Gas: {gaslessConfig.feeUsdc} USDC | Total: {(parseFloat(betAmount) + gaslessConfig.feeUsdc).toFixed(4)} USDC
                      </span>
                    </div>
                  )}

                  {/* Potential Payout Estimate */}
                  {betAmount && parseFloat(betAmount) > 0 && (() => {
                    const amt = parseFloat(betAmount)
                    const yesPool = (selectedMarket.yesPool || 0) / 1e6 // Convert from USDC micro-units
                    const noPool = (selectedMarket.noPool || 0) / 1e6
                    const totalPool = yesPool + noPool + amt
                    const PROTOCOL_FEE = 0.04 // 3% Poll.fun + 1% platform

                    // If user bets YES
                    const newYesPool = yesPool + amt
                    const yesGross = (amt / newYesPool) * (totalPool)
                    const yesPayout = yesGross * (1 - PROTOCOL_FEE)
                    const yesMultiplier = yesPayout / amt

                    // If user bets NO
                    const newNoPool = noPool + amt
                    const noGross = (amt / newNoPool) * (totalPool)
                    const noPayout = noGross * (1 - PROTOCOL_FEE)
                    const noMultiplier = noPayout / amt

                    return (
                      <div style={{
                        padding: '10px 12px',
                        background: `${COLORS.border}30`,
                        borderRadius: '8px',
                        border: `1px solid ${COLORS.border}`,
                        marginTop: '8px',
                        fontSize: '12px',
                        fontFamily: 'JetBrains Mono, monospace'
                      }}>
                        <div style={{color: COLORS.textMuted, fontSize: '10px', fontWeight: '600', marginBottom: '6px', letterSpacing: '0.5px'}}>
                          POTENTIAL PAYOUT
                        </div>
                        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px'}}>
                          <span style={{color: COLORS.success}}>
                            If YES wins
                          </span>
                          <span style={{color: COLORS.success, fontWeight: '700'}}>
                            {yesPayout.toFixed(2)} USDC ({yesMultiplier.toFixed(2)}x)
                          </span>
                        </div>
                        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                          <span style={{color: COLORS.error}}>
                            If NO wins
                          </span>
                          <span style={{color: COLORS.error, fontWeight: '700'}}>
                            {noPayout.toFixed(2)} USDC ({noMultiplier.toFixed(2)}x)
                          </span>
                        </div>
                        <div style={{color: COLORS.textMuted, fontSize: '9px', marginTop: '6px', opacity: 0.7}}>
                          Estimates based on current pool. Fees: 3% protocol + 1% platform.
                        </div>
                      </div>
                    )
                  })()}
                </div>

                {/* Large YES/NO Buttons */}
                <div style={styles.bettingButtonsVertical}>
                  <button
                    style={{
                      ...styles.betBtnYesLarge,
                      opacity: (txStatus?.type === 'pending' || isMarketEnded(selectedMarket)) ? 0.6 : 1,
                      cursor: (txStatus?.type === 'pending' || isMarketEnded(selectedMarket)) ? 'not-allowed' : 'pointer'
                    }}
                    onClick={() => placeBet('YES')}
                    disabled={txStatus?.type === 'pending' || isMarketEnded(selectedMarket)}
                    onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.02)'}
                    onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                  >
                    <span style={styles.betBtnLabelLarge}>BUY YES</span>
                    <span style={styles.betBtnOddsLarge}>{formatOdds(selectedMarket.yesOdds)}</span>
                  </button>
                  <button
                    style={{
                      ...styles.betBtnNoLarge,
                      opacity: (txStatus?.type === 'pending' || isMarketEnded(selectedMarket)) ? 0.6 : 1,
                      cursor: (txStatus?.type === 'pending' || isMarketEnded(selectedMarket)) ? 'not-allowed' : 'pointer'
                    }}
                    onClick={() => placeBet('NO')}
                    disabled={txStatus?.type === 'pending' || isMarketEnded(selectedMarket)}
                    onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.02)'}
                    onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                  >
                    <span style={styles.betBtnLabelLarge}>BUY NO</span>
                    <span style={styles.betBtnOddsLarge}>{formatOdds(selectedMarket.noOdds)}</span>
                  </button>
                </div>

                {/* Wallet hint */}
                {!connected && (
                  <div style={styles.walletHintCompact}>
                    {Icons.wallet}
                    <span>Connect wallet to bet</span>
                  </div>
                )}

                {/* TX Status */}
                {txStatus && (
                  <div style={{
                    ...styles.txStatusCompact,
                    background: txStatus.type === 'success' ? `${COLORS.success}15` : 
                               txStatus.type === 'error' ? `${COLORS.error}15` : `${COLORS.primary}15`,
                    borderColor: txStatus.type === 'success' ? COLORS.success : 
                                txStatus.type === 'error' ? COLORS.error : COLORS.primary,
                    color: txStatus.type === 'success' ? COLORS.success : 
                          txStatus.type === 'error' ? COLORS.error : COLORS.primary
                  }}>
                    {txStatus.message}
                  </div>
                )}

                {/* Market ends info */}
                <div style={styles.marketEndsCompact}>
                  <span style={{color: COLORS.textMuted, fontSize: '11px'}}>Ends</span>
                  <span style={{color: COLORS.textSecondary, fontSize: '12px', fontWeight: '500'}}>
                    {new Date(selectedMarket.endDate).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'})}
                  </span>
                </div>
              </div>
            </div>
            </>
            )}
          </div>
        </div>
      )}

      {/* Date Picker Modal */}
      {showDatePicker && (
        <div style={styles.modalOverlay} onClick={() => setShowDatePicker(false)}>
          <div style={styles.datePickerModal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <div>
                <h2 style={{fontSize: '20px', fontWeight: '600', color: COLORS.textPrimary}}>Select End Date & Time</h2>
                <div style={{fontSize: '11px', color: COLORS.textMuted, fontFamily: 'JetBrains Mono, monospace', marginTop: '4px'}}>
                  Current UTC: {new Date().toISOString().slice(0, 19).replace('T', ' ')}
                </div>
              </div>
              <button style={styles.closeBtn} onClick={() => setShowDatePicker(false)}>
                {Icons.x}
              </button>
            </div>
            
            <div style={styles.datePickerContent}>
              {/* Quick Presets */}
              <div style={styles.datePickerSection}>
                <label style={styles.datePickerLabel}>Quick Select (UTC)</label>
                <div style={styles.datePresetGrid}>
                  {[
                    { label: '1 Hour', hours: 1 },
                    { label: '6 Hours', hours: 6 },
                    { label: '12 Hours', hours: 12 },
                    { label: '1 Day', hours: 24 },
                    { label: '3 Days', hours: 72 },
                    { label: '1 Week', hours: 168 },
                    { label: '2 Weeks', hours: 336 },
                    { label: '1 Month', hours: 720 }
                  ].map((preset) => (
                    <button
                      key={preset.label}
                      style={styles.datePresetBtn}
                      onClick={() => {
                        // Calculate future time from current UTC time
                        const now = new Date();
                        const futureTime = new Date(now.getTime() + preset.hours * 60 * 60 * 1000);
                        // Format as YYYY-MM-DDTHH:MM for datetime-local input
                        const year = futureTime.getUTCFullYear();
                        const month = String(futureTime.getUTCMonth() + 1).padStart(2, '0');
                        const day = String(futureTime.getUTCDate()).padStart(2, '0');
                        const hours = String(futureTime.getUTCHours()).padStart(2, '0');
                        const minutes = String(futureTime.getUTCMinutes()).padStart(2, '0');
                        const formatted = `${year}-${month}-${day}T${hours}:${minutes}`;
                        setMarketField('endDate', formatted);
                        // Don't close modal - let user review and confirm
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = COLORS.primary;
                        e.currentTarget.style.background = COLORS.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = COLORS.border;
                        e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Custom Date/Time */}
              <div style={styles.datePickerSection}>
                <label style={styles.datePickerLabel}>Custom Date & Time (UTC)</label>
                <div style={styles.dateTimeInputs}>
                  <div style={styles.dateInputGroup}>
                    <label style={{...styles.datePickerLabel, fontSize: '11px'}}>Date</label>
                    <input
                      type="date"
                      style={styles.dateTimeInput}
                      value={newMarket.endDate ? newMarket.endDate.split('T')[0] : ''}
                      min={new Date().toISOString().split('T')[0]}
                      onChange={(e) => {
                        const time = newMarket.endDate ? newMarket.endDate.split('T')[1] || '12:00' : '12:00';
                        setMarketField('endDate', `${e.target.value}T${time}`);
                      }}
                    />
                  </div>
                  <div style={styles.dateInputGroup}>
                    <label style={{...styles.datePickerLabel, fontSize: '11px'}}>Time (UTC)</label>
                    <input
                      type="time"
                      style={styles.dateTimeInput}
                      value={newMarket.endDate ? newMarket.endDate.split('T')[1]?.slice(0, 5) || '12:00' : '12:00'}
                      onChange={(e) => {
                        const date = newMarket.endDate ? newMarket.endDate.split('T')[0] : new Date().toISOString().split('T')[0];
                        setMarketField('endDate', `${date}T${e.target.value}`);
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Preview */}
              {newMarket.endDate && (
                <div style={styles.datePreview}>
                  <div style={{display: 'flex', flexDirection: 'column', gap: '8px', width: '100%'}}>
                    <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                      <span style={{color: COLORS.textMuted, fontSize: '12px'}}>Market ends:</span>
                      <span style={{color: COLORS.primary, fontWeight: '600', fontFamily: 'JetBrains Mono, monospace', fontSize: '13px'}}>
                        {formatDateTimeLocal(newMarket.endDate)}
                      </span>
                    </div>
                    <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                      <span style={{color: COLORS.textMuted, fontSize: '12px'}}>Countdown:</span>
                      <span style={{
                        color: COLORS.success, 
                        fontWeight: '700', 
                        fontFamily: 'JetBrains Mono, monospace', 
                        fontSize: '16px',
                        letterSpacing: '0.5px'
                      }}>
                        {formatCountdown(newMarket.endDate, countdownTick)}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Confirm Button */}
              <button
                style={styles.datePickerConfirmBtn}
                onClick={() => setShowDatePicker(false)}
                disabled={!newMarket.endDate}
                onMouseEnter={(e) => {
                  if (newMarket.endDate) e.currentTarget.style.transform = 'translateY(-2px)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                <span style={{fontSize: '18px'}}>&#10003;</span>
                Confirm Date
              </button>
            </div>
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
    background: COLORS.bgDark,
    width: '100%',
    maxWidth: '100vw',
    overflowX: 'hidden',
    boxSizing: 'border-box'
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
    borderLeft: `3px solid ${COLORS.primary}`
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
    minHeight: '100vh',
    width: 'calc(100% - 260px)',
    maxWidth: 'calc(100vw - 260px)',
    overflowX: 'hidden'
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
    zIndex: 100,
    flexWrap: 'wrap',
    gap: '12px',
    boxSizing: 'border-box',
    width: '100%'
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
    opacity: 0.7,
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
    background: `${COLORS.success}20`,
    borderRadius: '20px',
    fontSize: '12px',
    color: COLORS.success,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.5px'
  },
  networkDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: COLORS.success,
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
    padding: '24px',
    maxWidth: '100%',
    overflowX: 'hidden',
    boxSizing: 'border-box'
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
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: '16px',
    marginBottom: '32px',
    padding: '20px',
    background: COLORS.bgCard,
    borderRadius: '16px',
    border: `1px solid ${COLORS.border}`,
    width: '100%',
    boxSizing: 'border-box'
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
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(380px, 100%), 1fr))',
    gap: '24px',
    maxWidth: '100%',
    margin: '0',
    width: '100%'
  },
  marketCard: {
    background: COLORS.bgCard,
    borderRadius: '20px',
    padding: '24px',
    border: `1px solid ${COLORS.border}`,
    cursor: 'pointer',
    transition: 'all 0.25s ease',
    position: 'relative',
    animation: 'fadeIn 0.4s ease forwards',
    minHeight: '280px',
    display: 'flex',
    flexDirection: 'column'
  },
  cardNumberBadge: {
    position: 'absolute',
    top: '16px',
    right: '16px',
    fontSize: '12px',
    opacity: 0.6
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
    opacity: 0.8
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
    lineHeight: '1.5',
    marginBottom: '16px',
    color: COLORS.textPrimary,
    flex: '1',
    display: '-webkit-box',
    WebkitLineClamp: 3,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  },
  verificationInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '12px',
    flexWrap: 'wrap'
  },
  miniChartContainer: {
    marginBottom: '12px',
    padding: '8px 0',
    borderRadius: '8px',
    background: `${COLORS.bgDark}50`,
    height: '36px',
    overflow: 'hidden'
  },
  modalChartContainer: {
    marginBottom: '16px',
    padding: '16px',
    borderRadius: '12px',
    background: COLORS.bgDark,
    border: `1px solid ${COLORS.border}`
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
    height: '44px',
    borderRadius: '12px',
    overflow: 'hidden',
    marginBottom: '16px',
    marginTop: 'auto',
    gap: '3px',
    background: COLORS.bgDark
  },
  yesBar: {
    background: COLORS.gradientGreen,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#000',
    fontSize: '13px',
    fontWeight: '700',
    minWidth: '80px',
    borderRadius: '10px 0 0 10px',
    transition: 'width 0.3s ease'
  },
  noBar: {
    background: COLORS.gradientRed,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    fontSize: '13px',
    fontWeight: '700',
    minWidth: '80px',
    borderRadius: '0 10px 10px 0',
    transition: 'width 0.3s ease'
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
    opacity: 0.8
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
    maxWidth: '900px',
    width: '100%',
    boxSizing: 'border-box'
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
  resolutionInfoBox: {
    padding: '16px',
    background: `${COLORS.secondary}10`,
    border: `1px solid ${COLORS.secondary}30`,
    borderRadius: '12px',
    marginBottom: '16px',
    fontSize: '13px'
  },
  pendingBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 10px',
    background: `${COLORS.warning}20`,
    color: COLORS.warning,
    borderRadius: '6px',
    fontSize: '11px',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.5px'
  },
  proposalBox: {
    padding: '16px',
    background: `${COLORS.warning}10`,
    border: `1px solid ${COLORS.warning}30`,
    borderRadius: '12px',
    marginTop: '12px'
  },
  adminSection: {
    borderTop: `1px solid ${COLORS.border}`,
    marginTop: 'auto',
    paddingTop: '16px'
  },
  adminPanel: {
    padding: '24px'
  },
  adminCard: {
    background: COLORS.bgCard,
    borderRadius: '16px',
    padding: '20px',
    border: `1px solid ${COLORS.border}`,
    marginBottom: '16px'
  },
  adminBtnGroup: {
    display: 'flex',
    gap: '12px',
    marginTop: '16px'
  },
  confirmYesBtn: {
    flex: 1,
    padding: '12px 20px',
    background: COLORS.success,
    color: '#000',
    border: 'none',
    borderRadius: '10px',
    cursor: 'pointer',
    fontWeight: '600',
    fontSize: '14px',
    transition: 'all 0.2s'
  },
  confirmNoBtn: {
    flex: 1,
    padding: '12px 20px',
    background: COLORS.error,
    color: '#fff',
    border: 'none',
    borderRadius: '10px',
    cursor: 'pointer',
    fontWeight: '600',
    fontSize: '14px',
    transition: 'all 0.2s'
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
    backdropFilter: 'blur(8px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: '20px'
  },
  modal: {
    background: COLORS.bgCard,
    borderRadius: '24px',
    padding: '32px',
    width: '900px',
    maxWidth: '95vw',
    maxHeight: '90vh',
    overflowY: 'auto',
    border: `1px solid ${COLORS.borderLight}`,
    boxShadow: `0 25px 50px -12px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(20, 241, 149, 0.1)`
  },
  modalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '20px',
    paddingBottom: '16px',
    borderBottom: `1px solid ${COLORS.border}`
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
    fontSize: '18px',
    fontWeight: '600',
    color: COLORS.textPrimary,
    marginBottom: '24px',
    lineHeight: '1.5'
  },
  modalDetails: {
    background: COLORS.bgDark,
    borderRadius: '16px',
    padding: '20px',
    marginBottom: '24px',
    border: `1px solid ${COLORS.border}`
  },
  modalDetailRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: '10px 0',
    fontSize: '14px',
    gap: '16px',
    borderBottom: `1px solid ${COLORS.border}08`
  },
  modalDetailLabel: {
    color: COLORS.textSecondary,
    fontWeight: '500',
    flexShrink: 0,
    fontSize: '13px'
  },
  modalDetailValue: {
    color: COLORS.textPrimary,
    textAlign: 'right',
    wordBreak: 'break-word',
    fontWeight: '500'
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
    padding: '16px 20px',
    background: COLORS.bgDark,
    borderRadius: '14px',
    marginBottom: '20px',
    fontSize: '15px',
    color: COLORS.textSecondary,
    border: `1px solid ${COLORS.border}`
  },
  betButtons: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '16px',
    marginTop: '8px'
  },
  yesBtn: {
    padding: '18px 24px',
    background: COLORS.gradientGreen,
    border: 'none',
    borderRadius: '14px',
    color: '#000',
    fontSize: '16px',
    fontWeight: '700',
    cursor: 'pointer',
    transition: 'all 0.2s ease'
  },
  noBtn: {
    padding: '18px 24px',
    background: COLORS.gradientRed,
    border: 'none',
    borderRadius: '14px',
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
  },
  // Modal Main Layout - Chart + Betting Side by Side
  modalMainLayout: {
    display: 'grid',
    gridTemplateColumns: '1fr 280px',
    gap: '24px',
    marginBottom: '16px'
  },
  modalChartSection: {
    background: COLORS.bgDark,
    borderRadius: '16px',
    padding: '20px',
    border: `1px solid ${COLORS.border}`,
    display: 'flex',
    flexDirection: 'column'
  },
  modalLargeChart: {
    marginBottom: '16px',
    padding: '12px',
    background: `${COLORS.bgCard}50`,
    borderRadius: '12px',
    minHeight: '200px'
  },
  chartLegendLarge: {
    display: 'flex',
    justifyContent: 'center',
    gap: '32px',
    marginBottom: '16px'
  },
  chartLegendItemLarge: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px'
  },
  chartLegendDotLarge: {
    width: '12px',
    height: '12px',
    borderRadius: '50%'
  },
  poolStatsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: '12px',
    padding: '12px',
    background: `${COLORS.bgCard}50`,
    borderRadius: '10px'
  },
  poolStatItemCompact: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '2px'
  },
  poolStatLabelSmall: {
    fontSize: '11px',
    color: COLORS.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: '0.5px'
  },
  poolStatValueSmall: {
    fontSize: '14px',
    fontWeight: '600',
    color: COLORS.textPrimary,
    fontFamily: 'JetBrains Mono, monospace'
  },
  modalBettingPanel: {
    background: COLORS.bgDark,
    borderRadius: '16px',
    padding: '20px',
    border: `1px solid ${COLORS.border}`,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px'
  },
  onchainIndicatorCompact: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 12px',
    background: `${COLORS.primary}15`,
    borderRadius: '8px',
    fontSize: '12px',
    color: COLORS.primary,
    fontWeight: '500'
  },
  balanceDisplayCompact: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 12px',
    background: `${COLORS.bgCard}`,
    borderRadius: '10px',
    border: `1px solid ${COLORS.border}`
  },
  betInputSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px'
  },
  labelCompact: {
    fontSize: '12px',
    color: COLORS.textSecondary,
    fontWeight: '500'
  },
  inputLarge: {
    padding: '14px 16px',
    background: COLORS.bgCard,
    border: `2px solid ${COLORS.border}`,
    borderRadius: '12px',
    color: COLORS.textPrimary,
    fontSize: '18px',
    fontWeight: '600',
    fontFamily: 'JetBrains Mono, monospace',
    outline: 'none',
    transition: 'border-color 0.2s',
    textAlign: 'center'
  },
  bettingButtonsVertical: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    marginTop: '8px'
  },
  betBtnYesLarge: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '18px 20px',
    background: `linear-gradient(135deg, ${COLORS.success} 0%, ${COLORS.success}dd 100%)`,
    border: 'none',
    borderRadius: '14px',
    color: '#000',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    boxShadow: `0 4px 20px ${COLORS.success}40`
  },
  betBtnNoLarge: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '18px 20px',
    background: `linear-gradient(135deg, ${COLORS.error} 0%, ${COLORS.error}dd 100%)`,
    border: 'none',
    borderRadius: '14px',
    color: '#fff',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    boxShadow: `0 4px 20px ${COLORS.error}40`
  },
  betBtnLabelLarge: {
    fontSize: '16px',
    fontWeight: '700',
    letterSpacing: '0.5px'
  },
  betBtnOddsLarge: {
    fontSize: '18px',
    fontWeight: '700',
    fontFamily: 'JetBrains Mono, monospace'
  },
  walletHintCompact: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    padding: '10px',
    background: `${COLORS.primary}10`,
    borderRadius: '10px',
    fontSize: '12px',
    color: COLORS.textMuted
  },
  txStatusCompact: {
    padding: '10px 14px',
    borderRadius: '10px',
    border: '1px solid',
    fontSize: '12px',
    fontWeight: '500',
    textAlign: 'center'
  },
  marketEndsCompact: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    background: `${COLORS.bgCard}50`,
    borderRadius: '8px',
    marginTop: 'auto'
  },
  // Chart and Activity Styles
  chartSection: {
    marginBottom: '24px',
    padding: '20px',
    background: COLORS.bgDark,
    borderRadius: '16px',
    border: `1px solid ${COLORS.border}`
  },
  chartTitle: {
    fontSize: '13px',
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginBottom: '16px',
    textTransform: 'uppercase',
    letterSpacing: '1px'
  },
  oddsChartContainer: {
    marginBottom: '16px'
  },
  oddsChartBar: {
    display: 'flex',
    height: '48px',
    borderRadius: '8px',
    overflow: 'hidden',
    background: COLORS.bgDark
  },
  oddsChartYes: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 12px',
    background: `linear-gradient(135deg, ${COLORS.success}dd, ${COLORS.success}99)`,
    color: '#000',
    fontWeight: '600',
    fontSize: '14px',
    minWidth: '60px',
    transition: 'width 0.3s ease'
  },
  oddsChartNo: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 12px',
    background: `linear-gradient(135deg, ${COLORS.error}dd, ${COLORS.error}99)`,
    color: '#fff',
    fontWeight: '600',
    fontSize: '14px',
    minWidth: '60px',
    transition: 'width 0.3s ease'
  },
  oddsChartLabel: {
    fontSize: '12px',
    opacity: 0.9
  },
  oddsChartValue: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: '14px'
  },
  poolStats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: '12px',
    marginTop: '8px'
  },
  poolStatItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '14px 10px',
    background: COLORS.bgCard,
    borderRadius: '12px',
    border: `1px solid ${COLORS.border}`
  },
  poolStatLabel: {
    fontSize: '11px',
    color: COLORS.textSecondary,
    textTransform: 'uppercase',
    marginBottom: '4px'
  },
  poolStatValue: {
    fontSize: '14px',
    fontWeight: '600',
    fontFamily: 'JetBrains Mono, monospace',
    color: COLORS.textPrimary
  },
  modalActivitySection: {
    marginBottom: '20px',
    padding: '16px',
    background: `${COLORS.bgCard}`,
    borderRadius: '12px',
    border: `1px solid ${COLORS.border}`
  },
  modalActivityList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px'
  },
  modalActivityItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px',
    background: COLORS.bgDark,
    borderRadius: '8px',
    fontSize: '13px'
  },
  modalActivitySide: {
    fontWeight: '600',
    width: '40px'
  },
  modalActivityAmount: {
    flex: 1,
    textAlign: 'center',
    fontFamily: 'JetBrains Mono, monospace',
    color: COLORS.textPrimary
  },
  modalActivityTime: {
    color: COLORS.textMuted,
    fontSize: '12px',
    width: '60px',
    textAlign: 'right'
  },
  noActivity: {
    padding: '20px',
    textAlign: 'center',
    color: COLORS.textMuted,
    fontSize: '13px'
  },
  // Trading Interface Styles
  tradingInterface: {
    borderTop: `1px solid ${COLORS.border}`,
    paddingTop: '20px',
    marginTop: '8px'
  },
  tradingButtons: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px',
    marginTop: '16px'
  },
  tradingBtnYes: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    padding: '16px 20px',
    background: `linear-gradient(135deg, ${COLORS.success} 0%, ${COLORS.success}cc 100%)`,
    border: 'none',
    borderRadius: '12px',
    color: '#000',
    fontSize: '15px',
    fontWeight: '700',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    boxShadow: `0 4px 20px ${COLORS.success}40`
  },
  tradingBtnNo: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    padding: '16px 20px',
    background: `linear-gradient(135deg, ${COLORS.error} 0%, ${COLORS.error}cc 100%)`,
    border: 'none',
    borderRadius: '12px',
    color: '#fff',
    fontSize: '15px',
    fontWeight: '700',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    boxShadow: `0 4px 20px ${COLORS.error}40`
  },
  tradingBtnLabel: {
    fontSize: '14px',
    fontWeight: '700',
    letterSpacing: '0.5px'
  },
  tradingBtnOdds: {
    fontSize: '18px',
    fontWeight: '800',
    fontFamily: 'JetBrains Mono, monospace'
  },
  walletHint: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    marginTop: '16px',
    padding: '12px',
    background: `${COLORS.secondary}15`,
    borderRadius: '10px',
    color: COLORS.textSecondary,
    fontSize: '13px'
  },
  walletHintIcon: {
    display: 'flex',
    transform: 'scale(0.9)',
    color: COLORS.secondary
  },
  // Chart Styles (used in modal)
  chartLegend: {
    display: 'flex',
    justifyContent: 'center',
    gap: '24px',
    marginTop: '12px',
    fontSize: '13px',
    fontWeight: '600'
  },
  chartLegendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px'
  },
  chartLegendDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    display: 'inline-block'
  },
  // Order Book Styles
  orderBookContainer: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '16px',
    marginBottom: '20px'
  },
  orderBookSide: {
    background: COLORS.bgCard,
    borderRadius: '12px',
    padding: '12px',
    overflow: 'hidden'
  },
  orderBookHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '14px',
    fontWeight: '700',
    marginBottom: '8px',
    fontFamily: 'JetBrains Mono, monospace'
  },
  orderBookBar: {
    height: '32px',
    borderRadius: '6px',
    display: 'flex',
    alignItems: 'center',
    paddingLeft: '10px'
  },
  orderBookPool: {
    fontSize: '12px',
    fontWeight: '600',
    color: COLORS.textSecondary,
    fontFamily: 'JetBrains Mono, monospace'
  },
  // Date Picker Modal Styles
  datePickerModal: {
    background: COLORS.bgCard,
    borderRadius: '24px',
    padding: '32px',
    width: '480px',
    maxWidth: '95vw',
    maxHeight: '90vh',
    overflowY: 'auto',
    border: `1px solid ${COLORS.borderLight}`,
    boxShadow: `0 25px 50px -12px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(20, 241, 149, 0.1)`
  },
  datePickerContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px'
  },
  datePickerSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px'
  },
  datePickerLabel: {
    fontSize: '13px',
    fontWeight: '600',
    color: COLORS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: '0.5px'
  },
  datePresetGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: '10px'
  },
  datePresetBtn: {
    padding: '12px 8px',
    background: 'transparent',
    border: `1px solid ${COLORS.border}`,
    borderRadius: '10px',
    color: COLORS.textSecondary,
    fontSize: '13px',
    fontWeight: '500',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    fontFamily: 'Space Grotesk, sans-serif'
  },
  dateTimeInputs: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '16px'
  },
  dateInputGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px'
  },
  dateTimeInput: {
    padding: '14px 16px',
    background: COLORS.bgDark,
    border: `1px solid ${COLORS.borderLight}`,
    borderRadius: '12px',
    color: COLORS.textPrimary,
    fontSize: '15px',
    outline: 'none',
    fontFamily: 'JetBrains Mono, monospace',
    cursor: 'pointer'
  },
  datePreview: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '16px',
    background: `${COLORS.primary}08`,
    border: `1px solid ${COLORS.primary}25`,
    borderRadius: '12px',
    textAlign: 'left'
  },
  datePickerConfirmBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    padding: '16px 24px',
    background: COLORS.gradientPrimary,
    border: 'none',
    borderRadius: '14px',
    color: COLORS.bgDark,
    fontSize: '16px',
    fontWeight: '700',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    fontFamily: 'Space Grotesk, sans-serif'
  }
}

export default App
