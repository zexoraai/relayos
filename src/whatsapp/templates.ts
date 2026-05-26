/**
 * Template rendering: replaces {{var}} placeholders with values from the variables map.
 * We use simple curly-brace placeholders for free-text messages. When using a Meta-approved
 * template (template_name set), the body_text is what gets sent in the body parameters.
 */
export function renderTemplate(body: string, vars: Record<string, string | number | null | undefined>): string {
  return body.replace(/\{\{\s*([\w_]+)\s*\}\}/g, (_match, key: string) => {
    const v = vars[key];
    return v === null || v === undefined ? '' : String(v);
  });
}

/**
 * Sensible default templates seeded per tenant when WhatsApp is first configured.
 * Tenants can edit these in Settings.
 */
export const DEFAULT_TEMPLATES: Array<{
  purpose: string;
  language_code: string;
  body_text: string;
  variables: string[];
}> = [
  {
    purpose: 'order_confirmed',
    language_code: 'en',
    body_text:
      'Hi {{customer_name}}, your order #{{order_number}} is confirmed. Waybill: {{waybill}}. We will keep you posted as it moves.',
    variables: ['customer_name', 'order_number', 'waybill'],
  },
  {
    purpose: 'order_in_transit',
    language_code: 'en',
    body_text:
      'Hi {{customer_name}}, your order #{{order_number}} is in transit. Track here: https://portal.thecourierguy.co.za/track (waybill {{waybill}}).',
    variables: ['customer_name', 'order_number', 'waybill'],
  },
  {
    purpose: 'order_at_locker',
    language_code: 'en',
    body_text:
      'Hi {{customer_name}}, your parcel for order #{{order_number}} is in the locker. Use PIN {{pincode}} to collect.',
    variables: ['customer_name', 'order_number', 'pincode'],
  },
  {
    purpose: 'order_out_for_delivery',
    language_code: 'en',
    body_text:
      'Hi {{customer_name}}, your order #{{order_number}} is out for delivery today.',
    variables: ['customer_name', 'order_number'],
  },
  {
    purpose: 'order_delivered',
    language_code: 'en',
    body_text:
      'Hi {{customer_name}}, your order #{{order_number}} has been delivered. Thank you!',
    variables: ['customer_name', 'order_number'],
  },
  {
    purpose: 'order_flagged',
    language_code: 'en',
    body_text:
      'Hi {{customer_name}}, we received order #{{order_number}} but need to verify a few details before dispatch. Our team will reach out shortly.',
    variables: ['customer_name', 'order_number'],
  },
  {
    purpose: 'order_details_updated',
    language_code: 'en',
    body_text:
      'Hi {{customer_name}}, we updated the delivery details for your order #{{order_number}}. {{change_summary}} If anything looks wrong, please reply to this message.',
    variables: ['customer_name', 'order_number', 'change_summary'],
  },
];
