/**
 * AgentBets x402 Proxy Worker
 * 
 * Cloudflare Worker that adds payment gating to AgentBets API endpoints.
 * Uses the x402 protocol for HTTP-native payments.
 * 
 * Flow:
 * 1. Request arrives at protected route
 * 2. Check for valid JWT cookie (from previous payment)
 * 3. If no valid cookie, return 402 with payment requirements
 * 4. Agent pays via x402 protocol
 * 5. Proxy request to origin with JWT cookie set
 */

export interface Env {
  // Wallet address to receive payments
  PAY_TO: string;
  // Network: "base-sepolia" (testnet) or "base" (mainnet)
  NETWORK: string;
  // Origin URL to proxy to
  ORIGIN_URL: string;
  // Protected patterns configuration
  PROTECTED_PATTERNS: ProtectedPattern[];
  // JWT secret for signing cookies (set via wrangler secret)
  JWT_SECRET: string;
}

interface ProtectedPattern {
  pattern: string;
  price: string;
  description: string;
}

// Simple pattern matching for routes
function matchesPattern(path: string, pattern: string): boolean {
  // Convert pattern to regex
  // /api/agent/bet/* -> /api/agent/bet/.*
  const regexPattern = pattern
    .replace(/\*/g, '.*')
    .replace(/\//g, '\\/');
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(path);
}

// Find matching protected pattern
function findProtectedPattern(path: string, patterns: ProtectedPattern[]): ProtectedPattern | null {
  for (const pattern of patterns) {
    if (matchesPattern(path, pattern.pattern)) {
      return pattern;
    }
  }
  return null;
}

// Parse price string to cents
function parsePriceToCents(price: string): number {
  // "$0.01" -> 1, "$0.05" -> 5, "$1.00" -> 100
  const match = price.match(/\$?(\d+(?:\.\d+)?)/);
  if (!match) return 1;
  return Math.round(parseFloat(match[1]) * 100);
}

// Build x402 payment requirements
function buildPaymentRequirements(pattern: ProtectedPattern, env: Env, requestUrl: string): object {
  const priceInCents = parsePriceToCents(pattern.price);
  
  return {
    x402Version: 1,
    accepts: [{
      scheme: 'exact',
      network: env.NETWORK,
      maxAmountRequired: String(priceInCents * 10000), // Convert to smallest unit
      resource: requestUrl,
      description: pattern.description,
      payTo: env.PAY_TO,
      maxTimeoutSeconds: 300,
      asset: env.NETWORK === 'base' 
        ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' // USDC on Base mainnet
        : '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // USDC on Base Sepolia
    }]
  };
}

// Simple JWT verification (in production, use a proper JWT library)
async function verifyJWT(token: string, secret: string): Promise<boolean> {
  try {
    const [headerB64, payloadB64, signatureB64] = token.split('.');
    if (!headerB64 || !payloadB64 || !signatureB64) return false;
    
    // Decode payload
    const payload = JSON.parse(atob(payloadB64));
    
    // Check expiration
    if (payload.exp && payload.exp < Date.now() / 1000) {
      return false;
    }
    
    // In production, verify signature properly
    // For now, just check structure is valid
    return true;
  } catch {
    return false;
  }
}

// Create JWT token
async function createJWT(payload: object, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + 3600, // 1 hour
  };
  
  const headerB64 = btoa(JSON.stringify(header));
  const payloadB64 = btoa(JSON.stringify(fullPayload));
  
  // Simple signature (in production, use proper HMAC)
  const encoder = new TextEncoder();
  const data = encoder.encode(`${headerB64}.${payloadB64}`);
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, data);
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

// Get cookie value
function getCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;
  
  const cookies = cookieHeader.split(';').map(c => c.trim());
  for (const cookie of cookies) {
    const [key, value] = cookie.split('=');
    if (key === name) return value;
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Health check endpoint
    if (path === '/__x402/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'agentbets-x402-proxy'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Config endpoint (public, no secrets)
    if (path === '/__x402/config') {
      return new Response(JSON.stringify({
        protectedPatterns: env.PROTECTED_PATTERNS,
        network: env.NETWORK,
        payTo: env.PAY_TO
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Check if path matches a protected pattern
    const protectedPattern = findProtectedPattern(path, env.PROTECTED_PATTERNS || []);
    
    if (protectedPattern) {
      // Check for valid payment cookie
      const authCookie = getCookie(request, 'x402_auth');
      
      if (authCookie) {
        const isValid = await verifyJWT(authCookie, env.JWT_SECRET);
        if (isValid) {
          // Valid payment, proxy to origin
          return proxyToOrigin(request, env);
        }
      }
      
      // Check for payment header (x402 payment proof)
      const paymentHeader = request.headers.get('X-PAYMENT') || 
                           request.headers.get('x-payment') ||
                           request.headers.get('PAYMENT-SIGNATURE');
      
      if (paymentHeader) {
        // TODO: Verify payment on-chain
        // For now, accept payment header and create session
        const token = await createJWT({ 
          path: path,
          paid: true 
        }, env.JWT_SECRET);
        
        // Proxy to origin with auth cookie
        const response = await proxyToOrigin(request, env);
        
        // Clone response and add Set-Cookie header
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Set-Cookie', `x402_auth=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`);
        
        return new Response(response.body, {
          status: response.status,
          headers: newHeaders
        });
      }
      
      // No valid payment - return 402
      const requirements = buildPaymentRequirements(protectedPattern, env, request.url);
      
      return new Response(JSON.stringify({
        error: 'Payment required',
        message: protectedPattern.description,
        price: protectedPattern.price,
        x402: requirements
      }), {
        status: 402,
        headers: {
          'Content-Type': 'application/json',
          'X-PAYMENT-REQUIRED': Buffer.from(JSON.stringify(requirements)).toString('base64'),
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, X-PAYMENT, PAYMENT-SIGNATURE'
        }
      });
    }
    
    // Not a protected route - proxy directly
    return proxyToOrigin(request, env);
  }
};

// Proxy request to origin
async function proxyToOrigin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const originUrl = new URL(env.ORIGIN_URL);
  
  // Replace host with origin
  url.hostname = originUrl.hostname;
  url.port = originUrl.port;
  url.protocol = originUrl.protocol;
  
  // Clone request with new URL
  const proxyRequest = new Request(url.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'follow'
  });
  
  try {
    return await fetch(proxyRequest);
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Origin unreachable',
      message: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
