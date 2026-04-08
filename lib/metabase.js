/**
 * Metabase API Client
 * 
 * Uses session-based authentication to query the Health database.
 * Session tokens are cached and refreshed automatically.
 */

const METABASE_URL = process.env.METABASE_URL || 'https://mzxpqf3szj.us-east-1.awsapprunner.com';
const METABASE_USERNAME = process.env.METABASE_USERNAME;
const METABASE_PASSWORD = process.env.METABASE_PASSWORD;

// Database and table IDs (Health database)
const HEALTH_DATABASE_ID = 4;
const CLAIMS_TABLE_ID = 181;

// Field IDs for claims table
const CLAIMS_FIELDS = {
  id: 1583,
  hmo_id: 1580,
  hmo_pile_id: 1582,
  provider_id: 1581,
  enrollee_id: 1599,
  total_amount: 1612,
  approved_amount: 1590,
  hmo_status: 1617,
  created_at: 1585,
  submitted_at: 1596,
  vetted_at: 1593,
  admission_start: 1598,
  admission_end: 1584
};

// Cache session token
let sessionCache = {
  token: null,
  expiresAt: null
};

// Cache query results (in-memory)
const queryCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_TTL_MS = 10 * 60 * 1000; // 10 minutes (serve stale while refreshing)

/**
 * Get cached query result or null if expired
 * @param {string} key - Cache key
 * @returns {{data: any, isStale: boolean} | null}
 */
function getCached(key) {
  const cached = queryCache.get(key);
  if (!cached) return null;
  
  const age = Date.now() - cached.timestamp;
  if (age > STALE_TTL_MS) {
    queryCache.delete(key);
    return null;
  }
  
  return {
    data: cached.data,
    isStale: age > CACHE_TTL_MS
  };
}

/**
 * Set cache entry
 * @param {string} key - Cache key
 * @param {any} data - Data to cache
 */
function setCache(key, data) {
  queryCache.set(key, {
    data,
    timestamp: Date.now()
  });
}

/**
 * Get or refresh session token
 */
async function getSessionToken() {
  // Return cached token if still valid (with 5 min buffer)
  if (sessionCache.token && sessionCache.expiresAt && Date.now() < sessionCache.expiresAt - 300000) {
    return sessionCache.token;
  }

  if (!METABASE_USERNAME || !METABASE_PASSWORD) {
    throw new Error('METABASE_USERNAME and METABASE_PASSWORD environment variables required');
  }

  const response = await fetch(`${METABASE_URL}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: METABASE_USERNAME,
      password: METABASE_PASSWORD
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Metabase authentication failed: ${error}`);
  }

  const { id } = await response.json();
  
  // Cache token for 12 hours (Metabase default session duration is 14 days)
  sessionCache = {
    token: id,
    expiresAt: Date.now() + 12 * 60 * 60 * 1000
  };

  return id;
}

/**
 * Execute a Metabase query
 * @param {Object} query - Metabase query object
 * @returns {Promise<{rows: Array, cols: Array}>}
 */
async function executeQuery(query) {
  const token = await getSessionToken();

  const response = await fetch(`${METABASE_URL}/api/dataset`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Metabase-Session': token
    },
    body: JSON.stringify({
      database: HEALTH_DATABASE_ID,
      type: 'query',
      query
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Metabase query failed: ${error}`);
  }

  const result = await response.json();
  return {
    rows: result.data.rows,
    cols: result.data.cols.map(c => c.name)
  };
}

/**
 * Execute a native SQL query against the Health database
 * @param {string} sql - SQL query
 * @returns {Promise<{rows: Array, cols: Array}>}
 */
async function executeNativeQuery(sql) {
  const token = await getSessionToken();

  const response = await fetch(`${METABASE_URL}/api/dataset`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Metabase-Session': token
    },
    body: JSON.stringify({
      database: HEALTH_DATABASE_ID,
      type: 'native',
      native: { query: sql }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Metabase native query failed: ${error}`);
  }

  const result = await response.json();
  return {
    rows: result.data.rows,
    cols: result.data.cols.map(c => c.name)
  };
}

/**
 * Get daily claims aggregates by insurer (with caching)
 * @param {Object} options
 * @param {string} options.startDate - Start date (YYYY-MM-DD)
 * @param {string} options.endDate - End date (YYYY-MM-DD)
 * @param {string} options.dateField - Date field to use: 'submitted_at' or 'created_at' (default: 'submitted_at')
 * @param {boolean} options.skipCache - Force fresh data
 * @returns {Promise<Array>} - Aggregated claims data
 */
async function getDailyClaimsByInsurer({ startDate, endDate, dateField = 'submitted_at', skipCache = false } = {}) {
  // Default to last 30 days if no dates provided
  const end = endDate || new Date().toISOString().split('T')[0];
  const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  
  // Validate dateField to prevent SQL injection
  const validDateField = ['submitted_at', 'created_at'].includes(dateField) ? dateField : 'submitted_at';

  const cacheKey = `daily_claims_${validDateField}_${start}_${end}`;

  // Check cache first (unless skipCache is true)
  if (!skipCache) {
    const cached = getCached(cacheKey);
    if (cached) {
      // If data is stale, trigger background refresh
      if (cached.isStale) {
        console.log(`[Metabase] Serving stale cache for ${cacheKey}, refreshing in background`);
        fetchAndCacheDailyClaims(start, end, validDateField, cacheKey).catch(err => 
          console.error('[Metabase] Background refresh failed:', err.message)
        );
      }
      return cached.data;
    }
  }

  // Fetch fresh data
  return fetchAndCacheDailyClaims(start, end, validDateField, cacheKey);
}

/**
 * Internal: fetch daily claims and update cache
 */
async function fetchAndCacheDailyClaims(start, end, dateField, cacheKey) {
  // For submitted_at, only include submitted claims; for created_at, include all
  const whereClause = dateField === 'submitted_at' 
    ? `WHERE c.${dateField} IS NOT NULL AND c.${dateField} >= '${start}' AND c.${dateField} <= '${end} 23:59:59'`
    : `WHERE c.${dateField} >= '${start}' AND c.${dateField} <= '${end} 23:59:59'`;
  
  const sql = `
    SELECT 
      DATE(c.${dateField}) as date,
      c.hmo_id,
      h.name as hmo_name,
      COUNT(*) as claims_count,
      SUM(CASE WHEN c.submitted_at IS NOT NULL THEN 1 ELSE 0 END) as submitted_count,
      SUM(CASE WHEN c.hmo_status = 1 THEN 1 ELSE 0 END) as approved_count,
      SUM(CASE WHEN c.hmo_status = -1 THEN 1 ELSE 0 END) as rejected_count,
      SUM(COALESCE(c.total_amount, 0)) as total_billed,
      SUM(COALESCE(c.approved_amount, 0)) as total_approved
    FROM claims c
    LEFT JOIN hmos h ON c.hmo_id = h.id
    ${whereClause}
    GROUP BY DATE(c.${dateField}), c.hmo_id, h.name
    ORDER BY date DESC, c.hmo_id
  `;

  console.log(`[Metabase] Fetching fresh data for ${cacheKey}`);
  const startTime = Date.now();
  
  const { rows, cols } = await executeNativeQuery(sql);

  // Transform to objects
  const data = rows.map(row => {
    const obj = {};
    cols.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });

  console.log(`[Metabase] Fetched ${data.length} rows in ${Date.now() - startTime}ms`);
  
  // Update cache
  setCache(cacheKey, data);
  
  return data;
}

/**
 * Get claims with pagination
 * @param {Object} options
 * @param {number} options.limit - Max rows to return
 * @param {number} options.offset - Rows to skip
 * @param {number} options.hmoId - Filter by insurer ID
 * @returns {Promise<Array>}
 */
async function getClaims({ limit = 100, offset = 0, hmoId = null } = {}) {
  let sql = `
    SELECT 
      id, hmo_id, provider_id, enrollee_id,
      total_amount, approved_amount, hmo_status,
      created_at, submitted_at, vetted_at,
      admission_start, admission_end
    FROM claims
  `;

  if (hmoId) {
    sql += ` WHERE hmo_id = ${hmoId}`;
  }

  sql += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

  const { rows, cols } = await executeNativeQuery(sql);

  return rows.map(row => {
    const obj = {};
    cols.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

/**
 * Get total claims count
 * @param {Object} options
 * @param {number} options.hmoId - Filter by insurer ID
 * @returns {Promise<number>}
 */
async function getClaimsCount({ hmoId = null } = {}) {
  let sql = 'SELECT COUNT(*) as total FROM claims';
  if (hmoId) {
    sql += ` WHERE hmo_id = ${hmoId}`;
  }

  const { rows } = await executeNativeQuery(sql);
  return rows[0][0];
}

export {
  getSessionToken,
  executeQuery,
  executeNativeQuery,
  getDailyClaimsByInsurer,
  getClaims,
  getClaimsCount,
  CLAIMS_FIELDS,
  HEALTH_DATABASE_ID,
  CLAIMS_TABLE_ID
};
