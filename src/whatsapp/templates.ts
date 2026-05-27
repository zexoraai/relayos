/**
 * Template rendering: replaces placeholder tokens with values from the
 * variables map. Two placeholder formats are supported because Meta and
 * RelayOS use different conventions:
 *
 *   1. Named placeholders like `{{customer_name}}` — RelayOS's native
 *      format. Looked up directly on `vars`.
 *
 *   2. Positional placeholders like `{{1}}`, `{{2}}` — Meta's format for
 *      approved templates. Resolved by looking up the variable name at
 *      `orderedVars[n - 1]` (when provided) and then reading that name
 *      from `vars`. Without `orderedVars`, positional placeholders fall
 *      back to looking up the digit string itself on `vars` (so a caller
 *      can pass `{ '1': 'Marlize Gouws' }` directly if it knows the
 *      positional shape).
 *
 * The split matters for the audit-log render: `whatsapp_messages.body`
 * is generated from the template body, and when we have a Meta-approved
 * template stored verbatim ({{1}} / {{2}} format), the old renderer left
 * placeholders as empty strings — which made the audit log look like
 * the customer received an empty greeting. With ordered variable names
 * we can show the resolved body in the same shape Meta delivers.
 */
export function renderTemplate(
  body: string,
  vars: Record<string, string | number | null | undefined>,
  orderedVars?: string[],
): string {
  return body.replace(/\{\{\s*([\w_]+)\s*\}\}/g, (_match, key: string) => {
    let value: any;
    if (/^\d+$/.test(key)) {
      // Positional placeholder. Try orderedVars first, then fall back to
      // a direct numeric-keyed lookup.
      const idx = parseInt(key, 10) - 1;
      const namedKey = orderedVars && orderedVars[idx];
      value = namedKey ? vars[namedKey] : vars[key];
    } else {
      value = vars[key];
    }
    return value === null || value === undefined ? '' : String(value);
  });
}

/**
 * Default mapping from a template purpose to the domain event(s) that
 * should trigger it. The whatsappEventSubscriber matches templates by
 * `event_types @> [event_type]`, so a template with an empty event_types
 * array will never fire — which means tenants seeded before this default
 * was wired ended up silent. New tenants pick this up at seed time;
 * existing tenants are backfilled by migration
 * `20260601000003_backfill_whatsapp_template_event_types.ts`.
 */
export const DEFAULT_EVENT_TYPES_BY_PURPOSE: Record<string, string[]> = {
  order_confirmed: ['order.confirmed'],
  order_in_transit: ['order.in_transit'],
  order_at_locker: ['order.at_locker'],
  order_out_for_delivery: ['order.out_for_delivery'],
  order_delivered: ['order.delivered'],
  order_flagged: ['order.flagged'],
  // order_details_updated is dispatched explicitly from the caretaker
  // resolve handler, not via a domain event — leave its event_types empty.
  order_details_updated: [],
};

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
