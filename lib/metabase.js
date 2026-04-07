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
 * Get daily claims aggregates by insurer
 * @param {Object} options
 * @param {string} options.startDate - Start date (YYYY-MM-DD)
 * @param {string} options.endDate - End date (YYYY-MM-DD)
 * @returns {Promise<Array>} - Aggregated claims data
 */
async function getDailyClaimsByInsurer({ startDate, endDate } = {}) {
  // Default to last 30 days if no dates provided
  const end = endDate || new Date().toISOString().split('T')[0];
  const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const sql = `
    SELECT 
      DATE(created_at) as date,
      hmo_id,
      COUNT(*) as claims_count,
      SUM(CASE WHEN submitted_at IS NOT NULL THEN 1 ELSE 0 END) as submitted_count,
      SUM(CASE WHEN hmo_status = 1 THEN 1 ELSE 0 END) as approved_count,
      SUM(CASE WHEN hmo_status = -1 THEN 1 ELSE 0 END) as rejected_count,
      SUM(COALESCE(total_amount, 0)) as total_billed,
      SUM(COALESCE(approved_amount, 0)) as total_approved
    FROM claims
    WHERE created_at >= '${start}'
      AND created_at <= '${end} 23:59:59'
    GROUP BY DATE(created_at), hmo_id
    ORDER BY date DESC, hmo_id
  `;

  const { rows, cols } = await executeNativeQuery(sql);

  // Transform to objects
  return rows.map(row => {
    const obj = {};
    cols.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
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
