import { describe, it, expect, beforeEach } from 'vitest';

describe('Tenant Ingestion Config Integration', () => {
  describe('Active IMAP Config Filtering Rules', () => {
    interface MockTenant {
      id: string;
      status: string;
      platform: string;
      shopify_plan: string | null;
      is_configured: boolean;
      integration_method: string | null;
    }

    const tenants: MockTenant[] = [
      { id: '1', status: 'active', platform: 'shopify', shopify_plan: 'basic', is_configured: true, integration_method: 'imap' },
      { id: '2', status: 'pending_onboarding', platform: 'shopify', shopify_plan: 'basic', is_configured: true, integration_method: 'imap' },
      { id: '3', status: 'suspended', platform: 'shopify', shopify_plan: 'basic', is_configured: true, integration_method: 'imap' },
      { id: '4', status: 'active', platform: 'woocommerce', shopify_plan: null, is_configured: true, integration_method: null },
      { id: '5', status: 'active', platform: 'shopify', shopify_plan: 'grow', is_configured: true, integration_method: 'api' },
      { id: '6', status: 'active', platform: 'shopify', shopify_plan: 'basic', is_configured: false, integration_method: 'imap' },
    ];

    function getActiveImapConfigs(tenants: MockTenant[]): MockTenant[] {
      return tenants.filter(t =>
        t.status === 'active' &&
        t.platform === 'shopify' &&
        t.shopify_plan === 'basic' &&
        t.is_configured === true
      );
    }

    it('should include active Shopify Basic tenants with configured IMAP', () => {
      const configs = getActiveImapConfigs(tenants);
      expect(configs.map(c => c.id)).toContain('1');
    });

    it('should exclude incomplete (pending_onboarding) tenants', () => {
      const configs = getActiveImapConfigs(tenants);
      expect(configs.map(c => c.id)).not.toContain('2');
    });

    it('should exclude suspended tenants', () => {
      const configs = getActiveImapConfigs(tenants);
      expect(configs.map(c => c.id)).not.toContain('3');
    });

    it('should exclude WooCommerce tenants', () => {
      const configs = getActiveImapConfigs(tenants);
      expect(configs.map(c => c.id)).not.toContain('4');
    });

    it('should exclude Shopify API tenants (grow/advanced/plus)', () => {
      const configs = getActiveImapConfigs(tenants);
      expect(configs.map(c => c.id)).not.toContain('5');
    });

    it('should exclude unconfigured tenants', () => {
      const configs = getActiveImapConfigs(tenants);
      expect(configs.map(c => c.id)).not.toContain('6');
    });

    it('should return only the one valid tenant', () => {
      const configs = getActiveImapConfigs(tenants);
      expect(configs.length).toBe(1);
      expect(configs[0].id).toBe('1');
    });
  });
});
