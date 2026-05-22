import express from 'express';
import cors from 'cors';
import path from 'path';
import rateLimit from 'express-rate-limit';
import authRoutes from './authRoutes';
import onboardingRoutes from './onboardingRoutes';
import referenceRoutes from './referenceRoutes';
import healthRoutes from './healthRoutes';
import pipelineRoutes from './pipelineRoutes';
import fulfillmentRoutes from './fulfillmentRoutes';
import customersRoutes from './customersRoutes';
import settingsRoutes from './settingsRoutes';
import caretakerRoutes from './caretakerRoutes';
import whatsappRoutes from './whatsappRoutes';
import whatsappWebhookRoutes from './whatsappWebhookRoutes';
import shopifyWebhookRoutes from './shopifyWebhookRoutes';
import knowledgeRoutes from './knowledgeRoutes';
import idempotencyRoutes from './idempotencyRoutes';
import dlqRoutes from './dlqRoutes';
import usageRoutes from './usageRoutes';
import agentRunsRoutes from './agentRunsRoutes';
import usersRoutes from './usersRoutes';
import packerRoutes from './packerRoutes';
import chatbotSettingsRoutes from './chatbotSettingsRoutes';
import marketingRoutes from './marketingRoutes';
import manualRoutes from './manualRoutes';
import frontendRoutes from './frontendRoutes';
import { errorHandler } from './middleware';
import { logger } from '../observability/logger';

const log = logger.child({ module: 'api' });

export function createApiServer(): express.Application {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Serve static files (new SPA build takes priority, then legacy public/)
  app.use('/new', express.static(path.join(__dirname, '../../public/dist')));
  app.use(express.static(path.join(__dirname, '../../public')));

  // Rate limiting for auth endpoints
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, try again later' } },
  });

  // Public liveness probe (used by Railway / load balancer healthchecks).
  // Does NOT require auth and does NOT touch the DB to avoid flapping during cold starts.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // API Routes
  app.use('/auth', authLimiter, authRoutes);
  app.use('/onboarding', onboardingRoutes);
  app.use('/reference', referenceRoutes);
  app.use('/health', healthRoutes);
  app.use('/pipeline', pipelineRoutes);
  app.use('/fulfillment', fulfillmentRoutes);
  app.use('/customers', customersRoutes);
  app.use('/settings', settingsRoutes);
  app.use('/caretaker', caretakerRoutes);
  // Public webhooks (no auth) — must be before auth-protected routes
  app.use('/whatsapp', whatsappWebhookRoutes);
  app.use('/webhooks/shopify', shopifyWebhookRoutes);
  app.use('/whatsapp', whatsappRoutes);
  app.use('/knowledge', knowledgeRoutes);
  app.use('/idempotency', idempotencyRoutes);
  app.use('/dlq', dlqRoutes);
  app.use('/usage', usageRoutes);
  app.use('/agent-runs', agentRunsRoutes);
  app.use('/users', usersRoutes);
  app.use('/packer', packerRoutes);
  app.use('/chatbot-settings', chatbotSettingsRoutes);
  app.use('/marketing', marketingRoutes);
  app.use('/manual', manualRoutes);

  // Frontend routes (SPA fallback)
  app.use(frontendRoutes);

  // Error handler
  app.use(errorHandler);

  return app;
}

export function startApiServer(port: number): void {
  const app = createApiServer();
  app.listen(port, () => {
    log.info({ port }, 'API server started');
  });
}
