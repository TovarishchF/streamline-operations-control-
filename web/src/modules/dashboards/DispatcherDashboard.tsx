import type { JSX, ReactNode } from 'react';
import { Alert, Button, Progress, Space } from 'antd';
import { PlusOutlined, ScheduleOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useDashboard, type DashboardData } from '@/api/reports';
import { Can } from '@/shared/auth/Can';
import { useCurrentUser } from '@/shared/auth/session';
import { useClock, formatUtc } from '@/shared/clock/useClock';
import { useLocalizedName } from '@/shared/i18n/useLocalizedName';
import { FlightStrip } from '@/shared/ui/FlightStrip';
import { KpiTile } from '@/shared/ui/KpiTile';
import { PageHeader } from '@/shared/ui/PageHeader';
import { QueryState } from '@/shared/ui/QueryState';
import { EmptyState, FlightStatusTag, Mono, StatusPill, UtcTime } from '@/shared/ui/primitives';
import { FLIGHT_STATUS_TOKENS, STATUS_TOKENS } from '@/shared/ui/status-tokens';
import { DashboardGrid } from './DashboardGrid';
import { widgetResult, type WidgetCode, type WidgetData } from './widgets';

/** Диспетчер смотрит текущую обстановку: дашборд обновляется сам. */
const REFRESH_MS = 60_000;

/**
 * Дашборд диспетчера `[ТЗ 3.6.2]`.
 *
 * Состав виджетов — `SPEC.md § 9.2`: рейсы сегодня по статусам, ближайшие
 * вылеты с обратным отсчётом, неподтверждённые заявки с просроченным
 * лидтаймом, нарушения SLA за сутки, борта в AOG, конфликты расписания.
 * Данные виджетов считает сервер (`GET /dashboards/dispatcher`), раскладка
 * настраивается и сохраняется на пользователя.
 */
export function DispatcherDashboard(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { nowUtc } = useClock();
  const user = useCurrentUser();
  const query = useDashboard('dispatcher', { refetchMs: REFRESH_MS });
  const timeZone = user?.timezone ?? 'UTC';
  const locale = i18n.language.startsWith('en') ? 'en-GB' : 'ru-RU';

  const date = new Intl.DateTimeFormat(locale, {
    timeZone, weekday: 'long', day: 'numeric', month: 'long',
  }).format(nowUtc);

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
      <QueryState query={query}>
        {(dashboard) => (
          <DashboardGrid
            role="dispatcher"
            dashboard={dashboard}
            render={(code) => <DispatcherWidget dashboard={dashboard} code={code} nowUtc={nowUtc} />}
          />
        )}
      </QueryState>
    </>
  );
}

function DispatcherWidget({
  dashboard,
  code,
  nowUtc,
}: {
  dashboard: DashboardData;
  code: string;
  nowUtc: Date;
}): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const localized = useLocalizedName();

  const show = <C extends WidgetCode>(
    widget: C,
    draw: (data: WidgetData<C>) => ReactNode,
  ): JSX.Element => {
    const result = widgetResult(dashboard, widget);
    return result.kind === 'ok' ? <>{draw(result.data)}</> : <Alert type="warning" showIcon message={result.message} />;
  };

  switch (code) {
    case 'flights_today':
      return show('flights_today', (data) => (
        <KpiTile
          value={data.count}
          footnote={t('dashboard.flightsTodayWindow', {
            from: formatUtc(new Date(data.from)),
            to: formatUtc(new Date(data.to)),
          })}
        />
      ));
    case 'unconfirmed':
      return show('unconfirmed', (data) => (
        <KpiTile
          value={data.count}
          tone={data.count > 0 ? 'warning' : 'default'}
          extra={
            data.dueSoon > 0 ? (
              <StatusPill token="warning" label={t('dashboard.slaSoonCount', { count: data.dueSoon })} size="sm" />
            ) : null
          }
          footnote={t('dashboard.ofOrders', { count: data.activeTotal })}
        />
      ));
    case 'sla_breaches':
      return show('sla_breaches', (data) => (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <KpiTile
            value={data.count}
            tone={data.count > 0 ? 'critical' : 'default'}
            footnote={data.count > 0 ? t('dashboard.slaBreachesHint') : t('dashboard.noSlaBreaches')}
          />
          {data.items.length > 0 ? (
            <ul className="soc-attention">
              {data.items.map((item) => (
                <li key={item.orderId}>
                  <StatusPill token="critical" label="SLA" size="sm" />
                  <div className="soc-attention__text">
                    <span className="soc-attention__title">{localized(item.serviceName)}</span>
                    <span className="soc-attention__note">
                      <span className="soc-code">{item.flightNumber}</span> · {item.vendorName ?? '—'} ·{' '}
                      {t('dashboard.deadline')} <UtcTime value={item.slaConfirmDeadline} />
                    </span>
                  </div>
                  <Button size="small" onClick={() => { navigate(`/flights/${item.flightId}/services`); }}>
                    {t('dashboard.openServices')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </Space>
      ));
    case 'aircraft_out_of_service':
      return show('aircraft_out_of_service', (data) => (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <KpiTile
            value={data.count}
            tone={data.count > 0 ? 'critical' : 'default'}
            footnote={data.count === 0 ? t('dashboard.allServiceable') : null}
          />
          {data.items.length > 0 ? (
            <ul className="soc-attention">
              {data.items.map((aircraft) => (
                <li key={aircraft.id}>
                  <StatusPill
                    token={aircraft.status === 'aog' ? 'critical' : 'warning'}
                    label={aircraft.status === 'aog' ? 'AOG' : t(`aircraftStatus.${aircraft.status}`)}
                    size="sm"
                  />
                  <div className="soc-attention__text">
                    <span className="soc-attention__title soc-code">{aircraft.registration}</span>
                    {aircraft.notes ? <span className="soc-attention__note">{aircraft.notes}</span> : null}
                  </div>
                  <Button size="small" onClick={() => { navigate('/fleet'); }}>
                    {t('dashboard.openFleet')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </Space>
      ));
    case 'upcoming':
      return show('upcoming', (data) =>
        data.items.length === 0 ? (
          <EmptyState description={t('dashboard.noUpcoming')} />
        ) : (
          <Space direction="vertical" size={0} style={{ width: '100%' }}>
            {data.items.map((flight) => (
              <FlightStrip
                key={flight.id}
                flightId={flight.id}
                flightNo={flight.number}
                tail={flight.aircraftRegistration}
                typeCode={flight.aircraftType}
                dep={{ icao: flight.depIcao, etd: flight.stdUtc }}
                arr={{ icao: flight.arrIcao, eta: flight.staUtc }}
                status={{
                  token: FLIGHT_STATUS_TOKENS[flight.status] ?? 'neutral',
                  label: t(`flightStatus.${flight.status}`),
                }}
                minutesToEtd={Math.floor((new Date(flight.stdUtc).getTime() - nowUtc.getTime()) / 60_000)}
              />
            ))}
            {data.total > data.items.length ? (
              <Link to="/schedule">{t('dashboard.allUpcoming', { count: data.total })}</Link>
            ) : null}
          </Space>
        ),
      );
    case 'conflicts':
      return show('conflicts', (data) =>
        data.items.length === 0 ? (
          <EmptyState description={t('dashboard.noConflicts')} />
        ) : (
          <ul className="soc-attention">
            {data.items.map((conflict, index) => (
              <li key={`${conflict.flightId}:${conflict.kind}:${String(index)}`}>
                <StatusPill
                  token={conflict.severity === 'blocking' ? 'critical' : 'warning'}
                  label={t(`conflictKind.${conflict.kind}`)}
                  size="sm"
                />
                <div className="soc-attention__text">
                  <span className="soc-attention__title soc-code">{conflict.flightNumber}</span>
                  <span className="soc-attention__note">{conflict.message}</span>
                </div>
                <Button size="small" onClick={() => { navigate(`/flights/${conflict.flightId}`); }}>
                  {t('dashboard.resolve')}
                </Button>
              </li>
            ))}
          </ul>
        ),
      );
    case 'flights_by_status':
      return show('flights_by_status', (data) => {
        const total = data.items.reduce((sum, item) => sum + item.count, 0);
        return data.items.length === 0 ? (
          <EmptyState />
        ) : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {data.items.map((item) => (
              <div key={item.status}>
                <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                  <FlightStatusTag status={item.status} size="sm" />
                  <Mono>{item.count}</Mono>
                </Space>
                {/* Полоса доли — в цвет точки статуса, как в графиках по статусам. */}
                <Progress
                  percent={(item.count / Math.max(1, total)) * 100}
                  showInfo={false}
                  size="small"
                  strokeColor={STATUS_TOKENS[FLIGHT_STATUS_TOKENS[item.status] ?? 'neutral'].dot}
                />
              </div>
            ))}
          </Space>
        );
      });
    case 'lead_time_overdue':
      return show('lead_time_overdue', (data) =>
        data.items.length === 0 ? (
          <EmptyState description={t('dashboard.noLeadTimeOverdue')} />
        ) : (
          <ul className="soc-attention">
            {data.items.map((item) => (
              <li key={item.orderId}>
                <StatusPill token="warning" label={t('dashboard.leadTime')} size="sm" />
                <div className="soc-attention__text">
                  <span className="soc-attention__title">{localized(item.serviceName)}</span>
                  <span className="soc-attention__note">
                    <span className="soc-code">{item.flightNumber}</span> · {item.vendorName ?? '—'} ·{' '}
                    <UtcTime value={item.serviceAt} withDate />
                  </span>
                </div>
                <Button size="small" onClick={() => { navigate(`/flights/${item.flightId}/services`); }}>
                  {t('dashboard.openServices')}
                </Button>
              </li>
            ))}
          </ul>
        ),
      );
    default:
      return <EmptyState />;
  }
}
