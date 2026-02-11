/**
 * Database Compatibility Layer
 * 
 * Provides Map-like interface backed by PostgreSQL
 * Falls back to in-memory if database is not available
 */

const { Market, Bet, Agent, Royalty, Points, OddsHistory, Position } = require('./models');

// In-memory fallback storage
const fallbackMarkets = new Map();
const fallbackBets = new Map();
const fallbackPositions = new Map();
const fallbackOddsHistory = new Map();

// Check if database is connected
let dbConnected = false;

function setDbConnected(connected) {
  dbConnected = connected;
}

function isDbConnected() {
  return dbConnected;
}

/**
 * Markets storage with Map-like interface
 */
const markets = {
  async get(id) {
    if (dbConnected) {
      return await Market.findById(id);
    }
    return fallbackMarkets.get(id);
  },

  async set(id, data) {
    if (dbConnected) {
      if (await Market.findById(id)) {
        return await Market.update(id, data);
      } else {
        return await Market.create({ ...data, id });
      }
    }
    fallbackMarkets.set(id, data);
    return data;
  },

  async create(data) {
    if (dbConnected) {
      return await Market.create(data);
    }
    const id = data.id || require('uuid').v4();
    const market = { ...data, id };
    fallbackMarkets.set(id, market);
    return market;
  },

  async update(id, data) {
    if (dbConnected) {
      return await Market.update(id, data);
    }
    const existing = fallbackMarkets.get(id);
    if (existing) {
      const updated = { ...existing, ...data };
      fallbackMarkets.set(id, updated);
      return updated;
    }
    return null;
  },

  async delete(id) {
    if (dbConnected) {
      return await Market.delete(id);
    }
    return fallbackMarkets.delete(id);
  },

  async values() {
    if (dbConnected) {
      return await Market.findAll();
    }
    return Array.from(fallbackMarkets.values());
  },

  async findAll(filters = {}) {
    if (dbConnected) {
      return await Market.findAll(filters);
    }
    let results = Array.from(fallbackMarkets.values());
    if (filters.status) {
      results = results.filter(m => m.status === filters.status);
    }
    if (filters.category) {
      results = results.filter(m => m.category === filters.category);
    }
    if (filters.creatorAgent) {
      results = results.filter(m => m.creatorAgent === filters.creatorAgent);
    }
    if (filters.tags && Array.isArray(filters.tags) && filters.tags.length > 0) {
      results = results.filter(m => {
        const marketTags = m.tags || [];
        return filters.tags.some(t => marketTags.includes(t));
      });
    }
    if (filters.since) {
      const sinceDate = new Date(filters.since);
      results = results.filter(m => new Date(m.createdAt) > sinceDate);
    }
    // Sort by created_at DESC (matching DB behavior)
    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (filters.limit) {
      results = results.slice(0, filters.limit);
    }
    return results;
  },

  async count(filters = {}) {
    if (dbConnected) {
      return await Market.count(filters);
    }
    let results = Array.from(fallbackMarkets.values());
    if (filters.status) {
      results = results.filter(m => m.status === filters.status);
    }
    if (filters.category) {
      results = results.filter(m => m.category === filters.category);
    }
    if (filters.tags && Array.isArray(filters.tags) && filters.tags.length > 0) {
      results = results.filter(m => {
        const marketTags = m.tags || [];
        return filters.tags.some(t => marketTags.includes(t));
      });
    }
    if (filters.since) {
      const sinceDate = new Date(filters.since);
      results = results.filter(m => new Date(m.createdAt) > sinceDate);
    }
    return results.length;
  },

  async getStats() {
    if (dbConnected) {
      return await Market.getStats();
    }
    const all = Array.from(fallbackMarkets.values());
    return {
      total: all.length,
      active: all.filter(m => m.status === 'active').length,
      resolved: all.filter(m => m.status === 'resolved').length,
      totalVolume: all.reduce((sum, m) => sum + (m.totalVolume || 0), 0),
      totalBets: all.reduce((sum, m) => sum + (m.totalBets || 0), 0)
    };
  }
};

/**
 * Bets storage with Map-like interface
 */
const bets = {
  async get(id) {
    if (dbConnected) {
      return await Bet.findById(id);
    }
    return fallbackBets.get(id);
  },

  async set(id, data) {
    if (dbConnected) {
      if (await Bet.findById(id)) {
        return await Bet.update(id, data);
      } else {
        return await Bet.create({ ...data, id });
      }
    }
    fallbackBets.set(id, data);
    return data;
  },

  async create(data) {
    if (dbConnected) {
      return await Bet.create(data);
    }
    const id = data.id || require('uuid').v4();
    const bet = { ...data, id };
    fallbackBets.set(id, bet);
    return bet;
  },

  async update(id, data) {
    if (dbConnected) {
      return await Bet.update(id, data);
    }
    const existing = fallbackBets.get(id);
    if (existing) {
      const updated = { ...existing, ...data };
      fallbackBets.set(id, updated);
      return updated;
    }
    return null;
  },

  async values() {
    if (dbConnected) {
      return await Bet.findAll();
    }
    return Array.from(fallbackBets.values());
  },

  async findByMarketId(marketId) {
    if (dbConnected) {
      return await Bet.findByMarketId(marketId);
    }
    return Array.from(fallbackBets.values()).filter(b => b.marketId === marketId);
  },

  async findByWallet(wallet) {
    if (dbConnected) {
      return await Bet.findByWallet(wallet);
    }
    return Array.from(fallbackBets.values()).filter(b => b.wallet === wallet);
  },

  async updateByMarketResolution(marketId, winningOutcome) {
    if (dbConnected) {
      return await Bet.updateByMarketResolution(marketId, winningOutcome);
    }
    for (const [id, bet] of fallbackBets) {
      if (bet.marketId === marketId && bet.status === 'active') {
        bet.status = bet.outcome === winningOutcome ? 'won' : 'lost';
        fallbackBets.set(id, bet);
      }
    }
  },

  async getStats() {
    if (dbConnected) {
      return await Bet.getStats();
    }
    const all = Array.from(fallbackBets.values());
    return {
      total: all.length,
      totalVolume: all.reduce((sum, b) => sum + (b.amount || 0), 0)
    };
  },

  async getLeaderboard(limit = 10) {
    if (dbConnected) {
      return await Bet.getLeaderboard(limit);
    }
    // Simplified fallback
    const walletStats = new Map();
    for (const bet of fallbackBets.values()) {
      const stats = walletStats.get(bet.wallet) || { wallet: bet.wallet, totalBets: 0, totalWagered: 0 };
      stats.totalBets++;
      stats.totalWagered += bet.amount || 0;
      walletStats.set(bet.wallet, stats);
    }
    return Array.from(walletStats.values())
      .sort((a, b) => b.totalWagered - a.totalWagered)
      .slice(0, limit);
  }
};

/**
 * Positions storage
 */
const positions = {
  async get(key) {
    if (dbConnected) {
      const [wallet, marketId, outcome] = key.split('-');
      const results = await Position.findByWallet(wallet);
      return results.find(p => p.marketId === marketId && p.outcome === outcome);
    }
    return fallbackPositions.get(key);
  },

  async set(key, data) {
    if (dbConnected) {
      return await Position.upsert(data.wallet, data.marketId, data.outcome, data.totalAmount || data.totalBet);
    }
    fallbackPositions.set(key, data);
    return data;
  },

  async upsert(wallet, marketId, outcome, amount) {
    if (dbConnected) {
      return await Position.upsert(wallet, marketId, outcome, amount);
    }
    const key = `${wallet}-${marketId}-${outcome}`;
    const existing = fallbackPositions.get(key) || { wallet, marketId, outcome, totalAmount: 0, betCount: 0 };
    existing.totalAmount += amount;
    existing.betCount++;
    fallbackPositions.set(key, existing);
    return existing;
  },

  async findByWallet(wallet) {
    if (dbConnected) {
      return await Position.findByWallet(wallet);
    }
    return Array.from(fallbackPositions.values()).filter(p => p.wallet === wallet);
  },

  async findByMarketId(marketId) {
    if (dbConnected) {
      return await Position.findByMarketId(marketId);
    }
    return Array.from(fallbackPositions.values()).filter(p => p.marketId === marketId);
  }
};

/**
 * Odds History storage
 */
const oddsHistory = {
  async record(marketId, data) {
    if (dbConnected) {
      return await OddsHistory.record(marketId, data);
    }
    const history = fallbackOddsHistory.get(marketId) || [];
    history.push({
      timestamp: new Date().toISOString(),
      ...data
    });
    // Keep only last 100
    if (history.length > 100) history.shift();
    fallbackOddsHistory.set(marketId, history);
  },

  async getByMarketId(marketId, limit = 100) {
    if (dbConnected) {
      return await OddsHistory.getByMarketId(marketId, limit);
    }
    return (fallbackOddsHistory.get(marketId) || []).slice(-limit);
  },

  get(marketId) {
    // Synchronous fallback for compatibility
    return fallbackOddsHistory.get(marketId) || [];
  },

  set(marketId, history) {
    fallbackOddsHistory.set(marketId, history);
  }
};

module.exports = {
  markets,
  bets,
  positions,
  oddsHistory,
  setDbConnected,
  isDbConnected,
  // Also export models for direct access
  Market,
  Bet,
  Agent,
  Royalty,
  Points,
  OddsHistory: OddsHistory,
  Position
};
