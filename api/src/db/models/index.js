/**
 * Database Models Index
 * 
 * Export all models for easy importing
 */

const Market = require('./Market');
const Bet = require('./Bet');
const Agent = require('./Agent');
const { Royalty, Points } = require('./Royalty');
const { Resolution, ProcessedTweet, OddsHistory, Position } = require('./Resolution');

module.exports = {
  Market,
  Bet,
  Agent,
  Royalty,
  Points,
  Resolution,
  ProcessedTweet,
  OddsHistory,
  Position
};
