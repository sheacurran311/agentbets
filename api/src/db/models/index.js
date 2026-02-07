/**
 * Database Models Index
 * 
 * Export all models for easy importing
 */

const Market = require('./Market');
const Bet = require('./Bet');
const Agent = require('./Agent');
const { Royalty, Points, Referral } = require('./Royalty');
const { Resolution, ProcessedTweet, OddsHistory, Position } = require('./Resolution');

module.exports = {
  Market,
  Bet,
  Agent,
  Royalty,
  Points,
  Referral,
  Resolution,
  ProcessedTweet,
  OddsHistory,
  Position
};
