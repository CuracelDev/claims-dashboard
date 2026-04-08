import { NextResponse } from 'next/server';

const METABASE_URL = process.env.METABASE_URL;
const METABASE_USERNAME = process.env.METABASE_USERNAME;
const METABASE_PASSWORD = process.env.METABASE_PASSWORD;
const HEALTH_DATABASE_ID = Number(process.env.METABASE_DATABASE_ID) || 4;

const MAX_ROWS = 1000;

// Token cache
let sessionToken = null;
let tokenExpiry = 0;

async function getSessionToken() {
  if (sessionToken && Date.now() < tokenExpiry) {
    return sessionToken;
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
    throw new Error('Metabase authentication failed');
  }

  const data = await response.json();
  sessionToken = data.id;
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23 hours
  return sessionToken;
}

/**
 * Validate that the SQL is read-only (SELECT queries only)
 */
function validateReadOnly(sql) {
  const normalized = sql.trim().toUpperCase();
  
  // Must start with SELECT or WITH (for CTEs)
  if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
    return { valid: false, error: 'Only SELECT queries are allowed' };
  }

  // Block dangerous keywords
  const forbidden = [
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE', 'ALTER', 
    'CREATE', 'REPLACE', 'GRANT', 'REVOKE', 'EXECUTE', 'EXEC',
    'INTO OUTFILE', 'INTO DUMPFILE', 'LOAD_FILE'
  ];
  
  for (const keyword of forbidden) {
    // Check for keyword with word boundary (not part of column/table name)
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(sql)) {
      return { valid: false, error: `Forbidden keyword detected: ${keyword}` };
    }
  }

  return { valid: true };
}

/**
 * Ensure query has a LIMIT clause (add one if missing)
 */
function enforceLimit(sql, maxRows = MAX_ROWS) {
  const normalized = sql.trim().toUpperCase();
  
  // Check if LIMIT already exists
  const limitMatch = normalized.match(/\bLIMIT\s+(\d+)/);
  if (limitMatch) {
    const existingLimit = parseInt(limitMatch[1], 10);
    if (existingLimit > maxRows) {
      // Replace with max allowed
      return sql.replace(/\bLIMIT\s+\d+/i, `LIMIT ${maxRows}`);
    }
    return sql;
  }
  
  // Add LIMIT if not present (handle trailing semicolon)
  const trimmed = sql.trim();
  if (trimmed.endsWith(';')) {
    return trimmed.slice(0, -1) + ` LIMIT ${maxRows};`;
  }
  return trimmed + ` LIMIT ${maxRows}`;
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { sql } = body;

    if (!sql || typeof sql !== 'string') {
      return NextResponse.json(
        { error: 'SQL query is required' },
        { status: 400 }
      );
    }

    // Validate read-only
    const validation = validateReadOnly(sql);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error },
        { status: 400 }
      );
    }

    // Enforce row limit
    const limitedSQL = enforceLimit(sql);

    // Execute query
    const token = await getSessionToken();
    const startTime = Date.now();

    const response = await fetch(`${METABASE_URL}/api/dataset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Metabase-Session': token
      },
      body: JSON.stringify({
        database: HEALTH_DATABASE_ID,
        type: 'native',
        native: { query: limitedSQL }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = 'Query execution failed';
      
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.message || errorJson.error || errorMessage;
      } catch {
        errorMessage = errorText || errorMessage;
      }
      
      return NextResponse.json(
        { error: errorMessage },
        { status: 500 }
      );
    }

    const result = await response.json();
    const executionTime = Date.now() - startTime;

    // Handle Metabase error in response body
    if (result.error) {
      return NextResponse.json(
        { error: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json({
      rows: result.data?.rows || [],
      cols: result.data?.cols?.map(c => c.name) || [],
      rowCount: result.data?.rows?.length || 0,
      executionTime,
      limited: result.data?.rows?.length === MAX_ROWS,
      executedSQL: limitedSQL
    });

  } catch (error) {
    console.error('Query execution error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
