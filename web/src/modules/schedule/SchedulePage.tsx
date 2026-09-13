import { useMemo, useState, type JSX } from 'react';
import {
  Alert, Button, Card, Col, Input, Radio, Row, Segmented, Select, Space, Table, Tag, Tooltip, Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ExportOutlined, PlusOutlined, WarningOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { FlightListItem, FlightStatus } from '@/api/types';
import { CLIENTS } from '@/mocks/counterparties';
import { CONFLICTS, FLIGHT_LIST } from '@/mocks/flights';
import { AIRPORTS } from '@/mocks/reference';
import { Can } from '@/shared/auth/Can';
import { useClock } from '@/shared/clock/useClock';
import {
  EmptyState, FlightStatusTag, Mono, PercentText, UtcTime,
} from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';
import { GanttBoard, type ScaleKey } from './GanttBoard';

const STATUSES: FlightStatus[] = [
  'planned', 'in_work', 'ready_for_departure', 'in_flight', 'arrived', 'completed', 'cancelled', 'aog',
];

interface Filters {
  search: string;
  statuses: FlightStatus[];
  clientId: string | undefined;
  airport: string | undefined;
  unconfirmedOnly: boolean;
  lowMarginOnly: boolean;
}

const EMPTY_FILTERS: Filters = {
  search: '', statuses: [], clientId: undefined, airport: undefined,
  unconfirmedOnly: false, lowMarginOnly: false,
};

/**
 * Суточный план полётов `[ТЗ 3.1.1]`.
 *
 * Два представления одних и тех же данных: планшет Gantt для оперативного
 * контроля загрузки парка и плотная таблица с фильтрами для работы со списком.
 */
export function SchedulePage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { nowUtc } = useClock();

  const [view, setView] = useState<'gantt' | 'table'>('gantt');
  const [scale, setScale] = useState<ScaleKey>('day');
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);

  const origin = useMemo(() => {
    const base = new Date(nowUtc ?? 0);
    base.setUTCHours(base.getUTCHours() - (scale === 'day' ? 4 : scale === 'threeDays' ? 12 : 24), 0, 0, 0);
    return base;
  }, [nowUtc, scale]);

  const filtered = useMemo(() => {
    const query = filters.search.trim().toLowerCase();
    return FLIGHT_LIST.filter((flight) => {
      if (query) {
        const haystack = `${flight.number} ${flight.clientName ?? ''} ${flight.depIcao} ${flight.arrIcao} ${flight.aircraftRegistration ?? ''}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      if (filters.statuses.length > 0 && !filters.statuses.includes(flight.status)) return false;
      if (filters.clientId && flight.clientId !== filters.clientId) return false;
      if (filters.airport && flight.depIcao !== filters.airport && flight.arrIcao !== filters.airport) return false;
      if (filters.unconfirmedOnly && (flight.unconfirmedServicesCount ?? 0) === 0) return false;
      if (filters.lowMarginOnly) {
        const margin = flight.marginPercent === null || flight.marginPercent === undefined
          ? null
          : Number.parseFloat(flight.marginPercent);
        if (margin === null || margin >= 12) return false;
      }
      return true;
    });
  }, [filters]);

  const columns: ColumnsType<FlightListItem> = [
    {
      title: t('flight.number'), dataIndex: 'number', width: 110, fixed: 'left',
      sorter: (a, b) => a.number.localeCompare(b.number),
      render: (value: string, row) => (
        <Space size={4}>
          <Link to={`/flights/${row.id}`}>
            <Mono>{value}</Mono>
          </Link>
          {row.hasConflicts ? (
            <Tooltip title={t('schedule.hasConflict')}>
              <WarningOutlined style={{ color: STATUS_TOKENS.critical.color }} />
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: t('flight.std'), dataIndex: 'stdUtc', width: 96,
      defaultSortOrder: 'ascend',
      sorter: (a, b) => a.stdUtc.localeCompare(b.stdUtc),
      render: (value: string) => <UtcTime value={value} withDate />,
    },
    {
      title: t('flight.sta'), dataIndex: 'staUtc', width: 96,
      render: (value: string) => <UtcTime value={value} withDate />,
    },
    {
      title: t('flight.route'), key: 'route', width: 120,
      render: (_, row) => (
        <Mono>
          {row.depIcao} → {row.arrIcao}
        </Mono>
      ),
    },
    {
      title: t('flight.aircraft'), dataIndex: 'aircraftRegistration', width: 108,
      render: (value: string | null) =>
        value ? <Mono>{value}</Mono> : <Tag>{t('schedule.noAircraft')}</Tag>,
    },
    {
      title: t('flight.client'), dataIndex: 'clientName', ellipsis: true,
      sorter: (a, b) => (a.clientName ?? '').localeCompare(b.clientName ?? ''),
    },
    {
      title: t('flight.type'), dataIndex: 'type', width: 104,
      render: (value: string) => t(`flightType.${value}`),
    },
    {
      title: t('flight.status'), dataIndex: 'status', width: 150,
      render: (value: string) => <FlightStatusTag status={value} />,
    },
    {
      title: t('flight.unconfirmed'), dataIndex: 'unconfirmedServicesCount', width: 86, align: 'center',
      sorter: (a, b) => (a.unconfirmedServicesCount ?? 0) - (b.unconfirmedServicesCount ?? 0),
      render: (value: number) =>
        value > 0 ? (
          <Tag color="orange" style={{ margin: 0 }}>{value}</Tag>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: t('flight.margin'), dataIndex: 'marginPercent', width: 94, align: 'right',
      sorter: (a, b) => Number.parseFloat(a.marginPercent ?? '0') - Number.parseFloat(b.marginPercent ?? '0'),
      render: (value: string | null) => <PercentText value={value} colorBySign threshold={12} />,
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row align="middle" gutter={[8, 8]} wrap>
        <Col flex="auto">
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('nav.schedule')}
          </Typography.Title>
        </Col>
        <Col>
          <Space size={8} wrap>
            <Segmented
              value={view}
              onChange={(value) => {
                setView(value as 'gantt' | 'table');
              }}
              options={[
                { label: t('schedule.gantt'), value: 'gantt' },
                { label: t('schedule.table'), value: 'table' },
              ]}
            />
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
          </Space>
        </Col>
      </Row>

      {CONFLICTS.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={t('schedule.conflictsFound', { count: CONFLICTS.length })}
          description={
            <Space direction="vertical" size={2}>
              {CONFLICTS.map((conflict, index) => (
                <Space key={index} size={6}>
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
                  <Link to={`/flights/${conflict.flightId}`}>{conflict.message}</Link>
                </Space>
              ))}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('schedule.conflictHint')}
              </Typography.Text>
            </Space>
          }
        />
      ) : null}

      <Card size="small" styles={{ body: { padding: 10 } }}>
        <Row gutter={[8, 8]} align="middle" wrap>
          <Col xs={24} md={6}>
            <Input.Search
              allowClear
              placeholder={t('schedule.searchPlaceholder')}
              value={filters.search}
              onChange={(e) => {
                setFilters((f) => ({ ...f, search: e.target.value }));
              }}
            />
          </Col>
          <Col xs={12} md={5}>
            <Select
              mode="multiple" allowClear maxTagCount="responsive" style={{ width: '100%' }}
              placeholder={t('flight.status')}
              value={filters.statuses}
              onChange={(value: FlightStatus[]) => {
                setFilters((f) => ({ ...f, statuses: value }));
              }}
              options={STATUSES.map((status) => ({ value: status, label: t(`flightStatus.${status}`) }))}
            />
          </Col>
          <Col xs={12} md={5}>
            <Select
              allowClear showSearch optionFilterProp="label" style={{ width: '100%' }}
              placeholder={t('flight.client')}
              value={filters.clientId}
              onChange={(value: string | undefined) => {
                setFilters((f) => ({ ...f, clientId: value }));
              }}
              options={CLIENTS.map((client) => ({ value: client.id, label: client.name }))}
            />
          </Col>
          <Col xs={12} md={4}>
            <Select
              allowClear showSearch optionFilterProp="label" style={{ width: '100%' }}
              placeholder={t('flight.airport')}
              value={filters.airport}
              onChange={(value: string | undefined) => {
                setFilters((f) => ({ ...f, airport: value }));
              }}
              options={AIRPORTS.map((airport) => ({
                value: airport.icao, label: `${airport.icao} — ${airport.city}`,
              }))}
            />
          </Col>
          <Col xs={24} md={4}>
            <Space size={4} wrap>
              <Tag.CheckableTag
                checked={filters.unconfirmedOnly}
                onChange={(checked) => {
                  setFilters((f) => ({ ...f, unconfirmedOnly: checked }));
                }}
              >
                {t('schedule.filterUnconfirmed')}
              </Tag.CheckableTag>
              <Tag.CheckableTag
                checked={filters.lowMarginOnly}
                onChange={(checked) => {
                  setFilters((f) => ({ ...f, lowMarginOnly: checked }));
                }}
              >
                {t('schedule.filterLowMargin')}
              </Tag.CheckableTag>
            </Space>
          </Col>
        </Row>
      </Card>

      {view === 'gantt' ? (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space size={8} wrap>
            <Radio.Group
              size="small" optionType="button"
              value={scale}
              onChange={(e) => {
                setScale(e.target.value as ScaleKey);
              }}
              options={[
                { label: t('schedule.scaleDay'), value: 'day' },
                { label: t('schedule.scaleThreeDays'), value: 'threeDays' },
                { label: t('schedule.scaleWeek'), value: 'week' },
              ]}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('schedule.ganttHint')}
            </Typography.Text>
          </Space>
          {filtered.length === 0 ? (
            <Card><EmptyState description={t('schedule.emptyFiltered')} /></Card>
          ) : (
            <GanttBoard flights={filtered} scale={scale} originUtc={origin} />
          )}
        </Space>
      ) : (
        <Card size="small" styles={{ body: { padding: 0 } }}>
          <Table<FlightListItem>
            size="small"
            rowKey="id"
            columns={columns}
            dataSource={filtered}
            scroll={{ x: 1100 }}
            pagination={{ pageSize: 25, showSizeChanger: true, size: 'small' }}
            rowSelection={{ type: 'checkbox' }}
            locale={{ emptyText: <EmptyState description={t('schedule.emptyFiltered')} /> }}
            footer={() => (
              <Space size={8} wrap>
                <Typography.Text type="secondary">
                  {t('schedule.selectedActions')}
                </Typography.Text>
                <Button size="small" icon={<ExportOutlined />}>
                  {t('schedule.exportXlsx')}
                </Button>
                <Can permission="flight.status">
                  <Button size="small">{t('schedule.bulkStatus')}</Button>
                </Can>
                <Can permission="vendor.assign">
                  <Button size="small">{t('schedule.bulkVendor')}</Button>
                </Can>
              </Space>
            )}
          />
        </Card>
      )}
    </Space>
  );
}
