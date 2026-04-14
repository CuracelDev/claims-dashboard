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
    this.mode = 'select';
    this.payload = null;
    this.columns = '*';
    this.returning = false;
    this.singleMode = null;
  }

  select(columns = '*', options = {}) {
    if (this.mode === 'insert' || this.mode === 'update') {
      this.returning = true;
      this.columns = columns === '*' ? '*' : columns;
      return this;
    }

    this.columns = columns === '*' ? '*' : columns;
    return this;
  }

  update(data) {
    this.mode = 'update';
    this.payload = data;
    return this;
  }

  delete() {
    this.mode = 'delete';
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

  neq(column, value) {
    this.conditions.push({ column, value, type: 'neq' });
    return this;
  }

  in(column, values) {
    this.conditions.push({ column, value: values, type: 'in' });
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

  limit(count) {
    this.rangeLimit = count;
    return this;
  }

  single() {
    this.singleMode = 'single';
    return this;
  }

  maybeSingle() {
    this.singleMode = 'maybeSingle';
    return this;
  }

  async then(resolve, reject) {
    try {
      let sql;
      const values = [];

      const buildWhereClause = () => {
        if (this.conditions.length === 0) return '';
        const clauses = this.conditions.map((c) => {
          values.push(c.value);
          const placeholder = `$${values.length}`;
          if (c.type === 'eq') return `${c.column} = ${placeholder}`;
          if (c.type === 'ilike') return `${c.column} ILIKE ${placeholder}`;
          if (c.type === 'neq') return `${c.column} != ${placeholder}`;
          if (c.type === 'gte') return `${c.column} >= ${placeholder}`;
          if (c.type === 'lte') return `${c.column} <= ${placeholder}`;
          if (c.type === 'in') return `${c.column} = ANY(${placeholder})`;
          return '';
        }).filter(Boolean);
        return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      };

      const buildReturningClause = () => {
        if (!this.returning && this.singleMode == null) return '';
        return ` RETURNING ${this.columns || '*'}`;
      };

      if (this.mode === 'insert') {
        const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
        if (!rows.length) {
          resolve({ data: [], error: null, count: 0 });
          return;
        }

        const keys = Object.keys(rows[0]);
        const placeholders = rows.map((row) => {
          const rowPlaceholders = keys.map((key) => {
            values.push(row[key]);
            return `$${values.length}`;
          });
          return `(${rowPlaceholders.join(', ')})`;
        }).join(', ');

        sql = `INSERT INTO ${this.table} (${keys.join(', ')}) VALUES ${placeholders}${buildReturningClause()}`;
      } else if (this.mode === 'upsert') {
        const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
        if (!rows.length) {
          resolve({ data: [], error: null, count: 0 });
          return;
        }

        const keys = Object.keys(rows[0]);
        const placeholders = rows.map((row) => {
          const rowPlaceholders = keys.map((key) => {
            values.push(row[key]);
            return `$${values.length}`;
          });
          return `(${rowPlaceholders.join(', ')})`;
        }).join(', ');

        const conflictColumns = (this.upsertOptions?.onConflict || 'id')
          .split(',')
          .map((column) => column.trim())
          .filter(Boolean);
        const ignoreDuplicates = Boolean(this.upsertOptions?.ignoreDuplicates);
        const updateColumns = keys.filter((key) => !conflictColumns.includes(key));

        sql = `INSERT INTO ${this.table} (${keys.join(', ')}) VALUES ${placeholders}`;
        sql += ` ON CONFLICT (${conflictColumns.join(', ')})`;
        if (ignoreDuplicates || updateColumns.length === 0) {
          sql += ' DO NOTHING';
        } else {
          sql += ` DO UPDATE SET ${updateColumns.map((key) => `${key} = EXCLUDED.${key}`).join(', ')}`;
        }
        sql += buildReturningClause();
      } else if (this.mode === 'update') {
        const keys = Object.keys(this.payload || {});
        const setClause = keys.map((key) => {
          values.push(this.payload[key]);
          return `${key} = $${values.length}`;
        }).join(', ');

        sql = `UPDATE ${this.table} SET ${setClause}`;
        sql += buildWhereClause();
        sql += buildReturningClause();
      } else if (this.mode === 'delete') {
        sql = `DELETE FROM ${this.table}`;
        sql += buildWhereClause();
        sql += buildReturningClause();
      } else {
        sql = `SELECT ${this.columns} FROM ${this.table}`;
        sql += buildWhereClause();

        if (this.ordering) {
          sql += ` ORDER BY ${this.ordering.column} ${this.ordering.direction}`;
        }

        if (this.rangeLimit !== null) {
          sql += ` LIMIT ${this.rangeLimit}`;
        }
        if (this.rangeOffset !== null) {
          sql += ` OFFSET ${this.rangeOffset}`;
        }
      }

      const res = await pool.query(sql, values);
      let data = res.rows;
      if (this.singleMode === 'single' || this.singleMode === 'maybeSingle') {
        data = data[0] ?? null;
      }

      resolve({ data, error: null, count: res.rowCount });
    } catch (err) {
      resolve({ data: null, error: err, count: 0 });
    }
  }

  insert(data) {
    this.mode = 'insert';
    this.payload = data;
    return this;
  }

  upsert(data, options = {}) {
    this.mode = 'upsert';
    this.payload = data;
    this.upsertOptions = options;
    return this;
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
