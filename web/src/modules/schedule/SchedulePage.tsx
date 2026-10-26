import { useMemo, useState, type JSX } from 'react';
import {
  App, Button, Card, Input, Segmented, Select, Space, Tag, Tooltip, Typography,
} from 'antd';
import dayjs from 'dayjs';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import {
  CalendarOutlined, ExportOutlined, PlusOutlined, SearchOutlined, WarningOutlined,
} from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useAirports } from '@/api/catalog';
import {
  useExportSchedule,
  useFlights,
  useScheduleConflicts,
  type FlightRow,
} from '@/api/flights';
import { ApiError } from '@/api/client';
import type { FlightStatus } from '@/api/types';
import { useClients } from '@/api/counterparties';
import { Can } from '@/shared/auth/Can';
import { QueryState } from '@/shared/ui/QueryState';
import { useClock, formatUtc } from '@/shared/clock/useClock';
import { DateOnlyPicker } from '@/shared/ui/DateTimePicker';
import { PageHeader } from '@/shared/ui/PageHeader';
import {
  EmptyState, FlightStatusTag, Mono, PercentText, StatusPill, UtcTime,
} from '@/shared/ui/primitives';
import { STATUS_TOKENS, type StatusToken } from '@/shared/ui/status-tokens';
import { BulkActionsModal } from './BulkActionsModal';
import { GanttBoard, SCALE_HOURS, type ScaleKey } from './GanttBoard';

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

/** Легенда планшета: цвет полосы — семантика статуса (макет, карточка GanttBoard). */
const LEGEND: Array<{ token: StatusToken; status: FlightStatus }> = [
  { token: 'neutral', status: 'planned' },
  { token: 'progress', status: 'in_work' },
  { token: 'ready', status: 'ready_for_departure' },
  { token: 'active', status: 'in_flight' },
  { token: 'done', status: 'completed' },
];

/**
 * Рейс, вылетевший до начала окна, ещё может быть в воздухе: выборка
 * берёт сутки до окна, иначе его полоса пропала бы с планшета.
 */
const LOOKBACK_MS = 24 * 3_600_000;

/**
 * Суточный план полётов `[ТЗ 3.1.1]`.
 *
 * Два представления одних и тех же данных: планшет Gantt для оперативного
 * контроля загрузки парка и плотная таблица с фильтрами для работы со списком.
 *
 * Отбор по тексту, статусу, клиенту и аэропорту выполняет сервер: расписание
 * листается постранично, и выкачивать его целиком ради фильтра нельзя.
 * Признак «есть неподтверждённые услуги» отбирается на клиенте — он уже
 * посчитан в строке, и лишний запрос ради него не нужен.
 */
export function SchedulePage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { nowUtc } = useClock();

  const [view, setView] = useState<'gantt' | 'table'>('gantt');
  const [scale, setScale] = useState<ScaleKey>('day');
  // Дата плана в UTC (`YYYY-MM-DD`); `null` — окно от текущего момента.
  const [planDate, setPlanDate] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkMode, setBulkMode] = useState<'status' | 'vendor' | null>(null);

  const { message } = App.useApp();
  const exportSchedule = useExportSchedule();
  const todayUtc = nowUtc.toISOString().slice(0, 10);
  // Значение календаря пересоздаётся только при смене даты: часы
  // перерисовывают экран каждую секунду, и новый объект на каждом тике
  // возвращал открытую панель к выбранному месяцу.
  const pickerValue = useMemo(() => dayjs(planDate ?? todayUtc), [planDate, todayUtc]);

  const origin = useMemo(() => {
    if (planDate !== null) return new Date(`${planDate}T00:00:00Z`);
    const base = new Date(nowUtc);
    base.setUTCHours(base.getUTCHours() - (scale === 'day' ? 4 : scale === 'threeDays' ? 12 : 24), 0, 0, 0);
    return base;
  }, [nowUtc, planDate, scale]);
  const originIso = origin.toISOString();
  const windowEndIso = new Date(origin.getTime() + SCALE_HOURS[scale] * 3_600_000).toISOString();

  // Планшет берёт рейсы своего окна; таблица — весь список, как раньше.
  const query = useFlights({
    search: filters.search.trim(),
    status: filters.statuses.join(','),
    ...(filters.clientId ? { clientId: filters.clientId } : {}),
    ...(filters.airport ? { airport: filters.airport } : {}),
    ...(view === 'gantt'
      ? { from: new Date(origin.getTime() - LOOKBACK_MS).toISOString(), to: windowEndIso }
      : {}),
    perPage: 200,
  });
  // Конфликты приходят по всему горизонту планирования, а не по странице:
  // предупреждение о пересечении не должно зависеть от того, на какой
  // странице списка сейчас диспетчер.
  const conflicts = useScheduleConflicts().data?.data ?? [];
  const conflictToken: StatusToken = conflicts.some((c) => c.severity === 'critical')
    ? 'critical'
    : 'warning';
  const airportsQuery = useAirports({ perPage: 200 });
  const clients = useClients().data?.data ?? [];

  const locale = i18n.language.startsWith('en') ? 'en-GB' : 'ru-RU';
  const planDay = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(originIso));

  const runExport = async (): Promise<void> => {
    try {
      const ticket = await exportSchedule.mutateAsync({
        search: filters.search.trim(),
        status: filters.statuses.join(','),
        ...(filters.clientId ? { clientId: filters.clientId } : {}),
        ...(filters.airport ? { airport: filters.airport } : {}),
      });
      if (ticket.downloadUrl) {
        window.open(ticket.downloadUrl, '_blank', 'noopener');
      }
    } catch (error) {
      void message.error(
        error instanceof ApiError ? error.message : t('schedule.exportFailed'),
      );
    }
  };

  const filtered = useMemo(() => {
    const rows = query.data?.data ?? [];
    return rows.filter((flight) => {
      if (filters.unconfirmedOnly && flight.unconfirmedServicesCount === 0) return false;
      if (filters.lowMarginOnly) {
        // Маржа появится вместе с биллингом (M7). Пока её нет, фильтр
        // не показывает ничего — это честнее, чем показать всё подряд.
        const margin = flight.marginPercent === null
          ? null
          : Number.parseFloat(flight.marginPercent);
        if (margin === null || margin >= 12) return false;
      }
      return true;
    });
  }, [filters.unconfirmedOnly, filters.lowMarginOnly, query.data]);

  const columns: DataColumns<FlightRow> = [
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
      sortBy: (row) => `${row.depIcao}-${row.arrIcao}`,
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
      sorter: (a, b) => a.clientName.localeCompare(b.clientName),
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
      sorter: (a, b) => a.unconfirmedServicesCount - b.unconfirmedServicesCount,
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
    <>
      <PageHeader
        title={t('nav.schedule')}
        meta={
          <>
            <span>
              {planDay.charAt(0).toLocaleUpperCase(locale) + planDay.slice(1)} ·{' '}
              {t(`schedule.window.${scale}`, { time: formatUtc(new Date(originIso)) })}
            </span>
            {conflicts.length > 0 ? (
              <StatusPill
                token={conflictToken}
                label={t('schedule.conflictCount', { count: conflicts.length })}
                size="sm"
              />
            ) : null}
          </>
        }
        actions={
          <>
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
            {/* Выбор сегодняшней даты возвращает окно к текущему моменту. */}
            <DateOnlyPicker
              className="soc-plan-date"
              aria-label={t('schedule.planDate')}
              value={pickerValue}
              allowClear={false}
              prefix={<CalendarOutlined />}
              suffixIcon={null}
              onChange={(value) => {
                const day = value.format('YYYY-MM-DD');
                setPlanDate(day === todayUtc ? null : day);
              }}
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
          </>
        }
      />

      {/* Карточка Banner: до четырёх конфликтов, примечание и одно действие. */}
      {conflicts.length > 0 ? (
        <div className={`soc-banner soc-banner--${conflictToken}`}>
          <WarningOutlined className="soc-banner__icon" />
          <div className="soc-banner__body">
            <div className="soc-banner__title">
              {t('schedule.conflictsFound', { count: conflicts.length })}
            </div>
            <ul className="soc-banner__list">
              {conflicts.slice(0, 4).map((conflict, index) => (
                <li key={`${conflict.flightId}:${String(index)}`}>
                  <StatusPill
                    token={conflict.severity === 'critical' ? 'critical' : 'warning'}
                    label={t(`conflictKind.${conflict.kind}`)}
                    size="sm"
                  />
                  <Link to={`/flights/${conflict.flightId}`}>{conflict.message}</Link>
                </li>
              ))}
            </ul>
            <div className="soc-banner__note">{t('schedule.conflictHint')}</div>
          </div>
          <Button
            size="small"
            onClick={() => {
              navigate(`/flights/${conflicts[0]?.flightId ?? ''}`);
            }}
          >
            {t('dashboard.resolve')}
          </Button>
        </div>
      ) : null}

      <div className="soc-filters">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          style={{ width: 280 }}
          placeholder={t('schedule.searchPlaceholder')}
          value={filters.search}
          onChange={(e) => {
            setFilters((f) => ({ ...f, search: e.target.value }));
          }}
        />
        <Select
          mode="multiple" allowClear maxTagCount="responsive" style={{ width: 160 }}
          placeholder={t('flight.status')}
          value={filters.statuses}
          onChange={(value: FlightStatus[]) => {
            setFilters((f) => ({ ...f, statuses: value }));
          }}
          options={STATUSES.map((status) => ({ value: status, label: t(`flightStatus.${status}`) }))}
        />
        <Select
          allowClear showSearch optionFilterProp="label" style={{ width: 180 }}
          placeholder={t('flight.client')}
          value={filters.clientId}
          onChange={(value: string | undefined) => {
            setFilters((f) => ({ ...f, clientId: value }));
          }}
          options={clients.map((client) => ({ value: client.id, label: client.name }))}
        />
        <Select
          allowClear showSearch optionFilterProp="label" style={{ width: 150 }}
          placeholder={t('flight.airport')}
          value={filters.airport}
          onChange={(value: string | undefined) => {
            setFilters((f) => ({ ...f, airport: value }));
          }}
          options={(airportsQuery.data?.data ?? []).map((airport) => ({
            value: airport.icao,
            label: `${airport.icao} — ${airport.city}`,
          }))}
        />
        <Button
          size="small"
          className={filters.unconfirmedOnly ? 'soc-toggle is-on' : 'soc-toggle'}
          aria-pressed={filters.unconfirmedOnly}
          onClick={() => {
            setFilters((f) => ({ ...f, unconfirmedOnly: !f.unconfirmedOnly }));
          }}
        >
          {t('schedule.filterUnconfirmed')}
        </Button>
        <Button
          size="small"
          className={filters.lowMarginOnly ? 'soc-toggle is-on' : 'soc-toggle'}
          aria-pressed={filters.lowMarginOnly}
          onClick={() => {
            setFilters((f) => ({ ...f, lowMarginOnly: !f.lowMarginOnly }));
          }}
        >
          {t('schedule.filterLowMargin')}
        </Button>
      </div>

      <QueryState query={query}>
      {() => view === 'gantt' ? (
        <>
          <div className="soc-gantt-toolbar">
            <div className="soc-legend">
              {LEGEND.map(({ token, status }) => (
                <span key={token}>
                  <i style={{ background: STATUS_TOKENS[token].dot }} />
                  {t(`flightStatus.${status}`)}
                </span>
              ))}
              <span>
                <i style={{ background: STATUS_TOKENS.critical.dot }} />
                {t('schedule.legendConflict')}
              </span>
            </div>
            <Segmented
              value={scale}
              onChange={(value) => {
                setScale(value as ScaleKey);
              }}
              options={[
                { label: t('schedule.scaleDay'), value: 'day' },
                { label: t('schedule.scaleThreeDays'), value: 'threeDays' },
                { label: t('schedule.scaleWeek'), value: 'week' },
              ]}
            />
          </div>
          {filtered.length === 0 ? (
            <Card><EmptyState description={t('schedule.emptyFiltered')} /></Card>
          ) : (
            <GanttBoard flights={filtered} scale={scale} originUtc={origin} />
          )}
        </>
      ) : (
        <Card size="small" styles={{ body: { padding: 0 } }}>
          <DataTable<FlightRow>
            size="small"
            rowKey="id"
            columns={columns}
            dataSource={filtered}
            scroll={{ x: 1100 }}
            pagination={{ pageSize: 25, showSizeChanger: true, size: 'small' }}
            rowSelection={{
              type: 'checkbox',
              selectedRowKeys: selected,
              onChange: (keys) => { setSelected(keys.map(String)); },
            }}
            locale={{ emptyText: <EmptyState description={t('schedule.emptyFiltered')} /> }}
            footer={() => (
              <Space size={8} wrap>
                <Typography.Text type="secondary">
                  {selected.length > 0
                    ? t('schedule.selectedCount', { count: selected.length })
                    : t('schedule.selectedActions')}
                </Typography.Text>
                {/* Выгрузка берёт отбор экрана, а не выделение: в файл уходит
                    та же таблица, которую человек видит. */}
                <Button
                  size="small"
                  icon={<ExportOutlined />}
                  loading={exportSchedule.isPending}
                  onClick={() => { void runExport(); }}
                >
                  {t('schedule.exportXlsx')}
                </Button>
                <Can permission="flight.status">
                  <Button
                    size="small"
                    disabled={selected.length === 0}
                    onClick={() => { setBulkMode('status'); }}
                  >
                    {t('schedule.bulkStatus')}
                  </Button>
                </Can>
                <Can permission="vendor.assign">
                  <Button
                    size="small"
                    disabled={selected.length === 0}
                    onClick={() => { setBulkMode('vendor'); }}
                  >
                    {t('schedule.bulkVendor')}
                  </Button>
                </Can>
              </Space>
            )}
          />
        </Card>
      )}
      </QueryState>

      <BulkActionsModal
        mode={bulkMode}
        flights={filtered.filter((flight) => selected.includes(flight.id))}
        onClose={() => {
          setBulkMode(null);
          setSelected([]);
        }}
      />
    </>
  );
}
