import https from 'https';

/**
 * WhatsApp Business Management API — template lifecycle.
 * https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
 *
 * Note: requires a System User token tied to the Business Account.
 * The Cloud API access token is NOT enough — it can send messages but not manage templates.
 */

export type MetaTemplateCategory = 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
export type MetaTemplateStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED' | 'DRAFT';

export interface MetaTemplateButton {
  type: 'URL' | 'PHONE_NUMBER' | 'QUICK_REPLY';
  text: string;
  url?: string;
  phone_number?: string;
}

export interface CreateTemplateInput {
  name: string;                    // lowercase + underscores only
  language: string;                // 'en', 'en_US', etc.
  category: MetaTemplateCategory;
  body_text: string;               // with {{1}}, {{2}} placeholders
  body_examples?: string[];        // sample values for each {{n}} (required by Meta for review)
  header_text?: string;
  footer_text?: string;
  buttons?: MetaTemplateButton[];
}

export interface MetaTemplateResponse {
  id: string;
  status: MetaTemplateStatus;
  category: MetaTemplateCategory;
}

export interface MetaTemplateDetail {
  id: string;
  name: string;
  status: MetaTemplateStatus;
  category: MetaTemplateCategory;
  language: string;
  components: any[];
  quality_score?: { score: string };
}

interface MetaCredentials {
  businessAccountId: string;
  systemUserToken: string;
  apiVersion?: string;
}

/**
 * Convert an internal template body (with {{var_name}}) into Meta's positional format ({{1}}, {{2}}).
 * Returns the rewritten body and the ordered variable names.
 */
export function convertBodyForMeta(body: string, declaredVars: string[]): { metaBody: string; orderedVars: string[] } {
  const orderedVars: string[] = [];
  const metaBody = body.replace(/\{\{\s*([\w_]+)\s*\}\}/g, (_match, key: string) => {
    if (declaredVars.includes(key) && !orderedVars.includes(key)) {
      orderedVars.push(key);
    }
    const idx = orderedVars.indexOf(key);
    return idx >= 0 ? `{{${idx + 1}}}` : `{{${key}}}`;
  });
  return { metaBody, orderedVars };
}

/**
 * Validate a template name against Meta's rules.
 * - Lowercase letters, digits, underscores
 * - Max 512 chars
 * - Cannot start with a digit
 */
export function validateTemplateName(name: string): { ok: boolean; error?: string } {
  if (!name) return { ok: false, error: 'Name required' };
  if (name.length > 512) return { ok: false, error: 'Name too long (max 512)' };
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    return { ok: false, error: 'Name must be lowercase letters, digits, underscores. Cannot start with a digit.' };
  }
  return { ok: true };
}

/**
 * List every template that lives on the WhatsApp Business Account.
 *
 * Used by the operator to "import" approved templates from Meta into our
 * local whatsapp_templates table. Without this they would have to retype
 * the template name + language + variable order, and any mismatch with
 * Meta's actual record causes the send to fail with the silent
 * "structure does not match" error code.
 *
 * Meta returns up to 25 templates per page by default; we follow the
 * paging cursor and stitch the full list into one array so the caller
 * doesn't have to handle paging.
 */
export interface MetaTemplateListItem {
  id: string;
  name: string;
  language: string;
  status: MetaTemplateStatus;
  category: MetaTemplateCategory;
  components: any[];
}

export async function listMetaTemplates(creds: MetaCredentials): Promise<MetaTemplateListItem[]> {
  const apiVersion = creds.apiVersion || 'v20.0';
  const out: MetaTemplateListItem[] = [];
  let path: string | null =
    `/${apiVersion}/${creds.businessAccountId}/message_templates` +
    `?fields=id,name,status,category,language,components&limit=100`;

  let pages = 0;
  while (path && pages < 20) {
    const r: any = await getJson('graph.facebook.com', path, creds.systemUserToken);
    if (Array.isArray(r?.data)) {
      for (const t of r.data) {
        out.push({
          id: t.id,
          name: t.name,
          language: t.language,
          status: t.status,
          category: t.category,
          components: t.components || [],
        });
      }
    }
    // Meta's paging shape: `paging.next` is a full URL; convert to path.
    const nextUrl: string | undefined = r?.paging?.next;
    if (nextUrl) {
      try {
        const u = new URL(nextUrl);
        path = u.pathname + (u.search || '');
      } catch {
        path = null;
      }
    } else {
      path = null;
    }
    pages += 1;
  }
  return out;
}

/**
 * Submit a new template to Meta for approval.
 */
export async function createMetaTemplate(
  creds: MetaCredentials,
  input: CreateTemplateInput,
): Promise<MetaTemplateResponse> {
  const apiVersion = creds.apiVersion || 'v20.0';
  const path = `/${apiVersion}/${creds.businessAccountId}/message_templates`;

  const components: any[] = [];

  if (input.header_text) {
    components.push({ type: 'HEADER', format: 'TEXT', text: input.header_text });
  }

  const bodyComponent: any = { type: 'BODY', text: input.body_text };
  if (input.body_examples && input.body_examples.length) {
    bodyComponent.example = { body_text: [input.body_examples] };
  }
  components.push(bodyComponent);

  if (input.footer_text) {
    components.push({ type: 'FOOTER', text: input.footer_text });
  }

  if (input.buttons && input.buttons.length) {
    components.push({
      type: 'BUTTONS',
      buttons: input.buttons.map((b) => {
        const btn: any = { type: b.type, text: b.text };
        if (b.url) btn.url = b.url;
        if (b.phone_number) btn.phone_number = b.phone_number;
        return btn;
      }),
    });
  }

  const body = {
    name: input.name,
    language: input.language,
    category: input.category,
    components,
  };

  const result = await postJson('graph.facebook.com', path, creds.systemUserToken, body);
  return {
    id: result.id,
    status: (result.status || 'PENDING') as MetaTemplateStatus,
    category: (result.category || input.category) as MetaTemplateCategory,
  };
}

/**
 * Fetch the current state of a template from Meta.
 * Used to poll for approval status.
 */
export async function getMetaTemplate(creds: MetaCredentials, templateId: string): Promise<MetaTemplateDetail> {
  const apiVersion = creds.apiVersion || 'v20.0';
  const path = `/${apiVersion}/${templateId}?fields=id,name,status,category,language,components,quality_score`;
  return getJson('graph.facebook.com', path, creds.systemUserToken);
}

/**
 * Delete a template from Meta.
 */
export async function deleteMetaTemplate(creds: MetaCredentials, businessAccountId: string, templateName: string): Promise<void> {
  const apiVersion = creds.apiVersion || 'v20.0';
  const path = `/${apiVersion}/${businessAccountId}/message_templates?name=${encodeURIComponent(templateName)}`;
  await deleteRequest('graph.facebook.com', path, creds.systemUserToken);
}

// ---- Low-level HTTP helpers ----

function postJson(hostname: string, path: string, token: string, body: any): Promise<any> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let parsed: any;
        try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
        if (!res.statusCode || res.statusCode >= 400) {
          const errMsg = parsed?.error?.message || JSON.stringify(parsed).substring(0, 300);
          return reject(new Error(`Meta API ${res.statusCode}: ${errMsg}`));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Meta API timeout')); });
    req.write(payload);
    req.end();
  });
}

function getJson(hostname: string, path: string, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let parsed: any;
        try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
        if (!res.statusCode || res.statusCode >= 400) {
          const errMsg = parsed?.error?.message || JSON.stringify(parsed).substring(0, 300);
          return reject(new Error(`Meta API ${res.statusCode}: ${errMsg}`));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Meta API timeout')); });
    req.end();
  });
}

function deleteRequest(hostname: string, path: string, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 400) return reject(new Error(`Meta DELETE ${res.statusCode}: ${data.substring(0, 200)}`));
        resolve();
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Meta API timeout')); });
    req.end();
  });
}
