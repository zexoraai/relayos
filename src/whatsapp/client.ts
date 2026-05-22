import https from 'https';

/**
 * Thin wrapper over Meta WhatsApp Cloud API.
 * https://developers.facebook.com/docs/whatsapp/cloud-api
 *
 * Two send paths:
 *   - sendText: free-form text (only allowed within the 24h customer-service window)
 *   - sendTemplate: template message (always allowed once template is approved)
 */
export interface WhatsAppCredentials {
  phoneNumberId: string;
  accessToken: string;
  apiVersion?: string; // defaults to v20.0
}

export interface WhatsAppSendResult {
  wa_message_id: string | null;
  status_code: number;
  raw: any;
}

function postJson(hostname: string, path: string, token: string, body: any, timeoutMs = 15000): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let parsed: any;
        try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('WhatsApp Cloud API timed out')); });
    req.write(payload);
    req.end();
  });
}

/**
 * Strip leading + and any non-digits.
 * Meta expects phone numbers in international format without the leading +.
 */
function toWaPhone(phone: string): string {
  return (phone || '').replace(/[^\d]/g, '');
}

export async function sendText(creds: WhatsAppCredentials, to: string, text: string): Promise<WhatsAppSendResult> {
  const apiVersion = creds.apiVersion || 'v20.0';
  const path = `/${apiVersion}/${creds.phoneNumberId}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toWaPhone(to),
    type: 'text',
    text: { preview_url: false, body: text },
  };
  const res = await postJson('graph.facebook.com', path, creds.accessToken, body);
  if (res.status < 200 || res.status >= 300) {
    const errMsg = res.body?.error?.message || JSON.stringify(res.body).substring(0, 200);
    throw new Error(`WhatsApp send failed (${res.status}): ${errMsg}`);
  }
  return {
    wa_message_id: res.body?.messages?.[0]?.id || null,
    status_code: res.status,
    raw: res.body,
  };
}

export interface TemplateComponent {
  type: 'body' | 'header' | 'button';
  parameters: Array<{ type: 'text'; text: string }>;
}

export async function sendTemplate(
  creds: WhatsAppCredentials,
  to: string,
  templateName: string,
  languageCode: string,
  components: TemplateComponent[],
): Promise<WhatsAppSendResult> {
  const apiVersion = creds.apiVersion || 'v20.0';
  const path = `/${apiVersion}/${creds.phoneNumberId}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: toWaPhone(to),
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components,
    },
  };
  const res = await postJson('graph.facebook.com', path, creds.accessToken, body);
  if (res.status < 200 || res.status >= 300) {
    const errMsg = res.body?.error?.message || JSON.stringify(res.body).substring(0, 200);
    throw new Error(`WhatsApp template send failed (${res.status}): ${errMsg}`);
  }
  return {
    wa_message_id: res.body?.messages?.[0]?.id || null,
    status_code: res.status,
    raw: res.body,
  };
}
