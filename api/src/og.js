/**
 * Dynamic Open Graph Image Generation for AgentBets
 * 
 * Generates branded 1200x630 PNG preview images for each market,
 * used in Twitter/X cards, Discord embeds, and other social previews.
 * 
 * Uses satori (JSX -> SVG) + @resvg/resvg-js (SVG -> PNG)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { Resvg } = require('@resvg/resvg-js');

const router = express.Router();

// Load fonts once at startup
const interBoldPath = path.join(__dirname, '../public/Inter-Bold.ttf');
const interRegularPath = path.join(__dirname, '../public/Inter-Regular.ttf');

let interBold, interRegular;
try {
  interBold = fs.readFileSync(interBoldPath);
  interRegular = fs.readFileSync(interRegularPath);
  console.log('[OG] Fonts loaded successfully');
} catch (err) {
  console.error('[OG] Failed to load fonts:', err.message);
}

// Load and base64-encode the logo for embedding in SVG
const logoPath = path.join(__dirname, '../public/icon.png');
let logoBase64 = '';
try {
  const logoBuffer = fs.readFileSync(logoPath);
  logoBase64 = `data:image/png;base64,${logoBuffer.toString('base64')}`;
  console.log('[OG] Logo loaded successfully');
} catch (err) {
  console.error('[OG] Failed to load logo:', err.message);
}

// Fallback image path
const fallbackImagePath = path.join(__dirname, '../../frontend/public/market-preview.png');

/**
 * Dynamically import satori (ESM module)
 */
let satoriModule = null;
async function getSatori() {
  if (!satoriModule) {
    satoriModule = await import('satori');
  }
  return satoriModule.default;
}

/**
 * Generate OG image markup for a market
 */
function buildMarketCard(market, yesPercent, noPercent, totalPool, totalBets) {
  const question = market.question.length > 120 
    ? market.question.substring(0, 117) + '...' 
    : market.question;
  
  const endDate = market.endDate 
    ? new Date(market.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  const statusLabel = market.status === 'active' ? 'LIVE' : market.status?.toUpperCase() || 'CLOSED';
  const statusColor = market.status === 'active' ? '#00e676' : '#ff6565';
  
  const yesWidth = Math.max(yesPercent, 5);
  const noWidth = Math.max(noPercent, 5);

  // Satori uses a JSX-like object format (React createElement style)
  // { type, props: { style, children } }
  return {
    type: 'div',
    props: {
      style: {
        width: '1200px',
        height: '630px',
        display: 'flex',
        flexDirection: 'column',
        background: 'linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 50%, #16213e 100%)',
        padding: '48px 56px',
        fontFamily: 'Inter',
        color: '#ffffff',
      },
      children: [
        // Header row: logo + status badge
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '32px',
            },
            children: [
              // Logo + brand
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '16px',
                  },
                  children: [
                    logoBase64 ? {
                      type: 'img',
                      props: {
                        src: logoBase64,
                        width: 56,
                        height: 56,
                        style: { borderRadius: '12px' },
                      },
                    } : null,
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '32px',
                          fontWeight: 700,
                          color: '#a78bfa',
                          letterSpacing: '-0.5px',
                        },
                        children: 'AgentBets',
                      },
                    },
                  ].filter(Boolean),
                },
              },
              // Status badge
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    background: 'rgba(255,255,255,0.08)',
                    borderRadius: '24px',
                    padding: '8px 20px',
                    border: `1px solid ${statusColor}33`,
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          width: '10px',
                          height: '10px',
                          borderRadius: '50%',
                          background: statusColor,
                        },
                        children: '',
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '18px',
                          fontWeight: 700,
                          color: statusColor,
                          letterSpacing: '1px',
                        },
                        children: statusLabel,
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
        // Question
        {
          type: 'div',
          props: {
            style: {
              fontSize: question.length > 80 ? '36px' : '42px',
              fontWeight: 700,
              lineHeight: 1.3,
              color: '#ffffff',
              marginBottom: '36px',
              flexGrow: 1,
              display: 'flex',
              alignItems: 'flex-start',
            },
            children: question,
          },
        },
        // Probability bar
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              width: '100%',
              height: '56px',
              borderRadius: '16px',
              overflow: 'hidden',
              marginBottom: '24px',
              border: '1px solid rgba(255,255,255,0.1)',
            },
            children: [
              // YES bar
              {
                type: 'div',
                props: {
                  style: {
                    width: `${yesWidth}%`,
                    background: 'linear-gradient(90deg, #00c853, #00e676)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '22px',
                    fontWeight: 700,
                    color: '#0a1f0a',
                    paddingLeft: '16px',
                    paddingRight: '16px',
                  },
                  children: `YES ${yesPercent}%`,
                },
              },
              // NO bar
              {
                type: 'div',
                props: {
                  style: {
                    width: `${noWidth}%`,
                    background: 'linear-gradient(90deg, #ff5252, #ff1744)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '22px',
                    fontWeight: 700,
                    color: '#1f0a0a',
                    paddingLeft: '16px',
                    paddingRight: '16px',
                  },
                  children: `NO ${noPercent}%`,
                },
              },
            ],
          },
        },
        // Footer: stats + CTA
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            },
            children: [
              // Stats
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    gap: '32px',
                    fontSize: '20px',
                    color: '#a0a0b8',
                  },
                  children: [
                    totalPool > 0 ? {
                      type: 'div',
                      props: {
                        style: { display: 'flex', gap: '6px' },
                        children: [
                          { type: 'div', props: { style: { color: '#a78bfa', fontWeight: 700 }, children: `${totalPool.toFixed(2)}` } },
                          { type: 'div', props: { children: 'USDC Pool' } },
                        ],
                      },
                    } : null,
                    totalBets > 0 ? {
                      type: 'div',
                      props: {
                        style: { display: 'flex', gap: '6px' },
                        children: [
                          { type: 'div', props: { style: { color: '#a78bfa', fontWeight: 700 }, children: `${totalBets}` } },
                          { type: 'div', props: { children: totalBets === 1 ? 'Bet' : 'Bets' } },
                        ],
                      },
                    } : null,
                    endDate ? {
                      type: 'div',
                      props: {
                        style: { display: 'flex', gap: '6px' },
                        children: [
                          { type: 'div', props: { children: 'Ends' } },
                          { type: 'div', props: { style: { color: '#a78bfa', fontWeight: 700 }, children: endDate } },
                        ],
                      },
                    } : null,
                  ].filter(Boolean),
                },
              },
              // CTA
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    background: 'linear-gradient(90deg, #7c3aed, #a78bfa)',
                    borderRadius: '12px',
                    padding: '12px 24px',
                    fontSize: '20px',
                    fontWeight: 700,
                    color: '#ffffff',
                  },
                  children: 'Bet on Solana',
                },
              },
            ],
          },
        },
      ],
    },
  };
}

/**
 * GET /api/og/:marketId
 * Generates a dynamic 1200x630 PNG preview image for a market
 */
router.get('/:marketId', async (req, res) => {
  try {
    const { marketId } = req.params;
    const markets = req.app.locals.markets;
    
    if (!markets) {
      console.error('[OG] Markets store not available');
      return serveFallback(res);
    }

    const market = await markets.get(marketId);
    if (!market) {
      console.warn(`[OG] Market not found: ${marketId}`);
      return serveFallback(res);
    }

    // Calculate odds (same logic as actions.js)
    const yesPool = (market.yesPool || 0) / 1e6;
    const noPool = (market.noPool || 0) / 1e6;
    const totalPool = yesPool + noPool;
    const yesPercent = totalPool > 0 ? Math.round((yesPool / totalPool) * 100) : 50;
    const noPercent = totalPool > 0 ? Math.round((noPool / totalPool) * 100) : 50;
    const totalBets = market.totalBets || 0;

    // Build the card markup
    const markup = buildMarketCard(market, yesPercent, noPercent, totalPool, totalBets);

    // Render to SVG with satori
    const satori = await getSatori();
    const svg = await satori(markup, {
      width: 1200,
      height: 630,
      fonts: [
        {
          name: 'Inter',
          data: interRegular,
          weight: 400,
          style: 'normal',
        },
        {
          name: 'Inter',
          data: interBold,
          weight: 700,
          style: 'normal',
        },
      ],
    });

    // Convert SVG to PNG
    const resvg = new Resvg(svg, {
      fitTo: {
        mode: 'width',
        value: 1200,
      },
    });
    const pngData = resvg.render();
    const pngBuffer = pngData.asPng();

    // Return PNG with caching (5 min to keep odds fresh)
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
      'Content-Length': pngBuffer.length,
    });
    res.send(pngBuffer);

  } catch (error) {
    console.error('[OG] Error generating image:', error);
    return serveFallback(res);
  }
});

/**
 * Serve fallback static image when generation fails
 */
function serveFallback(res) {
  try {
    if (fs.existsSync(fallbackImagePath)) {
      res.set({
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600',
      });
      return res.sendFile(fallbackImagePath);
    }
  } catch (err) {
    console.error('[OG] Fallback image not found:', err.message);
  }
  // Last resort: return the icon
  res.set({
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=3600',
  });
  return res.sendFile(logoPath);
}

module.exports = { router };
