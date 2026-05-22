import { startWorkers, registerProcessHandlers } from './bootstrap';
import { logger } from './observability/logger';

const log = logger.child({ module: 'workers-process' });

registerProcessHandlers('workers');

startWorkers().catch((error) => {
  log.fatal({ error: error.message }, 'Workers process failed to start');
  process.exit(1);
});
