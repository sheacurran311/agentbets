# AgentBets - Prediction Markets for AI Agents

## Overview
AgentBets is a prediction markets platform for AI Agent outcomes built on Solana. The platform allows users to create and trade prediction markets focused on AI agent performance, milestones, and outcomes.

**Current State:** Successfully migrated from GitHub and running on Replit. Both frontend and API servers are operational.

## Project Architecture

### Directory Structure
```
/
├── api/                    # Express.js backend API
│   ├── src/
│   │   ├── index.js       # Main API server (port 3002)
│   │   ├── routes/        # API route handlers
│   │   └── services/      # Business logic services
│   └── package.json
├── frontend/              # Vite + React frontend
│   ├── src/
│   │   ├── App.jsx        # Main React app
│   │   ├── WalletProvider.jsx  # Solana wallet integration
│   │   └── components/    # React components
│   ├── vite.config.js     # Vite configuration (port 5000)
│   └── package.json
└── bot/                   # Twitter bot integration (optional)
```

### Tech Stack
- **Frontend:** Vite 5 + React 18 + TailwindCSS
- **Backend:** Express.js
- **Blockchain:** Solana (devnet)
- **Wallet Support:** Phantom, Solflare, Coinbase

## Running the Application

### Workflow
The application runs via the "AgentBets App" workflow which uses `concurrently` to start both servers:
- **API Server:** http://localhost:3002
- **Frontend:** http://localhost:5000 (exposed externally)

### Environment Variables
| Variable | Description | Required |
|----------|-------------|----------|
| SOLANA_PRIVATE_KEY | Solana wallet private key for transactions | No (runs in read-only mode without it) |

## Development Notes

### Key Configuration Decisions
1. **Wallet Adapters:** Using specific packages (`@solana/wallet-adapter-phantom`, `-solflare`, `-coinbase`) instead of the umbrella `@solana/wallet-adapter-wallets` to avoid problematic dependencies like `@particle-network/chains`

2. **Vite Config:** 
   - Port 5000 with `host: '0.0.0.0'` and `allowedHosts: true` for Replit compatibility
   - Proxy configured to forward `/api/*` requests to the backend on port 3002
   - File watcher ignores backup node_modules directories to prevent ENOSPC errors

3. **Workflow Command:** Uses `node ./node_modules/vite/bin/vite.js` directly due to missing .bin symlinks after dependency resolution

### Known Issues
- Deep node_modules nesting with Solana packages can cause file watcher exhaustion - mitigated by ignoring backup directories in Vite config
- "Buffer" module externalization warning in browser console is expected (browser compatibility)

## Recent Changes
- **2026-02-05:** Initial migration to Replit completed
  - Configured Vite for Replit environment
  - Resolved Solana wallet adapter dependency issues
  - Set up concurrent workflow for API + frontend
  - Fixed file watcher exhaustion issues

## User Preferences
(None recorded yet)
