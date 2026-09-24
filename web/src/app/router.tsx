import { useEffect, type JSX } from 'react';
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

import { RegistrationConfirmPage } from '@/modules/auth/RegistrationConfirmPage';
import { RegistrationQueuePage } from '@/modules/admin/RegistrationQueuePage';
import { LoginPage } from '@/modules/auth/LoginPage';
import { TwoFactorSetupPage } from '@/modules/auth/TwoFactorSetupPage';
import { SchedulePage } from '@/modules/schedule/SchedulePage';
import { FlightTemplatesPage } from '@/modules/schedule/FlightTemplatesPage';
import { FlightCardPage } from '@/modules/flights/FlightCardPage';
import { FlightCreatePage } from '@/modules/flights/FlightCreatePage';
import { RequestsPage } from '@/modules/requests/RequestsPage';
import { SlotsPage } from '@/modules/slots/SlotsPage';
import { ServicesCatalogPage, VendorPricesPage } from '@/modules/catalog/CatalogPages';
import { VendorsPage } from '@/modules/vendors/VendorsPage';
import { VendorCardPage } from '@/modules/vendors/VendorCardPage';
import { ContractsPage } from '@/modules/contracts/ContractsPage';
import { ClientsPage } from '@/modules/clients/ClientsPage';
import { ClientCardPage } from '@/modules/clients/ClientCardPage';
import { FleetPage } from '@/modules/fleet/FleetPage';
import { AirportsPage } from '@/modules/airports/AirportsPage';
import { QuotesPage, InvoicesPage } from '@/modules/billing/DocumentsPages';
import { DocumentCardPage } from '@/modules/billing/DocumentCardPage';
import { PayablesPage } from '@/modules/billing/PayablesPage';
import { ReconciliationPage } from '@/modules/billing/ReconciliationPage';
import { FxPage } from '@/modules/billing/FxPage';
import { OutboxPage, InboxPage } from '@/modules/comms/CommsPages';
import { MessageTemplatesPage } from '@/modules/comms/MessageTemplatesPage';
import { ReportsPage, ReportViewPage } from '@/modules/reports/ReportsPages';
import { DispatcherDashboard } from '@/modules/dashboards/DispatcherDashboard';
import { ManagerDashboard } from '@/modules/dashboards/ManagerDashboard';
import { ClientFlightsPage, ClientDocumentsPage, ClientRequestPage } from '@/modules/portals/ClientPortal';
import { VendorOrdersPage } from '@/modules/portals/VendorOrdersPage';
import { VendorPerformancePage, VendorPayablesPage } from '@/modules/portals/VendorPortal';
import { UsersPage, SlaPage, DemoDataPage, ApiDocsPage } from '@/modules/admin/AdminPages';
import { AuditPage } from '@/modules/admin/AuditPage';
import { IntegrationsPage } from '@/modules/admin/IntegrationsPage';
import { PerformancePage } from '@/modules/admin/PerformancePage';
import { NotFoundPage } from '@/modules/misc/NotFoundPage';

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
          <Route path="/admin/demo-data" element={<DemoDataPage />} />
          <Route path="/api-docs" element={<ApiDocsPage />} />

          <Route path="*" element={<NotFoundPage />} />
        </Route>
      )}
    </Routes>
  );
}
