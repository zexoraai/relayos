import { startAll, registerProcessHandlers } from './bootstrap';
import { logger } from './observability/logger';

const log = logger.child({ module: 'main' });

/**
 * Combined-mode entrypoint: runs the API server AND all workers in a single process.
 * Convenient for local development; in production prefer:
 *   - node dist/api.js     (one or more API instances)
 *   - node dist/workers.js (one workers instance)
 */

registerProcessHandlers('all');

startAll().catch((error) => {
  log.fatal({ error: error.message }, 'Combined process failed to start');
  process.exit(1);
});
