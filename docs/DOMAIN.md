# DOMAIN.md — модель данных, автоматы и расчёты

Источник истины для `src/domain/`. Типы приводятся как ориентир: Claude Code вправе уточнять
имена полей, но не структуру связей и не формулы. Любое отступление — в `docs/DECISIONS.md`.

---

## 1. Общие соглашения

```ts
type Id = string;                        // ULID-подобный, префикс сущности: 'flt_01H...'
type IsoUtc = string;                    // '2026-09-12T12:40:00.000Z' — всегда UTC
type IcaoCode = string;                  // 'UUEE'
type IataCode = string;                  // 'SVO'
type CurrencyCode = 'USD' | 'EUR' | 'RUB';
type Locale = 'ru' | 'en';

/** Деньги. amount — десятичная строка. Арифметика только через domain/money. */
interface Money {
  amount: string;
  currency: CurrencyCode;
}

/** База всех сущностей. */
interface Entity {
  id: Id;
  createdAt: IsoUtc;
  updatedAt: IsoUtc;
  isDemo: boolean;                       // для seed_demo --purge
  dataSource: 'synthetic' | 'user' | 'imported' | 'live';   // происхождение, ADR-010
}
```

Правила `Money`:
- сложение и вычитание допустимы только для одинаковой валюты, иначе исключение;
- конвертация — явная функция `convert(money, to, rate)`, неявной конвертации нет;
- округление `Decimal.ROUND_HALF_UP`, 2 знака, **только на выходе** расчёта;
- для процентов и коэффициентов — 6 знаков внутри, округление на финальной сумме.

---

## 2. Справочники

```ts
interface Airport extends Entity {
  icao: IcaoCode;
  iata?: IataCode;
  name: string;                          // { ru, en } через i18n-ключ или два поля
  city: string;
  country: string;                       // ISO 3166-1 alpha-2
  timezone: string;                      // IANA, 'Europe/Moscow'
  lat: number;
  lon: number;
  elevationFt: number;
}

interface AircraftType extends Entity {
  icaoType: string;                      // 'CL60', 'GLF5', 'B738'
  name: string;
  category: 'light' | 'midsize' | 'heavy' | 'airliner' | 'cargo';
  seats: number;
  cruiseSpeedKts: number;
  fuelBurnKgPerHour: number;
  turnaroundMin: number;                 // минимум между рейсами, для конфликтов
}

interface Aircraft extends Entity {
  registration: string;                  // бортовой номер, 'RA-67231'
  typeId: Id;
  operatorId?: Id;                       // клиент-оператор, если борт клиента
  status: 'serviceable' | 'maintenance' | 'aog';
  homeBaseIcao: IcaoCode;
  notes?: string;
}

interface ServiceCatalogItem extends Entity {
  code: string;                          // 'FUEL_JETA1', 'HND_BASIC'
  category: ServiceCategory;
  nameRu: string;
  nameEn: string;
  unit: 'L' | 'kg' | 'ea' | 'hour' | 'pax' | 'flight';
  requiresWeather: boolean;              // противообледенительная обработка
  leadTimeH: number;                     // минимальный лидтайм заказа
  requiredAttributes: ServiceAttributeDef[];
  requiresActToComplete: boolean;
}

type ServiceCategory =
  | 'fuel'            // топливообеспечение
  | 'handling'        // наземное обслуживание
  | 'catering'        // кейтеринг
  | 'transport'       // транспорт
  | 'permits'         // разрешительные документы
  | 'deicing';        // противообледенительная обработка

interface ServiceAttributeDef {
  key: string;                           // 'fuelGrade', 'volumeL', 'paxCount'
  type: 'number' | 'string' | 'enum' | 'boolean';
  options?: string[];
  required: boolean;
}
```

---

## 3. Контрагенты

```ts
interface Client extends Entity {        // авиакомпания-заказчик
  name: string;
  legalName: string;
  country: string;
  settlementCurrency: CurrencyCode;
  paymentTerms: PaymentTerms;
  contacts: Contact[];
  defaultLocale: Locale;
  creditLimit?: Money;
  isActive: boolean;
}

interface PaymentTerms {
  mode: 'prepayment' | 'postpayment' | 'deferred';
  deferDays: number;                     // 0 для prepayment/postpayment
  prepaymentPercent?: string;            // десятичная строка, для prepayment
}

interface Vendor extends Entity {
  name: string;
  legalName: string;
  specializations: ServiceCategory[];
  coverage: { airports: IcaoCode[]; regions: string[] };
  settlementCurrency: CurrencyCode;
  paymentTerms: PaymentTerms;
  certificates: VendorCertificate[];
  contacts: Contact[];
  manualQualityScore: number;            // 0..5, ставит диспетчер
  isActive: boolean;
}

interface VendorCertificate {
  kind: 'IATA' | 'ADR' | 'ISO' | 'other';
  number: string;
  validFrom: IsoUtc;
  validTo: IsoUtc;
}

interface Contact {
  name: string;
  role: string;
  email: string;
  phone?: string;
  locale: Locale;
  isPrimary: boolean;
}

interface VendorContract extends Entity {
  vendorId: Id;
  number: string;
  validFrom: IsoUtc;
  validTo: IsoUtc;
  currency: CurrencyCode;
  paymentTerms: PaymentTerms;
  status: 'active' | 'expiring' | 'expired' | 'terminated';  // вычисляется от дат
  attachments: AttachmentRef[];
}

interface VendorPrice extends Entity {
  vendorId: Id;
  serviceId: Id;
  airportIcao: IcaoCode;
  price: Money;                          // за единицу услуги
  minCharge?: Money;
  validFrom: IsoUtc;
  validTo: IsoUtc;
  surcharges: Surcharge[];
}

interface Surcharge {
  code: 'night' | 'weekend' | 'holiday' | 'urgent' | 'into_plane';
  kind: 'percent' | 'fixed';
  value: string;                         // десятичная строка
}
```

---

## 4. Рейсы и услуги

```ts
interface Flight extends Entity {
  number: string;                        // 'SLG-1042'
  clientId: Id;
  aircraftId?: Id;                       // может быть не назначен
  type: 'charter' | 'ferry' | 'ambulance' | 'cargo' | 'technical';
  depIcao: IcaoCode;
  arrIcao: IcaoCode;
  stdUtc: IsoUtc;                        // плановое время вылета
  staUtc: IsoUtc;                        // плановое время прилёта
  atdUtc?: IsoUtc;                       // фактический вылет
  ataUtc?: IsoUtc;                       // фактический прилёт
  status: FlightStatus;
  statusReason?: { code: string; comment: string };   // для cancelled / aog
  paxCount: number;
  crew: CrewMember[];
  distanceNm: number;                    // рассчитывается ортодромией по координатам
  blockTimeMin: number;                  // distance / cruiseSpeed + 20 мин
  fuelPlanKg: number;                    // blockTime * fuelBurn * 1.1
  billingCurrency: CurrencyCode;         // из клиента, фиксируется при создании
  fxSnapshot: FxSnapshot;                // курсы на дату рейса
  templateId?: Id;
  remarks?: string;
}

type FlightStatus =
  | 'planned'               // Запланирован
  | 'in_work'               // В работе
  | 'ready_for_departure'   // Готов к вылету
  | 'in_flight'             // В полёте
  | 'arrived'               // Прилетел   (ADR-009)
  | 'completed'             // Завершён
  | 'cancelled'             // Отменён
  | 'aog';                  // AOG / задержка

interface CrewMember {
  name: string;
  role: 'PIC' | 'SIC' | 'FA' | 'engineer';
  licenseNo?: string;
}

interface FlightTemplate extends Entity {
  name: string;
  clientId: Id;
  aircraftTypeId: Id;
  depIcao: IcaoCode;
  arrIcao: IcaoCode;
  depTimeLocal: string;                  // 'HH:mm' в зоне аэропорта вылета
  weekdays: number[];                    // 1..7
  defaultServices: { serviceId: Id; leg: ServiceLeg; attributes: Record<string, unknown> }[];
}

type ServiceLeg = 'departure' | 'arrival';

interface ServiceOrder extends Entity {
  flightId: Id;
  serviceId: Id;
  leg: ServiceLeg;
  airportIcao: IcaoCode;                 // выводится из leg и рейса
  vendorId?: Id;
  contractId?: Id;
  status: ServiceOrderStatus;
  quantity: string;                      // плановое количество, десятичная строка
  actualQuantity?: string;               // ФАКТИЧЕСКОЕ количество — идёт в счёт (ADR-020)
  attributes: Record<string, unknown>;

  purchasePrice: Money;                  // СНИМОК цены поставщика на момент назначения
  purchaseSurcharges: Surcharge[];       // снимок
  salePrice: Money;                      // рассчитан по тарифу клиента
  tariffRuleId?: Id;                     // какое правило сработало — для объяснимости

  orderedAt?: IsoUtc;
  confirmedAt?: IsoUtc;
  startedAt?: IsoUtc;
  completedAt?: IsoUtc;
  actualStartAt?: IsoUtc;                // фактическое время оказания — идёт в биллинг
  actualEndAt?: IsoUtc;

  slaConfirmDeadline?: IsoUtc;
  slaBreached: boolean;
  rejectionReason?: string;
  replacedOrderId?: Id;                  // при переназначении поставщика
  documents: AttachmentRef[];
}

type ServiceOrderStatus =
  | 'draft' | 'ordered' | 'confirmed' | 'in_progress'
  | 'completed' | 'rejected' | 'cancelled';

interface AttachmentRef {
  id: Id;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: 'act' | 'receipt' | 'invoice' | 'waybill' | 'contract' | 'other';
  storageKey: string;                    // ключ в S3-совместимом хранилище (ADR-007)
  uploadedAt: IsoUtc;
  uploadedBy: Id;
}
```

---

## 5. Автоматы состояний

### 5.1 Рейс

> Определение автомата — `shared/state-machines/flight.json`. Он является источником
> истины для сервера и клиента одновременно (ADR-015); текст ниже описывает его,
> а не дублирует.

```
planned ──start──▶ in_work ──ready──▶ ready_for_departure ──depart──▶ in_flight
   │                  │                      │                            │
   │                  │                      │                      arrive│
   ├──cancel──────────┼──────────────────────┤                            ▼
   ▼                  ▼                      ▼                         arrived
cancelled          cancelled              cancelled                       │
                      │                      │                    complete│
                      └────aog───────────────┴──▶ aog                     ▼
                                                   │                 completed
                                                   └──resume──▶ in_work
```

**Состояние `arrived` введено ADR-009.** Прилёт и закрытие рейса — разные события:
между ними проходят часы, за которые оформляются акты, вносится фактическое время
и выставляется счёт. Без разделения рейс либо закрывается до оформления документов,
либо висит «в полёте» через сутки после посадки, искажая дашборд диспетчера.

Guards:

| Переход | Условие |
|---|---|
| `start` | назначен борт; создана хотя бы одна заявка на услугу |
| `ready` | все заявки в статусе `confirmed` или `completed`; нет заявок в `rejected`; для международного рейса есть подтверждённый пермит (категория `permits`) |
| `depart` | ручной либо автоматический при `nowUtc >= stdUtc`; проставляет `atdUtc` |
| `arrive` | `in_flight → arrived`; `nowUtc >= staUtc` либо вручную; проставляет `ataUtc` |
| `complete` | `arrived → completed`; все заявки `completed` или `cancelled`; выставлен счёт **или** явно выбрано «завершить без счёта» с причиной |
| `cancel` | из `planned`, `in_work`, `ready_for_departure` и `aog`; обязательны код причины и комментарий |
| `aog` | из `in_work` и `ready_for_departure`; обязательна причина. Помечает **рейс**; состояние борта (`Aircraft.status`) — отдельный факт, см. ADR-009 |

Побочные эффекты каждого перехода (реализовать как actions, не как код в компоненте):
запись в аудит, постановка уведомлений в «Исходящие», пересчёт маржи, при `cancel` —
каскадная отмена заявок с постановкой писем об отмене поставщикам.

### 5.2 Заявка на услугу

```
draft ──order──▶ ordered ──confirm──▶ confirmed ──begin──▶ in_progress ──finish──▶ completed
                    │                     │                                          │
                    │reject               │cancel                              создаётся
                    ▼                     ▼                                    payable
                 rejected              cancelled
                    │
                    └──reassign──▶ draft (новая заявка, replacedOrderId = старая)
```

Guards и эффекты:

| Переход | Условие / эффект |
|---|---|
| `order` | пройдены проверки SPEC § 5.2 (1–3 блокирующие); назначен поставщик; зафиксирован снимок цены; ставится `slaConfirmDeadline = nowUtc + slaConfirmMin`; письмо в «Исходящие» |
| `confirm` | до дедлайна — обычное подтверждение; после — `slaBreached = true` и запись в реестр нарушений |
| `reject` | обязательна причина; уведомление диспетчеру; предложение переназначения |
| `finish` | обязательны `actualStartAt` и `actualEndAt`; при `requiresActToComplete` — загруженный документ типа `act`; создаётся `PayableItem` |
| `cancel` | до `in_progress`; письмо поставщику; если услуга уже подтверждена — флаг возможного штрафа за позднюю отмену |

---

## 6. Финансовые сущности

```ts
interface ClientTariffRule extends Entity {
  clientId: Id;
  scope: {                               // чем специфичнее, тем выше приоритет
    serviceId?: Id;                      // приоритет 3
    category?: ServiceCategory;          // приоритет 2
    airportIcao?: IcaoCode;              // модификатор, +1 к приоритету
  };
  pricing:
    | { mode: 'cost_plus'; markupPercent: string }
    | { mode: 'fixed'; price: Money }
    | { mode: 'pass_through' };
  discount?: { kind: 'percent' | 'fixed'; value: string };
  validFrom: IsoUtc;
  validTo: IsoUtc;
}

interface FxSnapshot {
  date: IsoUtc;
  base: CurrencyCode;
  rates: Record<CurrencyCode, string>;   // 1 base = rates[c] единиц c
  policy: 'document_date' | 'order_date' | 'payment_date';   // из настроек
}

interface Quote extends Entity {
  number: string;                        // 'SOC-Q-2026-0042'
  flightId: Id;
  clientId: Id;
  status: 'draft' | 'issued' | 'accepted' | 'declined' | 'expired' | 'voided';
  issuedAt?: IsoUtc;
  validUntil?: IsoUtc;
  currency: CurrencyCode;
  fx: FxSnapshot;
  lines: DocumentLine[];
  fees: DocumentFee[];
  totals: DocumentTotals;
  voidedByDocId?: Id;
}

interface Invoice extends Entity {
  number: string;                        // 'SOC-I-2026-0107'
  flightId: Id;
  clientId: Id;
  quoteId?: Id;
  status: 'draft' | 'issued' | 'sent' | 'partially_paid' | 'paid' | 'overdue' | 'voided';
  issuedAt?: IsoUtc;
  dueDate?: IsoUtc;                      // issuedAt + paymentTerms.deferDays
  currency: CurrencyCode;
  fx: FxSnapshot;
  lines: DocumentLine[];                 // по ФАКТИЧЕСКИ оказанным услугам
  fees: DocumentFee[];
  totals: DocumentTotals;
  voidedByDocId?: Id;
}

interface DocumentLine {
  serviceOrderId: Id;
  description: string;
  airportIcao: IcaoCode;
  quantity: string;
  unitPrice: Money;
  amount: Money;
  vatRateId?: Id;
  vatAmount: Money;
}

interface DocumentFee {
  code: 'handling_fee' | 'commission' | 'transport_fee' | 'other';
  description: string;
  kind: 'percent' | 'fixed';
  value: string;
  amount: Money;
}

interface DocumentTotals {
  subtotal: Money;
  discountTotal: Money;
  feesTotal: Money;
  vatTotal: Money;
  grandTotal: Money;
}

interface PayableItem extends Entity {   // заявка на оплату поставщику
  vendorId: Id;
  serviceOrderIds: Id[];
  amount: Money;
  currency: CurrencyCode;
  dueDate: IsoUtc;                       // completedAt + contract.deferDays
  status: 'pending' | 'approved' | 'scheduled' | 'paid' | 'disputed' | 'cancelled';
  vendorInvoiceId?: Id;
}

interface VendorInvoice extends Entity { // счёт от поставщика для сверки
  vendorId: Id;
  number: string;
  issuedAt: IsoUtc;
  currency: CurrencyCode;
  lines: VendorInvoiceLine[];
  reconciliation?: ReconciliationResult;
}

interface VendorInvoiceLine {
  airportIcao: IcaoCode;
  serviceDate: IsoUtc;
  serviceCode: string;
  quantity: string;
  unitPrice: Money;
  amount: Money;
}

interface ReconciliationResult {
  matched: { lineIndex: number; serviceOrderId: Id }[];
  discrepancies: Discrepancy[];
  totalOurs: Money;
  totalTheirs: Money;
  delta: Money;
  resolvedAt?: IsoUtc;
}

interface Discrepancy {
  kind: 'price_mismatch' | 'quantity_mismatch' | 'missing_on_our_side' | 'missing_on_their_side';
  lineIndex?: number;
  serviceOrderId?: Id;
  ours?: Money;
  theirs?: Money;
  resolution?: 'accept_theirs' | 'keep_ours' | 'claim' | 'investigate';
  comment?: string;
}
```

---

## 7. Формулы

### 7.1 Закупочная стоимость заявки

```
base       = purchasePrice.amount × quantity
surcharges = Σ( kind='percent' ? base × value/100 : value )
cost       = max(base + surcharges, minCharge ?? 0)
```
Округление до 2 знаков один раз, на `cost`.

### 7.2 Цена продажи заявки

Выбор правила: из `ClientTariffRule` клиента, действующих на дату оказания услуги,
отбираются подходящие по `scope`. Приоритет = (3 за `serviceId` | 2 за `category` | 1 за «всё»)
+ 1 если совпал `airportIcao`. Максимальный приоритет выигрывает; при равенстве —
максимальный `validFrom`. Если правил нет — наценка по умолчанию из настроек клиента.

```
cost_plus:     sale = cost × (1 + markupPercent/100)
fixed:         sale = price × quantity
pass_through:  sale = cost
затем:         sale = sale − discount (percent от sale либо fixed)
```

Валюта: `cost` может быть в валюте поставщика, `sale` — всегда в `flight.billingCurrency`,
конвертация по `flight.fxSnapshot` согласно политике.

### 7.3 Маржа рейса `[ТЗ 3.4.3]`

```
revenue = Σ sale(заявки в расчёте) + Σ fees − Σ discounts
cost    = Σ cost(заявки в расчёте)
margin  = revenue − cost
marginPct = revenue = 0 ? null : margin / revenue × 100
```

Состав «заявок в расчёте» зависит от режима:
- `plan` — все, кроме `cancelled` и `rejected`;
- `fact` — только `completed`;
- `mixed` — `completed` по факту + остальные по плану; на экране подписывается,
  какая доля плановая.

Отрицательная маржа не является ошибкой и должна отображаться, а не обнуляться.

### 7.4 Рейтинг поставщика `[ТЗ 3.3.1]`

```
onTimeConfirmRate = подтверждено в срок / всего заявок
slaComplianceRate = выполнено без нарушения SLA / всего выполненных
billingAccuracy   = заявок без расхождений в сверке / всего в сверке
qualityScore      = manualQualityScore / 5

rating = 5 × (0.30·onTimeConfirmRate + 0.30·slaComplianceRate
            + 0.20·billingAccuracy + 0.20·qualityScore)
```

Если заявок меньше 5 — рейтинг не считается, показывается «недостаточно данных».
Веса выносятся в настройки `/admin/sla`.

### 7.5 Подбор поставщика `[ТЗ 3.3.2]`

Кандидаты: активные, со специализацией по категории услуги, с покрытием аэропорта,
с действующим контрактом на дату и действующей ценой.

```
priceScore     = 1 − (cost − minCost) / (maxCost − minCost)     // 1 у самого дешёвого
ratingScore    = rating / 5
proximityScore = база в аэропорту ? 1 : max(0, 1 − distanceKm/200)

total = w_price·priceScore + w_rating·ratingScore + w_prox·proximityScore
```

Пресеты весов: «по цене» (1/0/0), «по рейтингу» (0/1/0), «по близости» (0/0/1),
«сбалансированный» (0.5/0.3/0.2). Таблица сравнения показывает все три составляющие.

### 7.6 SLA

```
slaConfirmDeadline = orderedAt + slaConfirmMin(категория, поставщик)
slaCompletionDeadline = плановое время услуги + slaCompletionMin
breach = фактическое время > дедлайна
penalty = правило SLA: fixed сумма либо percent от стоимости услуги
```
Правила SLA — справочник `/admin/sla`, область действия: категория, конкретный поставщик,
либо значение по умолчанию.

### 7.7 Сверка `[ТЗ 3.4.2]`

Ключ сопоставления: `vendorId + airportIcao + дата (±1 день) + serviceCode`.
Порядок: точное совпадение по ключу и сумме → совпадение по ключу с расхождением суммы
(`price_mismatch` / `quantity_mismatch`) → непарные строки с обеих сторон.
Допуск на округление — 0.01 в валюте документа, в пределах допуска расхождением не считается.

### 7.8 Расстояние и время в пути

Ортодромия по формуле гаверсинуса между координатами аэропортов, результат в морских милях.

```
distanceNm   = haversine(dep, arr) / 1.852
blockTimeMin = distanceNm / cruiseSpeedKts × 60 + 20
fuelPlanKg   = blockTimeMin / 60 × fuelBurnKgPerHour × 1.1
staUtc       = stdUtc + blockTimeMin
```
Ветер, эшелоны, запасные аэродромы и профиль полёта не учитываются: расчёт плановый
и оценочный, рядом с ним в интерфейсе стоит соответствующая пометка. Точный расчёт
требует данных производителя ВС и планировщика маршрутов — зафиксировано в `GAPS.md`.

---

## 8. Аудит

```ts
interface AuditEntry {
  id: Id;
  ts: IsoUtc;                            // реальное время действия
  actorId: Id;
  actorName: string;
  actorRole: Role;
  source: 'user' | 'seed' | 'system';    // system — автопереходы по таймеру
  entityType: 'flight' | 'service_order' | 'vendor' | 'contract' | 'tariff'
            | 'quote' | 'invoice' | 'payable' | 'reconciliation' | 'user' | 'settings';
  entityId: Id;
  action: string;                        // 'status_changed', 'vendor_assigned', ...
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  comment?: string;
}
```

Записи неизменяемы: слайс аудита имеет только `append`. Diff «было/стало» считается
на отображении, а не хранится готовым текстом. Записи `source: 'seed'` в интерфейсе
помечены отдельным тегом и автором `System (демо-генератор)`.

---

## 9. Уведомления и исходящие

```ts
interface Notification extends Entity {
  userId: Id;
  kind: 'flight_status' | 'service_confirmed' | 'service_rejected' | 'deadline'
      | 'sla_breach' | 'contract_expiry' | 'payment_overdue' | 'low_margin';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  link: string;
  readAt?: IsoUtc;
}

interface OutboxMessage extends Entity {
  channel: 'email' | 'max' | 'portal';
  to: { name: string; address: string; locale: Locale }[];
  templateCode: string;
  subject: string;
  body: string;                          // отрендеренный, с подставленными данными
  attachments: AttachmentRef[];
  relatedTo: { entityType: string; entityId: Id };
  status: 'queued' | 'sent_simulated' | 'failed_simulated';
  sentAt?: IsoUtc;
}
```

Идемпотентность: у сообщения есть `dedupeKey` (например, `contract_expiry:ctr_123:30`),
повторная постановка с тем же ключом игнорируется.

---

## 10. Пользователи и роли

```ts
type Role = 'admin' | 'dispatcher' | 'finance' | 'manager' | 'client' | 'vendor';

interface User extends Entity {
  name: string;
  email: string;
  role: Role;
  clientId?: Id;                         // обязателен для role='client'
  vendorId?: Id;                         // обязателен для role='vendor'
  locale: Locale;
  timezoneMode: 'utc' | 'airport_local' | 'user_local';
  timezone: string;                      // IANA
  isActive: boolean;
}
```

Изоляция данных выполняется на сервере, в `get_queryset()`: для роли `client` выборка
фильтруется по `client_id` пользователя, для `vendor` — по `vendor_id`. Обращение
к чужой записи даёт 404, а не 403: факт существования чужой записи не раскрывается.
Подробности — `BACKEND.md § 3.7`.

---

## 11. Настройки системы

Единый объект `Settings`, редактируется администратором, влияет на расчёты:

```ts
interface Settings {
  lowMarginThresholdPercent: string;     // порог предупреждения, по умолчанию '12'
  defaultMarkupPercent: string;          // '15'
  documentNumberMasks: { quote: string; invoice: string; payable: string };
  fxPolicy: 'document_date' | 'order_date' | 'payment_date';
  slaWeights: { onTimeConfirm: string; slaCompliance: string; billing: string; quality: string };
  vendorSuggestWeights: { price: string; rating: string; proximity: string };
  contractExpiryReminders: number[];     // [30, 15, 7]
  mockLatencyMs: { min: number; max: number };
  demoTimeScale: 1 | 60 | 600;
  autoConfirmVendorPercent: number;      // доля заявок, подтверждаемых демо-генератором
}
```
