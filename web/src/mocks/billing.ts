/**
 * Котировки, счета, платежи, заявки на оплату, сверка, курсы.
 *
 * Обязательный случай `SPEC.md § 11`: счёт поставщика с тремя типами
 * расхождений. Без него экран сверки нечего показывать.
 */
import type {
  DocumentLine,
  DocumentTotals,
  FxSnapshot,
  Invoice,
  PayableItem,
  Payment,
  Quote,
  VendorInvoice,
} from '@/api/types';

import { CLIENTS, VENDOR_BY_ID } from './counterparties';
import { FLIGHTS, MARGINS, ordersForFlight } from './flights';
import { SERVICE_BY_ID, daysFromNow } from './reference';

export const FX_TODAY: FxSnapshot = {
  date: daysFromNow(0),
  base: 'RUB',
  rates: { RUB: '1', USD: '92.4500', EUR: '100.1200' },
  policy: 'document_date',
  source: 'synthetic',
  staleSince: null,
};

/** История курсов за 30 дней — для графика на `/billing/fx`. */
export const FX_HISTORY = Array.from({ length: 30 }, (_, i) => {
  const drift = Math.sin(i / 4) * 1.4 + Math.cos(i / 7) * 0.8;
  return {
    date: daysFromNow(i - 29),
    usd: (92.45 + drift).toFixed(4),
    eur: (100.12 + drift * 1.1).toFixed(4),
  };
});

function money(amount: number, currency: 'RUB' | 'USD' | 'EUR') {
  return { amount: amount.toFixed(4), currency };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Строки документа и итоги.
 *
 * ADR-002: итог считается суммой **уже округлённых** строк, чтобы «итого»
 * сходилось с колонкой на экране и в печатной форме. Здесь это воспроизведено
 * буквально — макет не должен показывать сумму, которая не сходится.
 */
function buildDocument(
  flightId: string,
  useActual: boolean,
): { lines: DocumentLine[]; totals: DocumentTotals; currency: 'RUB' | 'USD' | 'EUR' } {
  const flight = FLIGHTS.find((f) => f.id === flightId);
  if (!flight) throw new Error(`рейс не найден: ${flightId}`);
  const currency = flight.billingCurrency;
  const orders = ordersForFlight(flightId).filter(
    (o) => o.status !== 'rejected' && o.status !== 'cancelled',
  );

  const vatPercent = flight.isInternational ? 0 : 20;

  const lines: DocumentLine[] = orders.map((order) => {
    const quantity = useActual
      ? (order.actualQuantity ?? order.quantity)
      : order.quantity;
    const unit = Number.parseFloat(order.salePrice?.amount ?? '0')
      / Math.max(1, Number.parseFloat(order.quantity));
    const amount = round2(unit * Number.parseFloat(quantity));
    const vat = round2((amount * vatPercent) / 100);

    return {
      serviceOrderId: order.id,
      description: SERVICE_BY_ID.get(order.serviceId)?.name.ru ?? order.serviceId,
      airportIcao: order.airportIcao,
      quantity,
      unitPrice: money(unit, currency),
      amount: money(amount, currency),
      vatRateId: vatPercent === 0 ? 'vat_0' : 'vat_20',
      vatAmount: money(vat, currency),
    };
  });

  const subtotal = round2(lines.reduce((s, l) => s + Number.parseFloat(l.amount.amount), 0));
  const vatTotal = round2(
    lines.reduce((s, l) => s + Number.parseFloat(l.vatAmount?.amount ?? '0'), 0),
  );
  const fees = round2(subtotal * 0.02);
  const discount = 0;
  const grand = round2(subtotal + fees + vatTotal - discount);

  return {
    lines,
    currency,
    totals: {
      subtotal: money(subtotal, currency),
      discountTotal: money(discount, currency),
      feesTotal: money(fees, currency),
      vatTotal: money(vatTotal, currency),
      grandTotal: money(grand, currency),
    },
  };
}

// ─────────────────────────── Котировки ───────────────────────────

const QUOTE_FLIGHTS = FLIGHTS.filter((f) => f.status !== 'planned').slice(0, 22);

export const QUOTES: Quote[] = QUOTE_FLIGHTS.map((flight, index) => {
  const doc = buildDocument(flight.id, false);
  const status: Quote['status'] =
    index % 7 === 0 ? 'draft'
      : index % 7 === 1 ? 'issued'
        : index % 7 === 5 ? 'declined'
          : index % 7 === 6 ? 'expired'
            : 'accepted';

  return {
    id: `qt_${String(index + 1).padStart(3, '0')}`,
    number: status === 'draft' ? null : `SOC-Q-2026-${String(index + 41).padStart(4, '0')}`,
    flightId: flight.id,
    clientId: flight.clientId,
    status,
    issuedAt: status === 'draft' ? null : daysFromNow(-12 + index),
    validUntil: status === 'draft' ? null : daysFromNow(18 + index),
    currency: doc.currency,
    fx: FX_TODAY,
    lines: doc.lines,
    fees: [{ code: 'handling_fee', description: 'Сбор за организацию', kind: 'percent', value: '2.0000', amount: doc.totals.feesTotal }],
    totals: doc.totals,
    voidedByDocId: null,
    isDemo: true,
  };
});

// ─────────────────────────── Счета ───────────────────────────

const INVOICE_FLIGHTS = FLIGHTS.filter((f) => f.status === 'completed').slice(0, 16);

export const INVOICES: Invoice[] = INVOICE_FLIGHTS.map((flight, index) => {
  const doc = buildDocument(flight.id, true);
  const plan = buildDocument(flight.id, false);
  const client = CLIENTS.find((c) => c.id === flight.clientId);

  const status: Invoice['status'] =
    index % 6 === 0 ? 'issued'
      : index % 6 === 1 ? 'sent'
        : index % 6 === 2 ? 'partially_paid'
          : index % 6 === 5 ? 'overdue'
            : 'paid';

  const grand = Number.parseFloat(doc.totals.grandTotal.amount);
  const paid = status === 'paid' ? grand : status === 'partially_paid' ? round2(grand * 0.4) : 0;

  // Сопоставление «план ↔ факт»: видно, за счёт чего счёт отличается
  // от котировки (SPEC § 7.2).
  const comparison = doc.lines
    .map((line, i) => {
      const planLine = plan.lines[i];
      if (!planLine) return null;
      if (planLine.quantity === line.quantity) return null;
      return {
        serviceOrderId: line.serviceOrderId ?? '',
        kind: 'quantity_changed' as const,
        planValue: planLine.amount,
        factValue: line.amount,
        comment: `План ${planLine.quantity}, факт ${line.quantity}`,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return {
    id: `inv_${String(index + 1).padStart(3, '0')}`,
    number: `SOC-I-2026-${String(index + 107).padStart(4, '0')}`,
    flightId: flight.id,
    clientId: flight.clientId,
    quoteId: QUOTES.find((q) => q.flightId === flight.id)?.id ?? null,
    status,
    issuedAt: daysFromNow(-10 + index),
    dueDate: daysFromNow(-10 + index + (client?.paymentTerms.deferDays ?? 0)),
    currency: doc.currency,
    fx: FX_TODAY,
    lines: doc.lines,
    fees: [{ code: 'handling_fee', description: 'Сбор за организацию', kind: 'percent', value: '2.0000', amount: doc.totals.feesTotal }],
    totals: doc.totals,
    paidAmount: money(paid, doc.currency),
    planFactComparison: comparison,
    voidedByDocId: null,
    isDemo: true,
  };
});

// ─────────────────────────── Платежи ───────────────────────────
// ADR-019: статус счёта вычисляется из суммы платежей, а не присваивается.

export const PAYMENTS: Payment[] = INVOICES.filter(
  (i) => i.status === 'paid' || i.status === 'partially_paid',
).map((invoice, index) => ({
  id: `pay_${String(index + 1).padStart(3, '0')}`,
  clientId: invoice.clientId,
  amount: invoice.paidAmount ?? money(0, invoice.currency),
  receivedAt: daysFromNow(-4 + index),
  allocations: [{ invoiceId: invoice.id, amount: invoice.paidAmount ?? money(0, invoice.currency) }],
  source: index % 3 === 0 ? 'onec' : 'manual',
  externalId: index % 3 === 0 ? `1C-PP-${3400 + index}` : '',
  comment: '',
  fxRate: '1.0000',
  createdAt: daysFromNow(-4 + index),
}));

// ─────────────────────────── Заявки на оплату ───────────────────────────

export const PAYABLES: PayableItem[] = FLIGHTS.filter((f) => f.status === 'completed')
  .flatMap((flight) =>
    ordersForFlight(flight.id)
      .filter((o) => o.status === 'completed')
      .map((order) => ({ flight, order })),
  )
  .slice(0, 34)
  .map(({ order }, index) => {
    const vendor = VENDOR_BY_ID.get(order.vendorId ?? '');
    const defer = order.contractTermsSnapshot?.deferDays ?? 30;
    const dueOffset = -18 + index;
    const status: PayableItem['status'] =
      index % 8 === 0 ? 'pending'
        : index % 8 === 1 ? 'approved'
          : index % 8 === 2 ? 'scheduled'
            : index % 8 === 7 ? 'disputed'
              : 'paid';

    return {
      id: `pbl_${String(index + 1).padStart(3, '0')}`,
      number: `SOC-P-2026-${String(index + 201).padStart(4, '0')}`,
      vendorId: order.vendorId ?? '',
      vendorName: vendor?.name ?? '',
      serviceOrderIds: [order.id],
      amount: order.purchaseCost ?? money(0, 'RUB'),
      dueDate: daysFromNow(dueOffset + defer),
      status,
      isOverdue: status !== 'paid' && dueOffset + defer < 0,
      vendorInvoiceId: index < 5 ? 'vinv_001' : null,
    };
  });

// ─────────────────────────── Сверка ───────────────────────────
// Обязательный случай: счёт с тремя типами расхождений (SPEC § 11).

const reconciledPayables = PAYABLES.slice(0, 6);

export const VENDOR_INVOICES: VendorInvoice[] = [
  {
    id: 'vinv_001',
    vendorId: 'ven_003',
    number: 'ХП-2026/4471',
    issuedAt: daysFromNow(-6),
    currency: 'RUB',
    lines: [
      // 1. Совпадает полностью
      { airportIcao: 'UUEE', serviceDate: daysFromNow(-9), serviceCode: 'GH-BASE', quantity: '1', unitPrice: money(48000, 'RUB'), amount: money(48000, 'RUB') },
      // 2. Расхождение цены
      { airportIcao: 'UUDD', serviceDate: daysFromNow(-8), serviceCode: 'GH-BASE', quantity: '1', unitPrice: money(49900, 'RUB'), amount: money(49900, 'RUB') },
      // 3. Расхождение количества
      { airportIcao: 'UUEE', serviceDate: daysFromNow(-7), serviceCode: 'GH-TOW', quantity: '3', unitPrice: money(18000, 'RUB'), amount: money(54000, 'RUB') },
      // 4. Есть у поставщика, нет у нас
      { airportIcao: 'UUWW', serviceDate: daysFromNow(-7), serviceCode: 'GH-CLEAN-XL', quantity: '1', unitPrice: money(21000, 'RUB'), amount: money(21000, 'RUB') },
      // 5. В пределах допуска на округление — расхождением не считается
      { airportIcao: 'UUEE', serviceDate: daysFromNow(-6), serviceCode: 'GH-BASE', quantity: '1', unitPrice: money(48000.01, 'RUB'), amount: money(48000.01, 'RUB') },
    ],
    unmappedCodes: ['GH-CLEAN-XL'],
    reconciliation: {
      matched: [
        { lineIndex: 0, serviceOrderId: reconciledPayables[0]?.serviceOrderIds?.[0] ?? 'so_001_01' },
        { lineIndex: 4, serviceOrderId: reconciledPayables[4]?.serviceOrderIds?.[0] ?? 'so_005_01' },
      ],
      discrepancies: [
        {
          kind: 'price_mismatch', lineIndex: 1,
          serviceOrderId: reconciledPayables[1]?.serviceOrderIds?.[0] ?? 'so_002_01',
          ours: money(44500, 'RUB'), theirs: money(49900, 'RUB'),
          resolution: null, comment: null,
        },
        {
          kind: 'quantity_mismatch', lineIndex: 2,
          serviceOrderId: reconciledPayables[2]?.serviceOrderIds?.[0] ?? 'so_003_01',
          ours: money(18000, 'RUB'), theirs: money(54000, 'RUB'),
          resolution: null, comment: null,
        },
        {
          kind: 'missing_on_our_side', lineIndex: 3, serviceOrderId: null,
          ours: null, theirs: money(21000, 'RUB'),
          resolution: null, comment: null,
        },
        {
          kind: 'missing_on_their_side', lineIndex: null,
          serviceOrderId: reconciledPayables[5]?.serviceOrderIds?.[0] ?? 'so_006_01',
          ours: money(12500, 'RUB'), theirs: null,
          resolution: null, comment: null,
        },
      ],
      totalOurs: money(171000, 'RUB'),
      totalTheirs: money(220900.01, 'RUB'),
      delta: money(-49900.01, 'RUB'),
      resolvedAt: null,
    },
  },
  {
    id: 'vinv_002',
    vendorId: 'ven_001',
    number: 'АТЦ-2026-882',
    issuedAt: daysFromNow(-12),
    currency: 'RUB',
    lines: [
      { airportIcao: 'UUEE', serviceDate: daysFromNow(-15), serviceCode: 'JETA1', quantity: '4820', unitPrice: money(72.4, 'RUB'), amount: money(348968, 'RUB') },
    ],
    unmappedCodes: [],
    reconciliation: {
      matched: [{ lineIndex: 0, serviceOrderId: 'so_001_02' }],
      discrepancies: [],
      totalOurs: money(348968, 'RUB'),
      totalTheirs: money(348968, 'RUB'),
      delta: money(0, 'RUB'),
      resolvedAt: daysFromNow(-10),
    },
  },
];

// ─────────────────────────── Сводки для дашбордов ───────────────────────────

export function marginFor(flightId: string) {
  return MARGINS.get(flightId);
}

export const RECEIVABLES_BUCKETS = [
  { bucket: '0–30', amount: money(4_820_400, 'RUB') },
  { bucket: '31–60', amount: money(1_264_900, 'RUB') },
  { bucket: '60+', amount: money(388_100, 'RUB') },
];

export const PAYABLES_BUCKETS = [
  { bucket: '0–30', amount: money(3_140_200, 'RUB') },
  { bucket: '31–60', amount: money(742_600, 'RUB') },
  { bucket: '60+', amount: money(96_400, 'RUB') },
];
