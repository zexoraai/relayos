import dotenv from 'dotenv';
dotenv.config();

/**
 * Build Knex connection from either a single DATABASE_URL (Railway / Heroku style)
 * or split DATABASE_HOST / DATABASE_PORT / etc. env vars (local docker-compose).
 */
function buildConnection(forProduction: boolean) {
  const url = process.env.DATABASE_URL;
  if (url) {
    return forProduction
      ? { connectionString: url, ssl: { rejectUnauthorized: false } }
      : { connectionString: url };
  }
  return {
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432'),
    database: process.env.DATABASE_NAME || 'email_ingestion',
    user: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
    ...(forProduction ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

const config = {
  development: {
    client: 'pg',
    connection: buildConnection(false),
    migrations: {
      directory: './src/db/migrations',
      extension: 'ts',
    },
    pool: { min: 2, max: 10 },
  },
  production: {
    client: 'pg',
    connection: buildConnection(true),
    // In production we run migrations from the compiled JS (no ts-node at runtime)
    migrations: {
      directory: './dist/db/migrations',
      loadExtensions: ['.js'],
    },
    pool: { min: 2, max: 20 },
  },
};

export default config;
module.exports = config;
