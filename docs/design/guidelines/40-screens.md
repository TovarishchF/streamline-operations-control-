# Screen recipes

How the components combine on the screens the customer sees most. Every screen starts with `PageHeader` and sits in the `AppShell` content area unless stated otherwise.

## Dispatcher dashboard

Greeting in `display` (`Доброе утро, Илья`) with the date and shift in the meta line; actions `Суточный план` (secondary) and `Создать рейс` (primary). Then a row of four `KpiTile`s: flights in work (with sparkline), revenue month to date with margin, unconfirmed requests (warning when any is within 2h of its SLA), aircraft out of service (critical when above zero). Then two columns at 1.35 : 1: `Ближайшие вылеты` as up to six `FlightStrip`s, and `Требует внимания` as a list where each row is a status pill, a two-line description and one small action button. The SLA breach register follows as a `DataTable` card when it is not empty.

## Day plan

Header meta shows the plan date, the conflict count as a critical pill and the last update time. Actions: view toggle (`Планшет` / `Таблица`) as a segmented control, date picker, `Создать рейс`. Under the header, a critical `Banner` when conflicts exist, listing up to four with a `Разобрать` button. Filters in one row on `surface`: search, status, client, airport, two toggle chips (`Есть неподтверждённые услуги`, `Маржа ниже порога`). Then the `GanttBoard` and its legend. The day / three days / week scale is a segmented control above the board's right edge.

## Flight card

Header: `SLG-1126` in `page-title` set in the mono family at the same size, then the `StatusPill`, then the route with the arc glyph and ETD/ETA in the meta line. Actions are the allowed state transitions from `flight.json` as buttons (the next normal transition primary, the rest secondary, cancellation as danger). Tabs: Сводка, Услуги, Финансы, Документы, История. Сводка is a two-column layout: left a `FlightStrip`-style leg summary and crew/passengers, right a card with client, aircraft, and the margin block. Услуги is a `DataTable` with a service-order pill per row and the vendor's SLA deadline as a time with zone.

## Lists (requests, invoices, vendors, clients, contracts)

`PageHeader` with the count in the meta line and the primary create action. A filter row inside the table card's header. `DataTable` with the identifier column first (mono, link colour), the status pill second or last, money right-aligned, dates with zone. Bulk actions appear in the table card header when rows are selected, replacing the filters.

## Client portal

The same palette on `portalTheme` (15/24, 40px controls). No rail: a top bar on `surface` with the colour logo, the client's company name and the avatar. Content max width 1120px, centred. The client sees their trips as `FlightStrip`s and their documents as a simple table. No internal statuses: the portal maps them to three words (`Запрошен`, `Подтверждён`, `Выполнен`) using `progress`, `ready` and `done`.

## Login

`LoginScreen` card. On screens below 900px the brand panel collapses to a 160px band at the top with the logo and no headline.
