// Plain JS knexfile for production runtime (Railway / Docker).
// The TS version is used in local dev via ts-node.
require('dotenv').config();

function buildConnection(forProduction) {
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

module.exports = {
  development: {
    client: 'pg',
    connection: buildConnection(false),
    migrations: {
      directory: './dist/db/migrations',
      loadExtensions: ['.js'],
    },
    pool: { min: 2, max: 10 },
  },
  production: {
    client: 'pg',
    connection: buildConnection(true),
    migrations: {
      directory: './dist/db/migrations',
      loadExtensions: ['.js'],
    },
    pool: { min: 2, max: 20 },
  },
};
