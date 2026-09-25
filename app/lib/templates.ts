export type MandateFields = {
  cap: string;
  perTxMax: string;
  expiryDays: string;
  merchant: string;
  purpose: string;
};

export type MandateTemplate = {
  id: string;
  title: string;
  summary: string;
  fields: MandateFields;
};

export const EMPTY_FIELDS: MandateFields = {
  cap: '',
  perTxMax: '',
  expiryDays: '',
  merchant: '',
  purpose: '',
};

export const BUILD_YOUR_OWN_IDS = ['charging-agent', 'buying-compute'] as const;

export const TEMPLATES: MandateTemplate[] = [
  {
    id: 'charging-agent',
    title: 'Charging agent',
    summary: 'Starting limits for an agent that pays a charger. Choosing this does not invent a charge.',
    fields: {
      cap: '80',
      perTxMax: '12',
      expiryDays: '30',
      merchant: '',
      purpose: 'charging agent',
    },
  },
  {
    id: 'buying-compute',
    title: 'Agent buying compute',
    summary: 'Starting limits for an agent that pays for compute. Choosing this does not invent a price.',
    fields: {
      cap: '40',
      perTxMax: '8',
      expiryDays: '7',
      merchant: '',
      purpose: 'agent buying compute',
    },
  },
  {
    id: 'mint-bot',
    title: 'Cap a mint bot',
    summary: 'Starting limits only. Choosing this does not claim any mint has run.',
    fields: {
      cap: '50',
      perTxMax: '5',
      expiryDays: '7',
      merchant: '',
      purpose: 'cap a mint bot',
    },
  },
  {
    id: 'quest-farm',
    title: 'Cap a quest-farm spend',
    summary: 'Starting limits only. Choosing this does not claim any quest has been farmed.',
    fields: {
      cap: '20',
      perTxMax: '2',
      expiryDays: '7',
      merchant: '',
      purpose: 'cap a quest-farm spend',
    },
  },
  {
    id: 'weekly-outgoings',
    title: 'Cap an agent weekly outgoings',
    summary: 'Starting limits only. Choosing this does not claim any week of spend.',
    fields: {
      cap: '100',
      perTxMax: '10',
      expiryDays: '7',
      merchant: '',
      purpose: 'cap an agent weekly outgoings',
    },
  },
  {
    id: 'charge-car',
    title: 'Charge the car under a price',
    summary: 'Starting limits only. Choosing this does not invent a price or a charge.',
    fields: {
      cap: '20',
      perTxMax: '0.50',
      expiryDays: '40',
      merchant: '',
      purpose: 'charge the car under a price',
    },
  },
];

export function templateById(id: string): MandateTemplate | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

export function applyTemplate(template: MandateTemplate): MandateFields {
  return {
    cap: template.fields.cap,
    perTxMax: template.fields.perTxMax,
    expiryDays: template.fields.expiryDays,
    merchant: template.fields.merchant,
    purpose: template.fields.purpose,
  };
}

export function assertTemplateIsEmptyStart(template: MandateTemplate): void {
  const record = template as unknown as Record<string, unknown>;
  if ('history' in record || 'transactions' in record || 'prices' in record) {
    throw new Error(`template ${template.id} must not ship history, transactions, or prices`);
  }
}
