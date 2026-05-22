import { startApi, registerProcessHandlers } from './bootstrap';
import { logger } from './observability/logger';

const log = logger.child({ module: 'api-process' });

registerProcessHandlers('api');

startApi().catch((error) => {
  log.fatal({ error: error.message }, 'API process failed to start');
  process.exit(1);
});
