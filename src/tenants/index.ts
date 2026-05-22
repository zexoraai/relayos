import { getDb } from '../db/connection';
import { encrypt, decrypt } from '../crypto';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'tenants' });

export interface TenantImapConfig {
  tenant_id: string;
  ecommerce_integration_id: string;
  imap_host: string;
  imap_port: number;
  imap_username: string;
  imap_password: string; // decrypted
  imap_mailbox: string;
  imap_use_ssl: boolean;
  polling_interval: number;
  batch_size: number;
}

/**
 * Returns active IMAP ingestion configs for all tenants that:
 * - Have status = 'active'
 * - Have a configured Shopify Basic ecommerce integration
 * - Have IMAP settings stored
 *
 * This is the integration point for the existing Email Ingestion service.
 */
export async function getActiveImapIngestionConfigs(): Promise<TenantImapConfig[]> {
  const db = getDb();

  const rows = await db('tenant_imap_settings as tis')
    .join('tenant_ecommerce_integrations as tei', 'tis.ecommerce_integration_id', 'tei.id')
    .join('tenants as t', 'tei.tenant_id', 't.id')
    .where('t.status', 'active')
    .where('tei.platform', 'shopify')
    .where('tei.shopify_plan', 'basic')
    .where('tei.is_configured', true)
    .select(
      'tis.tenant_id',
      'tis.ecommerce_integration_id',
      'tis.imap_host',
      'tis.imap_port',
      'tis.imap_username',
      'tis.encrypted_imap_password',
      'tis.imap_mailbox',
      'tis.imap_use_ssl',
      'tis.polling_interval',
      'tis.batch_size'
    );

  return rows.map((row: any) => ({
    tenant_id: row.tenant_id,
    ecommerce_integration_id: row.ecommerce_integration_id,
    imap_host: row.imap_host,
    imap_port: row.imap_port,
    imap_username: row.imap_username,
    imap_password: decrypt(row.encrypted_imap_password),
    imap_mailbox: row.imap_mailbox,
    imap_use_ssl: row.imap_use_ssl,
    polling_interval: row.polling_interval,
    batch_size: row.batch_size,
  }));
}

/**
 * Get a single tenant's IMAP config by tenant ID.
 */
export async function getTenantImapConfig(tenantId: string): Promise<TenantImapConfig | null> {
  const db = getDb();

  const row = await db('tenant_imap_settings as tis')
    .join('tenant_ecommerce_integrations as tei', 'tis.ecommerce_integration_id', 'tei.id')
    .join('tenants as t', 'tei.tenant_id', 't.id')
    .where('tis.tenant_id', tenantId)
    .where('tei.platform', 'shopify')
    .where('tei.shopify_plan', 'basic')
    .first(
      'tis.tenant_id',
      'tis.ecommerce_integration_id',
      'tis.imap_host',
      'tis.imap_port',
      'tis.imap_username',
      'tis.encrypted_imap_password',
      'tis.imap_mailbox',
      'tis.imap_use_ssl',
      'tis.polling_interval',
      'tis.batch_size'
    );

  if (!row) return null;

  return {
    tenant_id: row.tenant_id,
    ecommerce_integration_id: row.ecommerce_integration_id,
    imap_host: row.imap_host,
    imap_port: row.imap_port,
    imap_username: row.imap_username,
    imap_password: decrypt(row.encrypted_imap_password),
    imap_mailbox: row.imap_mailbox,
    imap_use_ssl: row.imap_use_ssl,
    polling_interval: row.polling_interval,
    batch_size: row.batch_size,
  };
}
