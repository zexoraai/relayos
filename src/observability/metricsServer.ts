import http from 'http';
import { registry } from './metrics';
import { logger } from './logger';
import { config } from '../config';

let server: http.Server | null = null;

export function startMetricsServer(): http.Server {
  // Idempotent: if already listening (combined-mode where both startApi + startWorkers
  // call this), return the existing server instead of double-binding the port.
  if (server) {
    logger.debug({ port: config.metricsPort }, 'Metrics server already running, reusing');
    return server;
  }

  server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      try {
        res.setHeader('Content-Type', registry.contentType);
        res.end(await registry.metrics());
      } catch (err) {
        res.statusCode = 500;
        res.end('Error collecting metrics');
      }
    } else if (req.url === '/health') {
      res.statusCode = 200;
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    } else {
      res.statusCode = 404;
      res.end('Not Found');
    }
  });

  server.listen(config.metricsPort, () => {
    logger.info({ port: config.metricsPort }, 'Metrics server started');
  });

  return server;
}

export function stopMetricsServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      const s = server;
      server = null; // clear ref so a re-start can re-bind
      s.close(() => resolve());
    } else {
      resolve();
    }
  });
}
