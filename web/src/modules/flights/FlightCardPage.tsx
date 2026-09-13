import { useMemo, useState, type JSX } from 'react';
import {
  Alert, Button, Card, Col, Descriptions, Divider, Drawer, Row, Space, Tabs, Tag, Tooltip, Typography,
} from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { AIRCRAFT_BY_ID, AIRCRAFT_TYPE_BY_ID, AIRPORT_BY_ICAO, AIRPORT_UTC_OFFSET } from '@/mocks/reference';
import { CLIENT_BY_ID } from '@/mocks/counterparties';
import { CONFLICTS, FLIGHT_BY_ID, MARGINS, SLOTS, ordersForFlight } from '@/mocks/flights';
import { Can } from '@/shared/auth/Can';
import {
  DateText, EmptyState, Field, FlightStatusTag, MoneyText, Mono, PercentText, UtcTime,
} from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';
import { NotFoundPage } from '@/modules/misc/NotFoundPage';
import { FlightServicesTab } from './FlightServicesTab';
import { FlightFinanceTab } from './FlightFinanceTab';
import { FlightDocumentsTab } from './FlightDocumentsTab';
import { FlightHistoryTab } from './FlightHistoryTab';
import { StatusPanel } from './StatusPanel';

/** Локальное время аэропорта — подпись зоны обязательна (`CLAUDE.md § 10`). */
function localAt(icao: string, iso: string): { time: string; offset: string } {
  const offset = AIRPORT_UTC_OFFSET[icao] ?? 0;
  const shifted = new Date(new Date(iso).getTime() + offset * 3_600_000);
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return { time: `${hh}:${mm}`, offset: `UTC${offset >= 0 ? '+' : ''}${String(offset)}` };
}

export function FlightCardPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id, tab } = useParams<{ id: string; tab?: string }>();
  const [contextOpen, setContextOpen] = useState(false);

  const flight = id ? FLIGHT_BY_ID.get(id) : undefined;
  const orders = useMemo(() => (id ? ordersForFlight(id) : []), [id]);
  const margin = id ? MARGINS.get(id) : undefined;

  if (!flight) return <NotFoundPage />;

  const client = CLIENT_BY_ID.get(flight.clientId);
  const aircraft = flight.aircraftId ? AIRCRAFT_BY_ID.get(flight.aircraftId) : undefined;
  const aircraftType = aircraft ? AIRCRAFT_TYPE_BY_ID.get(aircraft.typeId) : undefined;
  const dep = AIRPORT_BY_ICAO.get(flight.depIcao);
  const arr = AIRPORT_BY_ICAO.get(flight.arrIcao);
  const conflicts = CONFLICTS.filter((c) => c.flightId === flight.id);
  const slots = SLOTS.filter((s) => s.flightId === flight.id);

  const marginPercent = margin?.marginPercent ?? null;
  const belowThreshold = margin?.isBelowThreshold ?? false;

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
                    <Space size={6}>
                      <Mono>{flight.depIcao}</Mono>
                      <Typography.Text type="secondary">{dep?.name.ru}</Typography.Text>
                    </Space>
                    <UtcTime value={flight.stdUtc} withDate local={localAt(flight.depIcao, flight.stdUtc)} />
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label={t('flight.arrival')}>
                  <Space direction="vertical" size={0}>
                    <Space size={6}>
                      <Mono>{flight.arrIcao}</Mono>
                      <Typography.Text type="secondary">{arr?.name.ru}</Typography.Text>
                    </Space>
                    <UtcTime value={flight.staUtc} withDate local={localAt(flight.arrIcao, flight.staUtc)} />
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label={t('flight.actualTimes')}>
                  <Space size={12}>
                    <Field label={t('flight.atd')}><UtcTime value={flight.atdUtc ?? null} /></Field>
                    <Field label={t('flight.ata')}><UtcTime value={flight.ataUtc ?? null} /></Field>
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label={t('flight.distance')}>
                  <Space direction="vertical" size={0}>
                    <Space size={12}>
                      <Mono>{flight.distanceNm} NM</Mono>
                      <Mono>{Math.floor((flight.blockTimeMin ?? 0) / 60)}ч {(flight.blockTimeMin ?? 0) % 60}м</Mono>
                      <Mono>{flight.fuelPlanKg} кг</Mono>
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
              </Descriptions>
            </Card>
          </Col>

          <Col xs={24} lg={12}>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Card size="small" title={t('flight.sections.client')}>
                <Descriptions size="small" column={1} bordered>
                  <Descriptions.Item label={t('client.name')}>
                    <Typography.Link onClick={() => { navigate(`/clients/${flight.clientId}`); }}>
                      {client?.name}
                    </Typography.Link>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('client.currency')}>
                    <Mono>{flight.billingCurrency}</Mono>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('client.paymentTerms')}>
                    {t(`paymentMode.${client?.paymentTerms.mode ?? 'postpayment'}`)}
                    {client?.paymentTerms.deferDays ? `, ${String(client.paymentTerms.deferDays)} ${t('common.days')}` : ''}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('client.contact')}>
                    {client?.contacts?.[0]?.name} · {client?.contacts?.[0]?.email}
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
                      {aircraftType?.name.ru} (<Mono>{aircraftType?.icaoType}</Mono>)
                    </Descriptions.Item>
                    <Descriptions.Item label={t('flight.pax')}>{flight.paxCount}</Descriptions.Item>
                    <Descriptions.Item label={t('flight.crew')}>
                      <Space direction="vertical" size={0}>
                        {flight.crew?.map((member) => (
                          <span key={member.id}>
                            {member.name} — {t(`crewRole.${member.role}`)}
                          </span>
                        ))}
                      </Space>
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
                        <UtcTime value={slot.confirmedTimeUtc ?? slot.requestedTimeUtc ?? null} withDate />
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
    { key: 'finance', label: t('flight.tabs.finance'), children: <FlightFinanceTab flight={flight} orders={orders} /> },
    { key: 'documents', label: t('flight.tabs.documents'), children: <FlightDocumentsTab flight={flight} orders={orders} /> },
    { key: 'history', label: t('flight.tabs.history'), children: <FlightHistoryTab flightId={flight.id} /> },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {/* Шапка: номер, клиент, борт, маршрут, время, статус, сводка маржи */}
      <Card size="small">
        <Row gutter={[12, 12]} align="middle" wrap>
          <Col flex="auto">
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
                <UtcTime value={flight.stdUtc} withDate local={localAt(flight.depIcao, flight.stdUtc)} />
              </Space>
            </Space>
          </Col>

          <Col>
            <Space size={16} align="center">
              <Field label={t('flight.marginSummary')}>
                <Space size={8}>
                  <MoneyText value={margin?.margin} strong colorBySign />
                  <PercentText value={marginPercent} colorBySign threshold={12} />
                </Space>
              </Field>
              <Button
                onClick={() => {
                  setContextOpen(true);
                }}
              >
                {t('flight.context')}
              </Button>
            </Space>
          </Col>
        </Row>

        <Divider style={{ margin: '12px 0' }} />
        <StatusPanel flight={flight} orders={orders} />
      </Card>

      {conflicts.length > 0 ? (
        <Alert
          type={conflicts.some((c) => c.severity === 'blocking') ? 'error' : 'warning'}
          showIcon
          message={t('schedule.conflictsFound', { count: conflicts.length })}
          description={
            <Space direction="vertical" size={2}>
              {conflicts.map((conflict, index) => (
                <span key={index}>
                  <Tag style={{ margin: 0, marginInlineEnd: 6 }}>{t(`conflictKind.${conflict.kind}`)}</Tag>
                  {conflict.message}
                </span>
              ))}
            </Space>
          }
        />
      ) : null}

      {belowThreshold ? (
        <Alert
          type="warning"
          showIcon
          message={t('finance.lowMarginTitle', {
            value: marginPercent ? Number.parseFloat(marginPercent).toFixed(1) : '—',
            threshold: '12',
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

      {/* Правая панель «Контекст»: дедлайны, события, быстрые действия */}
      <Drawer
        title={t('flight.context')}
        placement="right"
        width={360}
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
                      {order.service?.name.ru ?? order.serviceId}
                    </Typography.Text>
                    <Space size={4}>
                      <UtcTime value={order.slaConfirmDeadline ?? null} />
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
              <Button block onClick={() => { navigate('/communications/outbox'); }}>
                {t('comms.openOutbox')}
              </Button>
            </Space>
          </Card>

          <Card size="small" title={t('flight.meta')}>
            <Descriptions size="small" column={1}>
              <Descriptions.Item label={t('common.createdAt')}>
                <DateText value={flight.createdAt ?? null} />
              </Descriptions.Item>
              <Descriptions.Item label={t('common.updatedAt')}>
                <DateText value={flight.updatedAt ?? null} />
              </Descriptions.Item>
              <Descriptions.Item label={t('common.dataSource')}>
                <Tooltip title={t('demo.syntheticHint')}>
                  <Tag color="purple">{t('demo.synthetic')}</Tag>
                </Tooltip>
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Space>
      </Drawer>
    </Space>
  );
}

export { STATUS_TOKENS };
