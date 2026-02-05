/**
 * Database Connection Pool
 * 
 * PostgreSQL connection using pg library
 * Connects via DATABASE_URL environment variable
 */

const { Pool } = require('pg');

// Create connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20, // Maximum number of connections
  idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
  connectionTimeoutMillis: 10000, // Connection timeout
});

// Log connection events
pool.on('connect', () => {
  console.log('[DB] New client connected to PostgreSQL');
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client:', err);
});

/**
 * Initialize database connection and verify it works
 */
async function initDatabase() {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as now');
    console.log(`[DB] Connected to PostgreSQL at ${result.rows[0].now}`);
    client.release();
    return true;
  } catch (error) {
    console.error('[DB] Failed to connect to PostgreSQL:', error.message);
    console.error('[DB] Make sure DATABASE_URL is set correctly');
    return false;
  }
}

/**
 * Run a query with automatic client management
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 100) {
      console.log(`[DB] Slow query (${duration}ms):`, text.substring(0, 100));
    }
    return result;
  } catch (error) {
    console.error('[DB] Query error:', error.message);
    console.error('[DB] Query:', text.substring(0, 200));
    throw error;
  }
}

/**
 * Get a client from the pool for transactions
 */
async function getClient() {
  const client = await pool.connect();
  const originalQuery = client.query.bind(client);
  const originalRelease = client.release.bind(client);
  
  // Track if client is released
  let released = false;
  
  // Override release to prevent double-release
  client.release = () => {
    if (released) {
      console.warn('[DB] Client already released');
      return;
    }
    released = true;
    originalRelease();
  };
  
  return client;
}

/**
 * Run a transaction with automatic commit/rollback
 */
async function transaction(callback) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run database migrations
 */
async function runMigrations() {
  const fs = require('fs');
  const path = require('path');
  
  const migrationsDir = path.join(__dirname, 'migrations');
  
  // Create migrations tracking table if it doesn't exist
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      executed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  
  // Get list of executed migrations
  const result = await query('SELECT version FROM schema_migrations ORDER BY version');
  const executedMigrations = new Set(result.rows.map(r => r.version));
  
  // Get migration files
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();
  
  console.log(`[DB] Found ${files.length} migration files`);
  
  for (const file of files) {
    if (executedMigrations.has(file)) {
      console.log(`[DB] Skipping ${file} (already executed)`);
      continue;
    }
    
    console.log(`[DB] Running migration: ${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    
    await transaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    });
    
    console.log(`[DB] Completed migration: ${file}`);
  }
  
  console.log('[DB] All migrations complete');
}

/**
 * Close the pool (for graceful shutdown)
 */
async function closePool() {
  await pool.end();
  console.log('[DB] Connection pool closed');
}

module.exports = {
  pool,
  query,
  getClient,
  transaction,
  initDatabase,
  runMigrations,
  closePool
};
