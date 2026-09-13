/**
 * Удобные псевдонимы типов контракта.
 *
 * `shared/api-types.ts` генерируется из `openapi.yaml` командой `make api-types`
 * и руками не правится (`CLAUDE.md § 3` п. 6). Обращаться к нему напрямую через
 * `components['schemas']['Flight']` неудобно, поэтому здесь — только псевдонимы.
 * Ни одного собственного описания формы данных в этом файле быть не должно:
 * появление такого описания означает, что контракт обошли.
 */
import type { components } from '@shared/api-types';

type S = components['schemas'];

// Общие
export type Money = S['Money'];
export type DecimalString = S['DecimalString'];
export type CurrencyCode = S['CurrencyCode'];
export type LocalizedName = S['LocalizedName'];
export type IcaoCode = S['IcaoCode'];
export type DataSource = S['DataSource'];
export type ErrorCode = S['ErrorCode'];

// Пользователи и права
export type Role = S['Role'];
export type User = S['User'];
export type MeResponse = S['MeResponse'];

// Справочники
export type Airport = S['Airport'];
export type AircraftType = S['AircraftType'];
export type Aircraft = S['Aircraft'];
export type AircraftStatus = S['AircraftStatus'];
export type AircraftApproval = S['AircraftApproval'];
export type CrewMember = S['CrewMember'];
export type ServiceCategory = S['ServiceCategory'];
export type ServiceCatalogItem = S['ServiceCatalogItem'];
export type VatRate = S['VatRate'];
export type Surcharge = S['Surcharge'];
export type VendorPrice = S['VendorPrice'];

// Контрагенты
export type Client = S['Client'];
export type Vendor = S['Vendor'];
export type VendorRating = S['VendorRating'];
export type VendorCandidate = S['VendorCandidate'];
export type VendorContract = S['VendorContract'];
export type ContractStatus = S['ContractStatus'];
export type PaymentTerms = S['PaymentTerms'];
export type Contact = S['Contact'];
export type TariffRule = S['TariffRule'];
export type TariffSimulateResult = S['TariffSimulateResult'];

// Рейсы
export type Flight = S['Flight'];
export type FlightListItem = S['FlightListItem'];
export type FlightStatus = S['FlightStatus'];
export type FlightTransition = S['FlightTransition'];
export type FlightType = S['FlightType'];
export type FlightTemplate = S['FlightTemplate'];
export type FlightRequest = S['FlightRequest'];
export type ScheduleConflict = S['ScheduleConflict'];
export type Slot = S['Slot'];

// Заявки на услуги
export type ServiceOrder = S['ServiceOrder'];
export type ServiceOrderStatus = S['ServiceOrderStatus'];
export type ServiceOrderTransition = S['ServiceOrderTransition'];
export type ServiceLeg = S['ServiceLeg'];
export type ServiceCheckResult = S['ServiceCheckResult'];
export type AttachmentRef = S['AttachmentRef'];

// Биллинг
export type FxSnapshot = S['FxSnapshot'];
export type Quote = S['Quote'];
export type QuoteStatus = S['QuoteStatus'];
export type Invoice = S['Invoice'];
export type InvoiceStatus = S['InvoiceStatus'];
export type DocumentLine = S['DocumentLine'];
export type DocumentFee = S['DocumentFee'];
export type DocumentTotals = S['DocumentTotals'];
export type Payment = S['Payment'];
export type PayableItem = S['PayableItem'];
export type PayableStatus = S['PayableStatus'];
export type VendorInvoice = S['VendorInvoice'];
export type VendorInvoiceLine = S['VendorInvoiceLine'];
export type Discrepancy = S['Discrepancy'];
export type ReconciliationResult = S['ReconciliationResult'];
export type MarginResult = S['MarginResult'];
export type MarginMode = S['MarginMode'];

// Коммуникации
export type Notification = S['Notification'];
export type NotificationKind = S['NotificationKind'];
export type OutboxMessage = S['OutboxMessage'];
export type OutboxStatus = S['OutboxStatus'];
export type InboxMessage = S['InboxMessage'];
export type MessageTemplate = S['MessageTemplate'];
export type MessageChannel = S['MessageChannel'];

// Отчётность
export type ReportCode = S['ReportCode'];
export type ReportDefinition = S['ReportDefinition'];
export type ReportResult = S['ReportResult'];
export type DashboardLayout = S['DashboardLayout'];

// Порталы
export type ClientPortalFlight = S['ClientPortalFlight'];
export type ClientPortalDocument = S['ClientPortalDocument'];
export type VendorPortalOrder = S['VendorPortalOrder'];

// Администрирование
export type AuditEntry = S['AuditEntry'];
export type AuditEntityType = S['AuditEntityType'];
export type Settings = S['Settings'];
export type SlaRule = S['SlaRule'];
export type IntegrationCode = S['IntegrationCode'];
export type IntegrationMode = S['IntegrationMode'];
export type IntegrationStatus = S['IntegrationStatus'];
export type IntegrationLogEntry = S['IntegrationLogEntry'];
export type PerformanceReport = S['PerformanceReport'];
