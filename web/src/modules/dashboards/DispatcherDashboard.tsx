import { useMemo, type JSX } from 'react';
import { Card, Col, List, Progress, Row, Space, Statistic, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { DataTable } from '@/shared/ui/DataTable';

import type { ServiceOrder } from '@/api/types';
import { CONFLICTS, FLIGHT_LIST, SERVICE_ORDERS } from '@/mocks/flights';
import { AIRCRAFT } from '@/mocks/reference';
import { useClock } from '@/shared/clock/useClock';
import { EmptyState, FlightStatusTag, Mono, UtcTime } from '@/shared/ui/primitives';
import { FLIGHT_STATUS_TOKENS, STATUS_TOKENS } from '@/shared/ui/status-tokens';

/**
 * Дашборд диспетчера `[ТЗ 3.6.2]`.
 *
 * Состав виджетов — `SPEC.md § 9.2`: рейсы сегодня по статусам, ближайшие
 * вылеты с обратным отсчётом, неподтверждённые заявки с просроченным
 * лидтаймом, нарушения SLA за сутки, борта в AOG, конфликты расписания.
 *
 * Плотность `middle` — на дашбордах, в отличие от таблиц (`CLAUDE.md § 10`).
 */
export function DispatcherDashboard(): JSX.Element {
  const { t } = useTranslation();
  const { nowUtc } = useClock();
  // Пока часы не синхронизированы с сервером, точка отсчёта — эпоха:
  // лучше пустой список, чем список, посчитанный по часам браузера.
  const now = nowUtc;

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

  const upcoming = useMemo(
    () =>
      FLIGHT_LIST.filter((f) => new Date(f.stdUtc).getTime() > now.getTime())
        .sort((a, b) => a.stdUtc.localeCompare(b.stdUtc))
        .slice(0, 6),
    [now],
  );

  const slaBreaches = SERVICE_ORDERS.filter((o) => o.slaBreached);
  const unconfirmed = SERVICE_ORDERS.filter((o) => o.status === 'ordered');
  const aogAircraft = AIRCRAFT.filter((a) => a.status !== 'serviceable');

  const countdown = (iso: string): string => {
    const diff = new Date(iso).getTime() - now.getTime();
    const hours = Math.floor(diff / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    return `${String(hours)} ч ${String(minutes)} м`;
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('nav.dashboardDispatcher')}
      </Typography.Title>

      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title={t('dashboard.flightsToday')} value={todayFlights.length} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" style={unconfirmed.length > 0 ? { borderColor: STATUS_TOKENS.warning.border } : undefined}>
            <Statistic
              title={t('dashboard.unconfirmed')}
              value={unconfirmed.length}
              valueStyle={{ color: unconfirmed.length > 0 ? STATUS_TOKENS.warning.color : undefined }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" style={slaBreaches.length > 0 ? { borderColor: STATUS_TOKENS.critical.border } : undefined}>
            <Statistic
              title={t('dashboard.slaBreaches')}
              value={slaBreaches.length}
              valueStyle={{ color: slaBreaches.length > 0 ? STATUS_TOKENS.critical.color : undefined }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" style={CONFLICTS.length > 0 ? { borderColor: STATUS_TOKENS.critical.border } : undefined}>
            <Statistic
              title={t('dashboard.conflicts')}
              value={CONFLICTS.length}
              valueStyle={{ color: CONFLICTS.length > 0 ? STATUS_TOKENS.critical.color : undefined }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={8}>
          <Card size="small" title={t('dashboard.byStatus')}>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {byStatus.length === 0 ? (
                <EmptyState />
              ) : (
                byStatus.map(([status, count]) => {
                  const token = STATUS_TOKENS[FLIGHT_STATUS_TOKENS[status] ?? 'neutral'];
                  return (
                    <div key={status}>
                      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                        <FlightStatusTag status={status} />
                        <Mono>{count}</Mono>
                      </Space>
                      <Progress
                        percent={(count / Math.max(1, todayFlights.length)) * 100}
                        showInfo={false}
                        size="small"
                        strokeColor={token.color}
                      />
                    </div>
                  );
                })
              )}
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Card size="small" title={t('dashboard.upcoming')}>
            <List
              size="small"
              dataSource={upcoming}
              locale={{ emptyText: <EmptyState /> }}
              renderItem={(flight) => (
                <List.Item>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }} size={8}>
                    <Space direction="vertical" size={0}>
                      <Link to={`/flights/${flight.id}`}>
                        <Mono>{flight.number}</Mono>
                      </Link>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        <Mono>{flight.depIcao} → {flight.arrIcao}</Mono>
                      </Typography.Text>
                    </Space>
                    <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
                      <UtcTime value={flight.stdUtc} />
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        <Mono>{countdown(flight.stdUtc)}</Mono>
                      </Typography.Text>
                    </Space>
                  </Space>
                </List.Item>
              )}
            />
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Card size="small" title={t('dashboard.aogAircraft')}>
              <List
                size="small"
                dataSource={aogAircraft}
                locale={{ emptyText: <EmptyState description={t('dashboard.allServiceable')} /> }}
                renderItem={(aircraft) => (
                  <List.Item>
                    <Space direction="vertical" size={0}>
                      <Space size={6}>
                        <Mono>{aircraft.registration}</Mono>
                        <Tag color={aircraft.status === 'aog' ? 'red' : 'orange'}>
                          {t(`aircraftStatus.${aircraft.status}`)}
                        </Tag>
                      </Space>
                      {aircraft.notes ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {aircraft.notes}
                        </Typography.Text>
                      ) : null}
                    </Space>
                  </List.Item>
                )}
              />
            </Card>

            <Card size="small" title={t('dashboard.conflicts')}>
              <List
                size="small"
                dataSource={CONFLICTS}
                locale={{ emptyText: <EmptyState description={t('dashboard.noConflicts')} /> }}
                renderItem={(conflict) => (
                  <List.Item>
                    <Space direction="vertical" size={0}>
                      <Tag
                        style={{
                          margin: 0,
                          color: conflict.severity === 'blocking' ? STATUS_TOKENS.critical.color : STATUS_TOKENS.warning.color,
                          borderColor: conflict.severity === 'blocking' ? STATUS_TOKENS.critical.border : STATUS_TOKENS.warning.border,
                          background: 'transparent',
                        }}
                      >
                        {t(`conflictKind.${conflict.kind}`)}
                      </Tag>
                      <Link to={`/flights/${conflict.flightId}`} style={{ fontSize: 12 }}>
                        {conflict.message}
                      </Link>
                    </Space>
                  </List.Item>
                )}
              />
            </Card>
          </Space>
        </Col>
      </Row>

      <Card size="small" title={t('dashboard.slaBreachRegister')} styles={{ body: { padding: 0 } }}>
        <DataTable<ServiceOrder>
          size="small"
          rowKey="id"
          dataSource={slaBreaches}
          pagination={false}
          scroll={{ x: 700 }}
          locale={{ emptyText: <EmptyState description={t('dashboard.noSlaBreaches')} /> }}
          columns={[
            {
              title: t('flight.number'), dataIndex: 'flightId', width: 110,
              render: (value: string) => (
                <Link to={`/flights/${value}/services`}>
                  <Mono>{FLIGHT_LIST.find((f) => f.id === value)?.number ?? value}</Mono>
                </Link>
              ),
            },
            {
              title: t('service.name'), key: 'service',
              render: (_: unknown, row: ServiceOrder) => row.service?.name.ru ?? row.serviceId,
            },
            { title: t('service.vendor'), dataIndex: 'vendorName', width: 200, ellipsis: true },
            {
              title: t('service.slaDeadline'), dataIndex: 'slaConfirmDeadline', width: 130,
              render: (value: string | null) => <UtcTime value={value} withDate />,
            },
          ]}
        />
      </Card>
    </Space>
  );
}
