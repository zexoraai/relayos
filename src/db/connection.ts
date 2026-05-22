import knex, { Knex } from 'knex';
import { getConfig } from '../config';
import { logger } from '../observability/logger';

let db: Knex | null = null;

function buildConnection() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const isProd = process.env.NODE_ENV === 'production';
    return isProd
      ? { connectionString: url, ssl: { rejectUnauthorized: false } as const }
      : { connectionString: url };
  }
  const config = getConfig();
  return {
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    user: config.database.user,
    password: config.database.password,
  };
}

export function getDb(): Knex {
  if (!db) {
    db = knex({
      client: 'pg',
      connection: buildConnection() as any,
      pool: {
        min: 2,
        max: 10,
        afterCreate: (conn: any, done: Function) => {
          logger.debug('Database connection created');
          done(null, conn);
        },
      },
    });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.destroy();
    db = null;
    logger.info('Database connection closed');
  }
}
