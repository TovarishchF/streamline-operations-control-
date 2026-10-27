import { lazy, useEffect, type JSX } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Spin } from 'antd';

import { AppLayout } from './layout/AppLayout';
import { PortalLayout } from './layout/PortalLayout';
import {
  isPortalRole,
  useCurrentUser,
  useSession,
  useTwoFactorSetupRequired,
} from '@/shared/auth/session';
import { HOME_BY_ROLE } from './layout/navigation';
import { startPerformanceReporting, useNavigationTracker } from '@/shared/perf/measure';

import { RegistrationConfirmPage } from '@/modules/auth/RegistrationConfirmPage';
import { LoginPage } from '@/modules/auth/LoginPage';
import { TwoFactorSetupPage } from '@/modules/auth/TwoFactorSetupPage';
import { NotFoundPage } from '@/modules/misc/NotFoundPage';

// Экран загружается при первом открытии, а не вместе с приложением:
// карточке рейса не нужны планшет, графики и отчёты, а в одном пакете они
// удлиняли первую загрузку, по которой меряется норматив ТЗ 4.4 (ADR-017).
const RegistrationQueuePage = lazy(() => import('@/modules/admin/RegistrationQueuePage').then((m) => ({ default: m.RegistrationQueuePage })));
const SchedulePage = lazy(() => import('@/modules/schedule/SchedulePage').then((m) => ({ default: m.SchedulePage })));
const FlightTemplatesPage = lazy(() => import('@/modules/schedule/FlightTemplatesPage').then((m) => ({ default: m.FlightTemplatesPage })));
const FlightCardPage = lazy(() => import('@/modules/flights/FlightCardPage').then((m) => ({ default: m.FlightCardPage })));
const FlightCreatePage = lazy(() => import('@/modules/flights/FlightCreatePage').then((m) => ({ default: m.FlightCreatePage })));
const RequestsPage = lazy(() => import('@/modules/requests/RequestsPage').then((m) => ({ default: m.RequestsPage })));
const SlotsPage = lazy(() => import('@/modules/slots/SlotsPage').then((m) => ({ default: m.SlotsPage })));
const ServicesCatalogPage = lazy(() => import('@/modules/catalog/CatalogPages').then((m) => ({ default: m.ServicesCatalogPage })));
const VendorPricesPage = lazy(() => import('@/modules/catalog/CatalogPages').then((m) => ({ default: m.VendorPricesPage })));
const VendorsPage = lazy(() => import('@/modules/vendors/VendorsPage').then((m) => ({ default: m.VendorsPage })));
const VendorCardPage = lazy(() => import('@/modules/vendors/VendorCardPage').then((m) => ({ default: m.VendorCardPage })));
const ContractsPage = lazy(() => import('@/modules/contracts/ContractsPage').then((m) => ({ default: m.ContractsPage })));
const ClientsPage = lazy(() => import('@/modules/clients/ClientsPage').then((m) => ({ default: m.ClientsPage })));
const ClientCardPage = lazy(() => import('@/modules/clients/ClientCardPage').then((m) => ({ default: m.ClientCardPage })));
const FleetPage = lazy(() => import('@/modules/fleet/FleetPage').then((m) => ({ default: m.FleetPage })));
const AirportsPage = lazy(() => import('@/modules/airports/AirportsPage').then((m) => ({ default: m.AirportsPage })));
const QuotesPage = lazy(() => import('@/modules/billing/DocumentsPages').then((m) => ({ default: m.QuotesPage })));
const InvoicesPage = lazy(() => import('@/modules/billing/DocumentsPages').then((m) => ({ default: m.InvoicesPage })));
const DocumentCardPage = lazy(() => import('@/modules/billing/DocumentCardPage').then((m) => ({ default: m.DocumentCardPage })));
const PayablesPage = lazy(() => import('@/modules/billing/PayablesPage').then((m) => ({ default: m.PayablesPage })));
const ReconciliationPage = lazy(() => import('@/modules/billing/ReconciliationPage').then((m) => ({ default: m.ReconciliationPage })));
const FxPage = lazy(() => import('@/modules/billing/FxPage').then((m) => ({ default: m.FxPage })));
const OutboxPage = lazy(() => import('@/modules/comms/CommsPages').then((m) => ({ default: m.OutboxPage })));
const InboxPage = lazy(() => import('@/modules/comms/CommsPages').then((m) => ({ default: m.InboxPage })));
const MessageTemplatesPage = lazy(() => import('@/modules/comms/MessageTemplatesPage').then((m) => ({ default: m.MessageTemplatesPage })));
const ReportsPage = lazy(() => import('@/modules/reports/ReportsPages').then((m) => ({ default: m.ReportsPage })));
const ReportViewPage = lazy(() => import('@/modules/reports/ReportsPages').then((m) => ({ default: m.ReportViewPage })));
const DispatcherDashboard = lazy(() => import('@/modules/dashboards/DispatcherDashboard').then((m) => ({ default: m.DispatcherDashboard })));
const ManagerDashboard = lazy(() => import('@/modules/dashboards/ManagerDashboard').then((m) => ({ default: m.ManagerDashboard })));
const ClientFlightsPage = lazy(() => import('@/modules/portals/ClientPortal').then((m) => ({ default: m.ClientFlightsPage })));
const ClientDocumentsPage = lazy(() => import('@/modules/portals/ClientPortal').then((m) => ({ default: m.ClientDocumentsPage })));
const ClientRequestPage = lazy(() => import('@/modules/portals/ClientPortal').then((m) => ({ default: m.ClientRequestPage })));
const VendorOrdersPage = lazy(() => import('@/modules/portals/VendorOrdersPage').then((m) => ({ default: m.VendorOrdersPage })));
const VendorPerformancePage = lazy(() => import('@/modules/portals/VendorPortal').then((m) => ({ default: m.VendorPerformancePage })));
const VendorPayablesPage = lazy(() => import('@/modules/portals/VendorPortal').then((m) => ({ default: m.VendorPayablesPage })));
const UsersPage = lazy(() => import('@/modules/admin/AdminPages').then((m) => ({ default: m.UsersPage })));
const SampleDataPage = lazy(() => import('@/modules/admin/AdminPages').then((m) => ({ default: m.SampleDataPage })));
const ApiDocsPage = lazy(() => import('@/modules/admin/AdminPages').then((m) => ({ default: m.ApiDocsPage })));
const SlaPage = lazy(() => import('@/modules/admin/SlaPage').then((m) => ({ default: m.SlaPage })));
const AuditPage = lazy(() => import('@/modules/admin/AuditPage').then((m) => ({ default: m.AuditPage })));
const IntegrationsPage = lazy(() => import('@/modules/admin/IntegrationsPage').then((m) => ({ default: m.IntegrationsPage })));
const PerformancePage = lazy(() => import('@/modules/admin/PerformancePage').then((m) => ({ default: m.PerformancePage })));

/** Редирект на стартовый экран роли: у каждой роли он свой (`SPEC.md § 3`). */
function RoleHome(): JSX.Element {
  const role = useCurrentUser()?.role;
  return <Navigate to={(role && HOME_BY_ROLE[role]) ?? '/schedule'} replace />;
}

/**
 * Маршруты доступны только после входа `[ТЗ 4.3]`.
 *
 * Обход аутентификации запрещён (ADR-013): неаутентифицированный
 * пользователь видит только экран входа. Это видимость, а не разграничение —
 * данные закрыты на сервере, — но показывать пустые экраны без объяснения
 * тоже неправильно.
 */
export function AppRoutes(): JSX.Element {
  const status = useSession((s) => s.status);
  const hasStoredToken = useSession((s) => s.refreshToken !== null);
  const restore = useSession((s) => s.restore);
  const role = useCurrentUser()?.role;
  const twoFactorSetupRequired = useTwoFactorSetupRequired();

  useEffect(() => {
    // Сохранился только refresh (ADR-034): при загрузке страницы по нему
    // восстанавливается сессия, иначе пользователь входил бы заново
    // после каждого обновления вкладки.
    void restore();
  }, [restore]);

  useNavigationTracker();
  useEffect(() => {
    // Замеры уходят на сервер от имени пользователя (ADR-017): до входа
    // отправлять их некуда.
    if (status === 'authenticated') startPerformanceReporting();
  }, [status]);

  // Пока сессия восстанавливается — ждём. Уйти на экран входа в этот момент
  // значит потерять адрес, который открывал пользователь: после входа он
  // оказался бы на домашнем экране вместо нужного.
  if (status === 'restoring' || (status === 'anonymous' && hasStoredToken)) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (status !== 'authenticated') {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register/confirm" element={<RegistrationConfirmPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // Политика требует второй фактор, а приложение не привязано: до привязки
  // не показывается ничего другого.
  if (twoFactorSetupRequired) {
    return (
      <Routes>
        <Route path="*" element={<TwoFactorSetupPage />} />
      </Routes>
    );
  }

  const portal = role ? isPortalRole(role) : false;

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />

      {portal ? (
        <Route element={<PortalLayout />}>
          <Route path="/" element={<RoleHome />} />
          <Route path="/portal/client/flights" element={<ClientFlightsPage />} />
          <Route path="/portal/client/flights/:id" element={<ClientFlightsPage />} />
          <Route path="/portal/client/request" element={<ClientRequestPage />} />
          <Route path="/portal/client/documents" element={<ClientDocumentsPage />} />
          <Route path="/portal/vendor/orders" element={<VendorOrdersPage />} />
          <Route path="/portal/vendor/performance" element={<VendorPerformancePage />} />
          <Route path="/portal/vendor/payables" element={<VendorPayablesPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      ) : (
        <Route element={<AppLayout />}>
          <Route path="/" element={<RoleHome />} />

          <Route path="/schedule" element={<SchedulePage />} />
          <Route path="/schedule/templates" element={<FlightTemplatesPage />} />
          <Route path="/flights/new" element={<FlightCreatePage />} />
          <Route path="/flights/:id" element={<FlightCardPage />} />
          <Route path="/flights/:id/:tab" element={<FlightCardPage />} />
          <Route path="/requests" element={<RequestsPage />} />
          <Route path="/slots" element={<SlotsPage />} />

          <Route path="/catalog/services" element={<ServicesCatalogPage />} />
          <Route path="/catalog/prices" element={<VendorPricesPage />} />
          <Route path="/vendors" element={<VendorsPage />} />
          <Route path="/vendors/:id" element={<VendorCardPage />} />
          <Route path="/contracts" element={<ContractsPage />} />
          <Route path="/clients" element={<ClientsPage />} />
          <Route path="/clients/:id" element={<ClientCardPage />} />
          <Route path="/fleet" element={<FleetPage />} />
          <Route path="/airports" element={<AirportsPage />} />

          <Route path="/billing/quotes" element={<QuotesPage />} />
          <Route path="/billing/quotes/:id" element={<DocumentCardPage kind="quote" />} />
          <Route path="/billing/invoices" element={<InvoicesPage />} />
          <Route path="/billing/invoices/:id" element={<DocumentCardPage kind="invoice" />} />
          <Route path="/billing/payables" element={<PayablesPage />} />
          <Route path="/billing/reconciliation" element={<ReconciliationPage />} />
          <Route path="/billing/reconciliation/:id" element={<ReconciliationPage />} />
          <Route path="/billing/fx" element={<FxPage />} />

          <Route path="/communications/outbox" element={<OutboxPage />} />
          <Route path="/communications/inbox" element={<InboxPage />} />
          <Route path="/communications/templates" element={<MessageTemplatesPage />} />

          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/reports/:code" element={<ReportViewPage />} />
          <Route path="/dashboards/dispatcher" element={<DispatcherDashboard />} />
          <Route path="/dashboards/manager" element={<ManagerDashboard />} />

          <Route path="/admin/users" element={<UsersPage />} />
          <Route path="/admin/registrations" element={<RegistrationQueuePage />} />
          <Route path="/admin/audit" element={<AuditPage />} />
          <Route path="/admin/integrations" element={<IntegrationsPage />} />
          <Route path="/admin/sla" element={<SlaPage />} />
          <Route path="/admin/performance" element={<PerformancePage />} />
          <Route path="/admin/sample-data" element={<SampleDataPage />} />
          <Route path="/api-docs" element={<ApiDocsPage />} />

          <Route path="*" element={<NotFoundPage />} />
        </Route>
      )}
    </Routes>
  );
}
