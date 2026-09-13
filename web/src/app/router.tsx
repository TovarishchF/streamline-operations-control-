import type { JSX } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AppLayout } from './layout/AppLayout';
import { PortalLayout } from './layout/PortalLayout';
import { useSession, isPortalRole } from '@/shared/auth/session';
import { HOME_BY_ROLE } from './layout/navigation';

import { LoginPage } from '@/modules/auth/LoginPage';
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
import { OutboxPage, InboxPage, MessageTemplatesPage } from '@/modules/comms/CommsPages';
import { ReportsPage, ReportViewPage } from '@/modules/reports/ReportsPages';
import { DispatcherDashboard } from '@/modules/dashboards/DispatcherDashboard';
import { ManagerDashboard } from '@/modules/dashboards/ManagerDashboard';
import { ClientFlightsPage, ClientDocumentsPage, ClientRequestPage } from '@/modules/portals/ClientPortal';
import { VendorOrdersPage, VendorPerformancePage, VendorPayablesPage } from '@/modules/portals/VendorPortal';
import { UsersPage, SlaPage, DemoDataPage, ApiDocsPage } from '@/modules/admin/AdminPages';
import { AuditPage } from '@/modules/admin/AuditPage';
import { IntegrationsPage } from '@/modules/admin/IntegrationsPage';
import { PerformancePage } from '@/modules/admin/PerformancePage';
import { NotFoundPage } from '@/modules/misc/NotFoundPage';

/** Редирект на стартовый экран роли: у каждой роли он свой (`SPEC.md § 3`). */
function RoleHome(): JSX.Element {
  const role = useSession((s) => s.user.role);
  return <Navigate to={HOME_BY_ROLE[role] ?? '/schedule'} replace />;
}

export function AppRoutes(): JSX.Element {
  const role = useSession((s) => s.user.role);
  const portal = isPortalRole(role);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

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
