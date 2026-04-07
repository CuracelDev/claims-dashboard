import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

class SupabaseQueryBuilder {
  constructor(table) {
    this.table = table;
    this.conditions = [];
    this.ordering = null;
    this.rangeLimit = null;
    this.rangeOffset = null;
  }

  select(columns = '*', options = {}) {
    this.columns = columns === '*' ? '*' : columns;
    return this;
  }

  eq(column, value) {
    this.conditions.push({ column, value, type: 'eq' });
    return this;
  }

  ilike(column, value) {
    this.conditions.push({ column, value, type: 'ilike' });
    return this;
  }

  gte(column, value) {
    this.conditions.push({ column, value, type: 'gte' });
    return this;
  }

  lte(column, value) {
    this.conditions.push({ column, value, type: 'lte' });
    return this;
  }

  order(column, { ascending = true } = {}) {
    this.ordering = { column, direction: ascending ? 'ASC' : 'DESC' };
    return this;
  }

  range(from, to) {
    this.rangeOffset = from;
    this.rangeLimit = to - from + 1;
    return this;
  }

  async then(resolve, reject) {
    try {
      let sql = `SELECT ${this.columns} FROM ${this.table}`;
      const values = [];

      if (this.conditions.length > 0) {
        sql += ' WHERE ';
        sql += this.conditions
          .map((c, i) => {
            values.push(c.value);
            const placeholder = `$${values.length}`;
            if (c.type === 'eq') return `${c.column} = ${placeholder}`;
            if (c.type === 'ilike') return `${c.column} ILIKE ${placeholder}`;
            if (c.type === 'gte') return `${c.column} >= ${placeholder}`;
            if (c.type === 'lte') return `${c.column} <= ${placeholder}`;
          })
          .join(' AND ');
      }

      if (this.ordering) {
        sql += ` ORDER BY ${this.ordering.column} ${this.ordering.direction}`;
      }

      if (this.rangeLimit !== null) {
        sql += ` LIMIT ${this.rangeLimit}`;
      }
      if (this.rangeOffset !== null) {
        sql += ` OFFSET ${this.rangeOffset}`;
      }

      const res = await pool.query(sql, values);
      resolve({ data: res.rows, error: null, count: res.rowCount });
    } catch (err) {
      resolve({ data: null, error: err, count: 0 });
    }
  }

  // Add more methods as needed (insert, update, upsert)
  async insert(data) {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO ${this.table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`;
    try {
      const res = await pool.query(sql, values);
      return { data: res.rows, error: null };
    } catch (err) {
      return { data: null, error: err };
    }
  }
}

export function createClient() {
  return {
    from: (table) => new SupabaseQueryBuilder(table),
  };
}

export function getSupabase() {
  return createClient();
}
