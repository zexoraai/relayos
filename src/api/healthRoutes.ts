import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware } from './middleware';
import { getDb } from '../db/connection';
import { decrypt } from '../crypto';
import { createChildLogger } from '../observability/logger';
import https from 'https';
import http from 'http';

const log = createChildLogger({ module: 'health-check' });
const router = Router();

router.use(authMiddleware);

interface HealthCheckResult {
  service: string;
  status: 'healthy' | 'unhealthy' | 'unconfigured';
  message: string;
  checked_at: string;
}

// POST /health/check - Run all health checks for the tenant
router.post('/check', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  const results: HealthCheckResult[] = [];

  // 1. IMAP Health Check
  const imapResult = await checkImap(tenantId, db);
  results.push(imapResult);

  // 2. PUDO API Key Validation
  const pudoApiResult = await checkPudoApiKey(tenantId, db);
  results.push(pudoApiResult);

  // 3. PUDO Login Validation
  const pudoLoginResult = await checkPudoLogin(tenantId, db);
  results.push(pudoLoginResult);

  return res.status(200).json({ success: true, data: { checks: results } });
});

async function checkImap(tenantId: string, db: any): Promise<HealthCheckResult> {
  try {
    const settings = await db('tenant_imap_settings').where({ tenant_id: tenantId }).first();
    if (!settings) {
      return { service: 'imap', status: 'unconfigured', message: 'IMAP settings not configured', checked_at: new Date().toISOString() };
    }

    const { ImapFlow } = require('imapflow');
    const password = decrypt(settings.encrypted_imap_password);

    const client = new ImapFlow({
      host: settings.imap_host,
      port: settings.imap_port,
      secure: settings.imap_use_ssl,
      auth: { user: settings.imap_username, pass: password },
      logger: false,
      emitLogs: false,
    });

    await client.connect();
    await client.logout();

    return { service: 'imap', status: 'healthy', message: `Connected to ${settings.imap_host}:${settings.imap_port}`, checked_at: new Date().toISOString() };
  } catch (error: any) {
    log.warn({ tenantId, error: error.message }, 'IMAP health check failed');
    return { service: 'imap', status: 'unhealthy', message: error.message, checked_at: new Date().toISOString() };
  }
}

async function checkPudoApiKey(tenantId: string, db: any): Promise<HealthCheckResult> {
  try {
    const settings = await db('tenant_pudo_settings').where({ tenant_id: tenantId }).first();
    if (!settings) {
      return { service: 'pudo_api_key', status: 'unconfigured', message: 'PUDO settings not configured', checked_at: new Date().toISOString() };
    }

    const apiKey = decrypt(settings.encrypted_pudo_api_key);

    const result = await httpRequest('GET', 'https://api-pudo.co.za/api/v1/shipments', null, {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
    });

    if (result.status >= 200 && result.status < 300) {
      return { service: 'pudo_api_key', status: 'healthy', message: 'API key is valid', checked_at: new Date().toISOString() };
    } else if (result.status === 401) {
      return { service: 'pudo_api_key', status: 'unhealthy', message: 'API key is invalid or expired', checked_at: new Date().toISOString() };
    } else {
      return { service: 'pudo_api_key', status: 'unhealthy', message: `API returned status ${result.status}`, checked_at: new Date().toISOString() };
    }
  } catch (error: any) {
    log.warn({ tenantId, error: error.message }, 'PUDO API key check failed');
    return { service: 'pudo_api_key', status: 'unhealthy', message: error.message, checked_at: new Date().toISOString() };
  }
}

async function checkPudoLogin(tenantId: string, db: any): Promise<HealthCheckResult> {
  try {
    const settings = await db('tenant_pudo_settings').where({ tenant_id: tenantId }).first();
    if (!settings) {
      return { service: 'pudo_login', status: 'unconfigured', message: 'PUDO settings not configured', checked_at: new Date().toISOString() };
    }

    const password = decrypt(settings.encrypted_pudo_password);

    const payload = JSON.stringify({
      email: settings.pudo_username,
      password: password,
      remember: true,
    });

    const result = await httpRequest('POST', 'https://api-pudo.co.za/api/v1/auth/login', payload, {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    });

    if (result.status >= 200 && result.status < 300) {
      return { service: 'pudo_login', status: 'healthy', message: 'Login credentials are valid', checked_at: new Date().toISOString() };
    } else if (result.status === 401 || result.status === 422) {
      return { service: 'pudo_login', status: 'unhealthy', message: 'Login credentials are invalid', checked_at: new Date().toISOString() };
    } else {
      return { service: 'pudo_login', status: 'unhealthy', message: `Login returned status ${result.status}`, checked_at: new Date().toISOString() };
    }
  } catch (error: any) {
    log.warn({ tenantId, error: error.message }, 'PUDO login check failed');
    return { service: 'pudo_login', status: 'unhealthy', message: error.message, checked_at: new Date().toISOString() };
  }
}

function httpRequest(method: string, url: string, body: string | null, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout: 10000,
    };

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode || 500, body: data }));
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    if (body) req.write(body);
    req.end();
  });
}

export default router;
