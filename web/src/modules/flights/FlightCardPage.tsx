import { useState, type JSX } from 'react';
import {
  Alert, Button, Card, Col, Descriptions, Divider, Drawer, Row, Space, Tabs, Tag, Typography,
} from 'antd';
import dayjs from 'dayjs';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useFlightMargin } from '@/api/billing';
import { useAirportsByIcao } from '@/api/catalog';
import { useNotifications } from '@/api/comms';
import { useClient } from '@/api/counterparties';
import { useFleet } from '@/api/fleet';
import { useFlight, useScheduleConflicts } from '@/api/flights';
import { useSlots } from '@/api/slots';
import { useFlightOrders } from '@/api/orders';
import { Can } from '@/shared/auth/Can';
import { usePermission } from '@/shared/auth/session';
import { formatUtcOffset, utcOffsetHours } from '@/shared/format/timezone';
import { useLocalizedName } from '@/shared/i18n/useLocalizedName';
import { useScreenTiming } from '@/shared/perf/measure';
import { QueryState } from '@/shared/ui/QueryState';
import {
  DateText, EmptyState, Field, FlightStatusTag, MoneyText, Mono, PercentText, UtcTime,
} from '@/shared/ui/primitives';
import { NotFoundPage } from '@/modules/misc/NotFoundPage';
import { Notice } from '@/shared/ui/Notice';
import { FlightServicesTab } from './FlightServicesTab';
import { FlightFinanceTab } from './FlightFinanceTab';
import { FlightDocumentsTab } from './FlightDocumentsTab';
import { FlightEditModal } from './FlightEditModal';
import { FlightHistoryTab } from './FlightHistoryTab';
import { StatusPanel } from './StatusPanel';

/**
 * Локальное время аэропорта — подпись зоны обязательна (`CLAUDE.md § 10`).
 *
 * Зона берётся из справочника, смещение считается на момент рейса:
 * в зоне с переходом на летнее время оно зависит от даты.
 */
function localAt(timezone: string | undefined, iso: string): { time: string; offset: string } {
  if (!timezone) return { time: '', offset: '' };

  const at = new Date(iso);
  const offset = utcOffsetHours(timezone, at);
  const shifted = new Date(at.getTime() + offset * 3_600_000);
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return { time: `${hh}:${mm}`, offset: formatUtcOffset(timezone, at) };
}

/**
 * Карточка рейса `[ТЗ 3.1.4]` (`SPEC.md § 4.6`).
 *
 * Конфликты запрашиваются за минуту вокруг вылета этого рейса, а не за весь
 * горизонт планирования: карточке нужен один рейс, и открываться она должна
 * в норматив ТЗ 4.4 на полном наборе данных.
 */
export function FlightCardPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const localized = useLocalizedName();
  const { id, tab } = useParams<{ id: string; tab?: string }>();
  const [contextOpen, setContextOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const canSeeMargin = usePermission('billing.margin.view');

  const flightQuery = useFlight(id);
  const flight = flightQuery.data;
  const orders = useFlightOrders(id).data ?? [];

  const airports = useAirportsByIcao([flight?.depIcao ?? '', flight?.arrIcao ?? '']);
  const fleet = useFleet().data?.data ?? [];
  const client = useClient(flight?.clientId).data;
  const margin = useFlightMargin(id, 'mixed', canSeeMargin).data;
  const conflictWindow = flight
    ? {
        from: dayjs(flight.stdUtc).subtract(1, 'minute').toISOString(),
        to: dayjs(flight.stdUtc).add(1, 'minute').toISOString(),
      }
    : undefined;
  const conflictsQuery = useScheduleConflicts(conflictWindow);
  const slots = useSlots({ flightId: id }).data?.data ?? [];
  const unread = useNotifications(true).data?.data ?? [];
  // Норматив ТЗ 4.4 — до отрисовки карточки с данными рейса (ADR-017).
  useScreenTiming('flight_card', Boolean(flight));

  if (flightQuery.isError) return <NotFoundPage />;
  if (!flight) return <QueryState query={flightQuery}>{() => null}</QueryState>;

  const aircraft = flight.aircraftId
    ? fleet.find((item) => item.id === flight.aircraftId)
    : undefined;
  const aircraftType = aircraft?.type;
  const dep = airports[flight.depIcao];
  const arr = airports[flight.arrIcao];
  const conflicts = (conflictsQuery.data?.data ?? []).filter((item) => item.flightId === flight.id);
  const events = unread.filter((item) => item.link.startsWith(`/flights/${flight.id}`));
  const threshold = margin ? Number.parseFloat(margin.thresholdPercent) : undefined;

  const tabItems = [
    {
      key: 'overview',
      label: t('flight.tabs.overview'),
      children: (
        <Row gutter={[12, 12]}>
          <Col xs={24} lg={12}>
            <Card size="small" title={t('flight.sections.route')}>
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label={t('flight.departure')}>
                  <Space direction="vertical" size={0}>
                    <Space size={6} wrap>
                      <Mono>{flight.depIcao}</Mono>
                      <Typography.Text type="secondary">{localized(dep?.name)}</Typography.Text>
                    </Space>
                    <UtcTime value={flight.stdUtc} withDate local={localAt(dep?.timezone, flight.stdUtc)} />
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label={t('flight.arrival')}>
                  <Space direction="vertical" size={0}>
                    <Space size={6} wrap>
                      <Mono>{flight.arrIcao}</Mono>
                      <Typography.Text type="secondary">{localized(arr?.name)}</Typography.Text>
                    </Space>
                    <UtcTime value={flight.staUtc} withDate local={localAt(arr?.timezone, flight.staUtc)} />
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label={t('flight.actualTimes')}>
                  <Space size={12} wrap>
                    <Field label={t('flight.atd')}><UtcTime value={flight.atdUtc} /></Field>
                    <Field label={t('flight.ata')}><UtcTime value={flight.ataUtc} /></Field>
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label={t('flight.distance')}>
                  <Space direction="vertical" size={0}>
                    <Space size={12} wrap>
                      <Mono>{t('flight.distanceValue', { nm: flight.distanceNm })}</Mono>
                      <Mono>
                        {t('flight.blockTimeValue', {
                          h: Math.floor(flight.blockTimeMin / 60),
                          m: flight.blockTimeMin % 60,
                        })}
                      </Mono>
                      <Mono>{t('flight.fuelValue', { kg: flight.fuelPlanKg })}</Mono>
                    </Space>
                    {/* DOMAIN § 7.8: расчёт плановый и оценочный */}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t('flight.estimateHint')}
                    </Typography.Text>
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label={t('flight.international')}>
                  {flight.isInternational ? <Tag color="blue">{t('common.yes')}</Tag> : <Tag>{t('common.no')}</Tag>}
                </Descriptions.Item>
                {flight.remarks ? (
                  <Descriptions.Item label={t('flight.remarks')}>{flight.remarks}</Descriptions.Item>
                ) : null}
              </Descriptions>
            </Card>
          </Col>

          <Col xs={24} lg={12}>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Card size="small" title={t('flight.sections.client')}>
                <Descriptions size="small" column={1} bordered>
                  <Descriptions.Item label={t('client.name')}>
                    <Typography.Link onClick={() => { navigate(`/clients/${flight.clientId}`); }}>
                      {client?.name ?? flight.clientId}
                    </Typography.Link>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('client.currency')}>
                    <Mono>{flight.billingCurrency}</Mono>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('client.country')}>
                    <Mono>{client?.country ?? '—'}</Mono>
                  </Descriptions.Item>
                </Descriptions>
              </Card>

              <Card size="small" title={t('flight.sections.aircraft')}>
                {aircraft ? (
                  <Descriptions size="small" column={1} bordered>
                    <Descriptions.Item label={t('fleet.registration')}>
                      <Space size={8}>
                        <Mono>{aircraft.registration}</Mono>
                        {aircraft.status !== 'serviceable' ? (
                          <Tag color={aircraft.status === 'aog' ? 'red' : 'orange'}>
                            {t(`aircraftStatus.${aircraft.status}`)}
                          </Tag>
                        ) : null}
                      </Space>
                    </Descriptions.Item>
                    <Descriptions.Item label={t('fleet.type')}>
                      {localized(aircraftType?.name)} (<Mono>{aircraftType?.icaoType ?? '—'}</Mono>)
                    </Descriptions.Item>
                    <Descriptions.Item label={t('flight.pax')}>{flight.paxCount}</Descriptions.Item>
                    <Descriptions.Item label={t('flight.crew')}>
                      {flight.crew.length > 0 ? (
                        <Space direction="vertical" size={0}>
                          {flight.crew.map((member) => (
                            <span key={`${member.role}:${member.name}`}>
                              {member.name} — {t(`crewRole.${member.role}`)}
                            </span>
                          ))}
                        </Space>
                      ) : (
                        <Typography.Text type="secondary">—</Typography.Text>
                      )}
                    </Descriptions.Item>
                  </Descriptions>
                ) : (
                  <EmptyState description={t('flight.noAircraftAssigned')} />
                )}
              </Card>

              {slots.length > 0 ? (
                <Card size="small" title={t('flight.sections.slots')}>
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    {slots.map((slot) => (
                      <Space key={slot.id} size={8} wrap>
                        <Mono>{slot.airportIcao}</Mono>
                        <Tag>{t(`slotKind.${slot.kind}`)}</Tag>
                        <UtcTime value={slot.confirmedTimeUtc ?? slot.requestedTimeUtc} withDate />
                        <Tag
                          color={slot.status === 'confirmed' ? 'green' : slot.status === 'rejected' ? 'red' : 'default'}
                        >
                          {t(`slotStatus.${slot.status}`)}
                        </Tag>
                        {slot.messageRef ? <Mono>{slot.messageRef}</Mono> : null}
                      </Space>
                    ))}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t('slots.manualHint')}
                    </Typography.Text>
                  </Space>
                </Card>
              ) : null}
            </Space>
          </Col>
        </Row>
      ),
    },
    { key: 'services', label: `${t('flight.tabs.services')} (${String(orders.length)})`, children: <FlightServicesTab flight={flight} orders={orders} /> },
    ...(canSeeMargin
      ? [{ key: 'finance', label: t('flight.tabs.finance'), children: <FlightFinanceTab flight={flight} orders={orders} /> }]
      : []),
    { key: 'documents', label: t('flight.tabs.documents'), children: <FlightDocumentsTab flight={flight} orders={orders} /> },
    { key: 'history', label: t('flight.tabs.history'), children: <FlightHistoryTab flightId={flight.id} /> },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {/* Шапка: номер, клиент, борт, маршрут, время, статус, сводка маржи */}
      <Card size="small">
        <Row gutter={[12, 12]} align="middle" wrap>
          <Col flex="auto" style={{ minWidth: 0 }}>
            <Space direction="vertical" size={2}>
              <Space size={10} wrap align="center">
                <Typography.Title level={4} style={{ margin: 0 }}>
                  <Mono>{flight.number}</Mono>
                </Typography.Title>
                <FlightStatusTag status={flight.status} />
                <Tag>{t(`flightType.${flight.type}`)}</Tag>
                {flight.isInternational ? <Tag color="blue">{t('flight.intl')}</Tag> : null}
              </Space>
              <Space size={10} wrap>
                <Typography.Text type="secondary">{client?.name}</Typography.Text>
                <Mono>{flight.depIcao} → {flight.arrIcao}</Mono>
                {aircraft ? <Mono>{aircraft.registration}</Mono> : <Tag>{t('schedule.noAircraft')}</Tag>}
                <UtcTime value={flight.stdUtc} withDate local={localAt(dep?.timezone, flight.stdUtc)} />
              </Space>
            </Space>
          </Col>

          <Col>
            <Space size={16} align="center" wrap>
              {canSeeMargin ? (
                <Field label={t('flight.marginSummary')}>
                  <Space size={8}>
                    <MoneyText value={margin?.margin} strong colorBySign />
                    <PercentText
                      value={margin?.marginPercent ?? null}
                      colorBySign
                      {...(threshold === undefined ? {} : { threshold })}
                    />
                  </Space>
                </Field>
              ) : null}
              {flight.status !== 'completed' && flight.status !== 'cancelled' ? (
                <Can permission="flight.edit">
                  <Button
                    onClick={() => {
                      setEditing(true);
                    }}
                  >
                    {t('common.edit')}
                  </Button>
                </Can>
              ) : null}
              <Button
                onClick={() => {
                  setContextOpen(true);
                }}
              >
                {t('flight.context')}
                {events.length > 0 ? ` (${String(events.length)})` : ''}
              </Button>
            </Space>
          </Col>
        </Row>

        <Divider style={{ margin: '12px 0' }} />
        <StatusPanel flight={flight} />
      </Card>

      {conflicts.length > 0 ? (
        <Alert
          type={conflicts.some((c) => c.severity === 'blocking') ? 'error' : 'warning'}
          showIcon
          message={t('schedule.conflictsFound', { count: conflicts.length })}
          description={
            <Space direction="vertical" size={2}>
              {conflicts.map((conflict) => (
                <span key={`${conflict.kind}:${conflict.relatedFlightId ?? ''}:${conflict.message}`}>
                  <Tag style={{ margin: 0, marginInlineEnd: 6 }}>{t(`conflictKind.${conflict.kind}`)}</Tag>
                  {conflict.message}
                </span>
              ))}
            </Space>
          }
        />
      ) : null}

      {margin?.isBelowThreshold ? (
        <Notice
          id={`finance.lowMargin:${flight.id}`}
          type="warning"
          showIcon
          message={t('finance.lowMarginTitle', {
            value: margin.marginPercent ?? '—',
            threshold: margin.thresholdPercent,
          })}
          description={t('finance.lowMarginHint')}
          action={
            <Can permission="vendor.assign">
              <Button size="small" onClick={() => { navigate(`/flights/${flight.id}/services`); }}>
                {t('finance.suggestCheaper')}
              </Button>
            </Can>
          }
        />
      ) : null}

      <Card size="small" styles={{ body: { paddingTop: 0 } }}>
        <Tabs
          activeKey={tab ?? 'overview'}
          items={tabItems}
          onChange={(key) => {
            navigate(`/flights/${flight.id}/${key}`);
          }}
        />
      </Card>

      {editing ? (
        <FlightEditModal
          flight={flight}
          open
          onClose={() => {
            setEditing(false);
          }}
        />
      ) : null}

      {/* Правая панель «Контекст»: дедлайны, события, быстрые действия */}
      <Drawer
        title={t('flight.context')}
        placement="right"
        width="min(360px, 100vw)"
        open={contextOpen}
        onClose={() => {
          setContextOpen(false);
        }}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Card size="small" title={t('flight.deadlines')}>
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {orders
                .filter((order) => order.status === 'ordered' && order.slaConfirmDeadline)
                .slice(0, 5)
                .map((order) => (
                  <Space key={order.id} size={8} style={{ justifyContent: 'space-between', width: '100%' }}>
                    <Typography.Text ellipsis style={{ maxWidth: 180 }}>
                      {order.service ? localized(order.service.name) : order.serviceId}
                    </Typography.Text>
                    <Space size={4}>
                      <UtcTime value={order.slaConfirmDeadline} />
                      {order.slaBreached ? (
                        <Tag color="red" style={{ margin: 0 }}>{t('service.slaBreached')}</Tag>
                      ) : null}
                    </Space>
                  </Space>
                ))}
              {orders.every((o) => o.status !== 'ordered') ? (
                <Typography.Text type="secondary">{t('flight.noDeadlines')}</Typography.Text>
              ) : null}
            </Space>
          </Card>

          <Card size="small" title={t('flight.events')}>
            {events.length > 0 ? (
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {events.slice(0, 10).map((event) => (
                  <Space key={event.id} direction="vertical" size={0}>
                    <Typography.Text strong>{event.title}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      <UtcTime value={event.createdAt} withDate />
                    </Typography.Text>
                  </Space>
                ))}
              </Space>
            ) : (
              <Typography.Text type="secondary">{t('flight.noEvents')}</Typography.Text>
            )}
          </Card>

          <Card size="small" title={t('flight.quickActions')}>
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Can permission="service.order">
                <Button block onClick={() => { navigate(`/flights/${flight.id}/services`); }}>
                  {t('service.orderNew')}
                </Button>
              </Can>
              <Can permission="billing.documents.edit">
                <Button block onClick={() => { navigate('/billing/quotes'); }}>
                  {t('finance.createQuote')}
                </Button>
              </Can>
              <Can permission="comms.view">
                <Button block onClick={() => { navigate('/communications/outbox'); }}>
                  {t('comms.openOutbox')}
                </Button>
              </Can>
            </Space>
          </Card>

          <Card size="small" title={t('flight.meta')}>
            <Descriptions size="small" column={1}>
              <Descriptions.Item label={t('common.createdAt')}>
                <DateText value={flight.createdAt} />
              </Descriptions.Item>
              <Descriptions.Item label={t('common.updatedAt')}>
                <DateText value={flight.updatedAt} />
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Space>
      </Drawer>
    </Space>
  );
}
