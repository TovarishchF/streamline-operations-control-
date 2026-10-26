import { useMemo, type JSX, type ReactNode } from 'react';
import { Button, Card, Progress, Space } from 'antd';
import { PlusOutlined, ScheduleOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { DataTable } from '@/shared/ui/DataTable';

import type { ServiceOrder } from '@/api/types';
import { CONFLICTS, FLIGHT_LIST, SERVICE_ORDERS } from '@/mocks/flights';
import { AIRCRAFT, AIRCRAFT_BY_ID, AIRCRAFT_TYPE_BY_ID } from '@/mocks/reference';
import { Can } from '@/shared/auth/Can';
import { useCurrentUser } from '@/shared/auth/session';
import { useClock, formatUtc } from '@/shared/clock/useClock';
import { FlightStrip } from '@/shared/ui/FlightStrip';
import { KpiTile } from '@/shared/ui/KpiTile';
import { PageHeader } from '@/shared/ui/PageHeader';
import { EmptyState, FlightStatusTag, Mono, StatusPill, UtcTime } from '@/shared/ui/primitives';
import { FLIGHT_STATUS_TOKENS, STATUS_TOKENS, type StatusToken } from '@/shared/ui/status-tokens';

/** Заявка без подтверждения, до дедлайна SLA которой меньше двух часов. */
const SLA_SOON_MS = 2 * 3_600_000;

interface AttentionItem {
  key: string;
  token: StatusToken;
  tag: string;
  title: ReactNode;
  note: ReactNode;
  action: { label: string; path: string };
}

/**
 * Дашборд диспетчера `[ТЗ 3.6.2]`.
 *
 * Состав виджетов — `SPEC.md § 9.2`: рейсы сегодня по статусам, ближайшие
 * вылеты с обратным отсчётом, неподтверждённые заявки с просроченным
 * лидтаймом, нарушения SLA за сутки, борта в AOG, конфликты расписания.
 *
 * Компоновка — макет `docs/design/mockups/screens/02-dashboard-dispatcher.html`
 * без приветствия: заголовок, дата и действия, четыре плитки, ближайшие вылеты
 * полосами и список «Требует внимания», где у каждой строки одно действие.
 */
export function DispatcherDashboard(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { nowUtc } = useClock();
  const user = useCurrentUser();
  const now = nowUtc;
  const timeZone = user?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const locale = i18n.language.startsWith('en') ? 'en-GB' : 'ru-RU';

  const todayFlights = useMemo(
    () =>
      FLIGHT_LIST.filter((flight) => {
        const std = new Date(flight.stdUtc);
        return Math.abs(std.getTime() - now.getTime()) < 36 * 3_600_000;
      }),
    [now],
  );

  const byStatus = useMemo(() => {
    const counts = new Map<string, number>();
    for (const flight of todayFlights) {
      counts.set(flight.status, (counts.get(flight.status) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [todayFlights]);

  const future = useMemo(
    () =>
      FLIGHT_LIST.filter((f) => new Date(f.stdUtc).getTime() > now.getTime()).sort((a, b) =>
        a.stdUtc.localeCompare(b.stdUtc),
      ),
    [now],
  );
  const upcoming = future.slice(0, 6);

  const slaBreaches = SERVICE_ORDERS.filter((o) => o.slaBreached);
  const unconfirmed = SERVICE_ORDERS.filter((o) => o.status === 'ordered');
  const unconfirmedSoon = unconfirmed.some(
    (o) =>
      typeof o.slaConfirmDeadline === 'string' &&
      new Date(o.slaConfirmDeadline).getTime() - now.getTime() < SLA_SOON_MS,
  );
  const outOfService = AIRCRAFT.filter((a) => a.status !== 'serviceable');

  const flightNumber = (id: string): string => FLIGHT_LIST.find((f) => f.id === id)?.number ?? id;

  const attention: AttentionItem[] = [
    ...outOfService.map<AttentionItem>((aircraft) => ({
      key: `ac:${aircraft.id}`,
      token: aircraft.status === 'aog' ? 'critical' : 'warning',
      tag: aircraft.status === 'aog' ? 'AOG' : t(`aircraftStatus.${aircraft.status}`),
      title: <span className="soc-code">{aircraft.registration}</span>,
      note: aircraft.notes ?? '',
      action: { label: t('dashboard.openFleet'), path: '/fleet' },
    })),
    ...slaBreaches.map<AttentionItem>((order) => ({
      key: `sla:${order.id}`,
      token: 'critical',
      tag: 'SLA',
      title: order.service?.name[i18n.language.startsWith('en') ? 'en' : 'ru'] ?? order.serviceId,
      note: (
        <>
          {order.vendorName} · {t('dashboard.deadline')}{' '}
          {order.slaConfirmDeadline ? formatUtc(new Date(order.slaConfirmDeadline)) : '—'}
        </>
      ),
      action: { label: t('dashboard.openServices'), path: `/flights/${order.flightId}/services` },
    })),
    ...CONFLICTS.map<AttentionItem>((conflict, index) => ({
      key: `cf:${conflict.flightId}:${String(index)}`,
      token: conflict.severity === 'blocking' ? 'critical' : 'warning',
      tag: t(`conflictKind.${conflict.kind}`),
      title: <span className="soc-code">{flightNumber(conflict.flightId)}</span>,
      note: conflict.message,
      action: { label: t('dashboard.resolve'), path: `/flights/${conflict.flightId}` },
    })),
  ].sort((a, b) => Number(b.token === 'critical') - Number(a.token === 'critical'));

  const date = new Intl.DateTimeFormat(locale, {
    timeZone, weekday: 'long', day: 'numeric', month: 'long',
  }).format(now);

  return (
    <>
      <PageHeader
        title={t('nav.dashboardDispatcher')}
        meta={<span>{date.charAt(0).toLocaleUpperCase(locale) + date.slice(1)}</span>}
        actions={
          <>
            <Button
              icon={<ScheduleOutlined />}
              onClick={() => {
                navigate('/schedule');
              }}
            >
              {t('nav.schedule')}
            </Button>
            <Can permission="flight.create">
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => {
                  navigate('/flights/new');
                }}
              >
                {t('schedule.newFlight')}
              </Button>
            </Can>
          </>
        }
      />

      <div className="soc-kpi-grid">
        <KpiTile
          label={t('dashboard.flightsToday')}
          value={todayFlights.length}
          footnote={t('dashboard.flightsWindow')}
        />
        <KpiTile
          label={t('dashboard.unconfirmed')}
          value={unconfirmed.length}
          tone={unconfirmed.length > 0 ? 'warning' : 'default'}
          extra={
            unconfirmedSoon ? (
              <StatusPill token="warning" label={t('dashboard.slaSoon')} size="sm" />
            ) : null
          }
          footnote={t('dashboard.ofOrders', { count: SERVICE_ORDERS.length })}
        />
        <KpiTile
          label={t('dashboard.slaBreaches')}
          value={slaBreaches.length}
          tone={slaBreaches.length > 0 ? 'critical' : 'default'}
          footnote={slaBreaches.length > 0 ? t('dashboard.slaBreachesHint') : t('dashboard.noSlaBreaches')}
        />
        <KpiTile
          label={t('dashboard.aogAircraft')}
          value={outOfService.length}
          tone={outOfService.length > 0 ? 'critical' : 'default'}
          footnote={
            outOfService[0] ? (
              <>
                <span className="soc-code">{outOfService[0].registration}</span>
                <span>· {t(`aircraftStatus.${outOfService[0].status}`)}</span>
              </>
            ) : (
              t('dashboard.allServiceable')
            )
          }
        />
      </div>

      <div className="soc-dash-cols">
        <Card
          title={t('dashboard.upcoming')}
          extra={
            future.length > 0 ? (
              <Link to="/schedule">{t('dashboard.allUpcoming', { count: future.length })}</Link>
            ) : null
          }
        >
          {upcoming.length === 0 ? (
            <EmptyState description={t('dashboard.noUpcoming')} />
          ) : (
            upcoming.map((flight) => {
              const aircraft = flight.aircraftId ? AIRCRAFT_BY_ID.get(flight.aircraftId) : undefined;
              const type = aircraft ? AIRCRAFT_TYPE_BY_ID.get(aircraft.typeId) : undefined;
              return (
                <FlightStrip
                  key={flight.id}
                  flightId={flight.id}
                  flightNo={flight.number}
                  tail={flight.aircraftRegistration ?? null}
                  typeCode={type?.icaoType ?? null}
                  dep={{ icao: flight.depIcao, etd: flight.stdUtc }}
                  arr={{ icao: flight.arrIcao, eta: flight.staUtc }}
                  status={{
                    token: FLIGHT_STATUS_TOKENS[flight.status] ?? 'neutral',
                    label: t(`flightStatus.${flight.status}`),
                  }}
                  minutesToEtd={Math.floor(
                    (new Date(flight.stdUtc).getTime() - now.getTime()) / 60_000,
                  )}
                />
              );
            })
          )}
        </Card>

        <Card
          title={t('dashboard.attention')}
          extra={
            attention.length > 0 ? (
              <StatusPill
                token={attention.some((item) => item.token === 'critical') ? 'critical' : 'warning'}
                label={String(attention.length)}
                size="sm"
              />
            ) : null
          }
          styles={{ body: { padding: 0 } }}
        >
          {attention.length === 0 ? (
            <EmptyState description={t('dashboard.noAttention')} />
          ) : (
            <ul className="soc-attention">
              {attention.map((item) => (
                <li key={item.key}>
                  <StatusPill token={item.token} label={item.tag} size="sm" />
                  <div className="soc-attention__text">
                    <span className="soc-attention__title">{item.title}</span>
                    {item.note ? <span className="soc-attention__note">{item.note}</span> : null}
                  </div>
                  <Button
                    size="small"
                    onClick={() => {
                      navigate(item.action.path);
                    }}
                  >
                    {item.action.label}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="soc-dash-cols">
        {slaBreaches.length > 0 ? (
          <Card title={t('dashboard.slaBreachRegister')} styles={{ body: { padding: 0 } }}>
            <DataTable<ServiceOrder>
              size="small"
              rowKey="id"
              dataSource={slaBreaches}
              pagination={false}
              scroll={{ x: 640 }}
              columns={[
                {
                  title: t('flight.number'), dataIndex: 'flightId', width: 110,
                  render: (value: string) => (
                    <Link to={`/flights/${value}/services`} className="soc-code soc-code--link">
                      {flightNumber(value)}
                    </Link>
                  ),
                },
                {
                  title: t('service.name'), key: 'service',
                  render: (_: unknown, row: ServiceOrder) => row.service?.name.ru ?? row.serviceId,
                },
                { title: t('service.vendor'), dataIndex: 'vendorName', width: 180, ellipsis: true },
                {
                  title: t('service.slaDeadline'), dataIndex: 'slaConfirmDeadline', width: 120,
                  render: (value: string | null) => <UtcTime value={value} withDate />,
                },
              ]}
            />
          </Card>
        ) : null}

        <Card title={t('dashboard.byStatus')}>
          {byStatus.length === 0 ? (
            <EmptyState />
          ) : (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {byStatus.map(([status, count]) => (
                <div key={status}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <FlightStatusTag status={status} size="sm" />
                    <Mono>{count}</Mono>
                  </Space>
                  {/* Полоса доли — в цвет точки статуса, как в графиках по статусам. */}
                  <Progress
                    percent={(count / Math.max(1, todayFlights.length)) * 100}
                    showInfo={false}
                    size="small"
                    strokeColor={STATUS_TOKENS[FLIGHT_STATUS_TOKENS[status] ?? 'neutral'].dot}
                  />
                </div>
              ))}
            </Space>
          )}
        </Card>
      </div>
    </>
  );
}
