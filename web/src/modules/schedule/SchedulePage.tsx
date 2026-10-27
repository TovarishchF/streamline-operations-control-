import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  App, Button, Card, Checkbox, Dropdown, Input, InputNumber, Modal, Popover, Segmented, Select,
  Space, Tag, Tooltip, Typography,
} from 'antd';
import type { SorterResult } from 'antd/es/table/interface';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import {
  CalendarOutlined, ExportOutlined, PlusOutlined, SaveOutlined, SearchOutlined,
  SettingOutlined, WarningOutlined,
} from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useAircraftTypes, useAirports } from '@/api/catalog';
import {
  useExportSchedule,
  useFlights,
  useScheduleConflicts,
  type FlightFilters,
  type FlightRow,
  type FlightStatus,
} from '@/api/flights';
import { ApiError } from '@/api/client';
import { useClients } from '@/api/counterparties';
import { useFleet } from '@/api/fleet';
import { Can } from '@/shared/auth/Can';
import { useCurrentUser, usePermission } from '@/shared/auth/session';
import { QueryState } from '@/shared/ui/QueryState';
import { useClock, formatUtc } from '@/shared/clock/useClock';
import { useLocalizedName } from '@/shared/i18n/useLocalizedName';
import { DateOnlyPicker } from '@/shared/ui/DateTimePicker';
import { PageHeader } from '@/shared/ui/PageHeader';
import {
  EmptyState, FlightStatusTag, Mono, PercentText, StatusPill, UtcTime,
} from '@/shared/ui/primitives';
import { STATUS_TOKENS, type StatusToken } from '@/shared/ui/status-tokens';
import { BulkActionsModal } from './BulkActionsModal';
import { GanttBoard, SCALE_HOURS, type ScaleKey } from './GanttBoard';
import {
  EMPTY_FILTERS,
  loadHiddenColumns,
  loadPresets,
  saveHiddenColumns,
  savePresets,
  type SchedulePreset,
  type TableFilters,
} from './presets';

dayjs.extend(utc);

const STATUSES: FlightStatus[] = [
  'planned', 'in_work', 'ready_for_departure', 'in_flight', 'arrived', 'completed', 'cancelled', 'aog',
];

const FLIGHT_TYPES = ['charter', 'ferry', 'ambulance', 'cargo', 'technical'] as const;

/** Легенда планшета: цвет полосы — семантика статуса. */
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

/** Сколько часов до «сейчас» показывает окно масштаба. */
const LEAD_HOURS: Record<ScaleKey, number> = { day: 4, threeDays: 12, week: 24 };

const PAGE_SIZE = 50;

/** Колонки, которые можно скрыть; номер рейса остаётся всегда. */
const OPTIONAL_COLUMNS = [
  'stdUtc', 'staUtc', 'route', 'aircraftRegistration', 'clientName', 'type', 'status',
  'unconfirmedServicesCount', 'marginPercent',
] as const;

/** Отбор таблицы → параметры `GET /flights` (`SPEC.md § 4.2`). */
function toQuery(filters: TableFilters, canSeeMargin: boolean): FlightFilters {
  return {
    search: filters.search.trim(),
    status: filters.statuses.join(','),
    ...(filters.from ? { from: `${filters.from}T00:00:00Z` } : {}),
    ...(filters.to ? { to: `${filters.to}T23:59:59Z` } : {}),
    ...(filters.clientId ? { clientId: filters.clientId } : {}),
    ...(filters.aircraftId ? { aircraftId: filters.aircraftId } : {}),
    ...(filters.aircraftTypeId ? { aircraftTypeId: filters.aircraftTypeId } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.airport ? { airport: filters.airport } : {}),
    ...(filters.unconfirmed === 'any'
      ? {}
      : { hasUnconfirmedServices: filters.unconfirmed === 'yes' }),
    ...(canSeeMargin && filters.marginBelow ? { marginBelowPercent: filters.marginBelow } : {}),
  };
}

/**
 * Суточный план полётов `[ТЗ 3.1.1]`.
 *
 * Два представления одних и тех же данных: планшет для оперативного
 * контроля загрузки парка (`SPEC.md § 4.1`) и плотная таблица с фильтрами
 * для работы со списком (`SPEC.md § 4.2`). Отбор и сортировку выполняет
 * сервер: расписание листается постранично, и сортировать одну страницу
 * значило бы показать порядок, которого нет.
 */
export function SchedulePage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const localized = useLocalizedName();
  const { nowUtc } = useClock();
  const user = useCurrentUser();
  const userId = user?.id ?? 'anonymous';
  const canSeeMargin = usePermission('billing.margin.view');

  const [view, setView] = useState<'gantt' | 'table'>('gantt');
  const [scale, setScale] = useState<ScaleKey>('day');
  // Дата плана в UTC (`YYYY-MM-DD`); `null` — окно от текущего момента.
  const [planDate, setPlanDate] = useState<string | null>(null);
  const [filters, setFilters] = useState<TableFilters>(EMPTY_FILTERS);
  const [ordering, setOrdering] = useState<string>('stdUtc');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkMode, setBulkMode] = useState<'status' | 'vendor' | null>(null);
  const [presets, setPresets] = useState<SchedulePreset[]>([]);
  const [presetName, setPresetName] = useState('');
  const [savingPreset, setSavingPreset] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);

  useEffect(() => {
    void loadPresets(userId).then(setPresets);
    void loadHiddenColumns(userId).then((keys) => {
      if (keys) setHidden(keys);
    });
  }, [userId]);

  const exportSchedule = useExportSchedule();
  const todayUtc = nowUtc.toISOString().slice(0, 10);
  // Значение календаря пересоздаётся только при смене даты: часы
  // перерисовывают экран каждую секунду, и новый объект на каждом тике
  // возвращал открытую панель к выбранному месяцу.
  const pickerValue = useMemo(() => dayjs.utc(planDate ?? todayUtc), [planDate, todayUtc]);

  // Окно планшета от «сейчас» пересчитывается раз в час, а не каждую
  // секунду: иначе планшет сдвигался бы под рукой диспетчера.
  const nowHour = Math.floor(nowUtc.getTime() / 3_600_000);
  const origin = useMemo(() => {
    if (planDate !== null) return new Date(`${planDate}T00:00:00Z`);
    return new Date((nowHour - LEAD_HOURS[scale]) * 3_600_000);
  }, [nowHour, planDate, scale]);
  const loadedFrom = useMemo(() => new Date(origin.getTime() - LOOKBACK_MS), [origin]);
  const windowEndIso = new Date(origin.getTime() + SCALE_HOURS[scale] * 3_600_000).toISOString();

  const query = toQuery(filters, canSeeMargin);
  // Запрашивается только видимое представление: второй запрос впустую
  // нагружал бы сервер расчётом маржи и конфликтов по чужому отбору.
  const tableQuery = useFlights(
    { ...query, ordering, page, perPage: PAGE_SIZE },
    view === 'table',
  );
  const ganttQuery = useFlights(
    { ...query, from: loadedFrom.toISOString(), to: windowEndIso, perPage: 200 },
    view === 'gantt',
  );
  const active = view === 'gantt' ? ganttQuery : tableQuery;

  // Конфликты — по горизонту планирования, а не по странице: предупреждение
  // о пересечении не должно зависеть от того, какую страницу смотрит диспетчер.
  const conflicts = useScheduleConflicts().data?.data ?? [];
  const conflictToken: StatusToken = conflicts.some((c) => c.severity === 'blocking')
    ? 'critical'
    : 'warning';
  const airportsQuery = useAirports({ perPage: 200 });
  const clients = useClients().data?.data ?? [];
  const fleet = useFleet().data?.data ?? [];
  const aircraftTypes = useAircraftTypes().data?.data ?? [];

  const locale = i18n.language.startsWith('en') ? 'en-GB' : 'ru-RU';
  const planDay = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long',
  }).format(origin);

  const change = (patch: Partial<TableFilters>): void => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
    setSelected([]);
  };

  const runExport = async (): Promise<void> => {
    try {
      // Выгрузка берёт отбор и порядок экрана: в файл уходит та же таблица.
      const ticket = await exportSchedule.mutateAsync({ ...query, ordering });
      if (ticket.downloadUrl) {
        window.open(ticket.downloadUrl, '_blank', 'noopener');
      }
    } catch (error) {
      void message.error(error instanceof ApiError ? error.message : t('schedule.exportFailed'));
    }
  };

  const storePreset = async (): Promise<void> => {
    const name = presetName.trim();
    if (!name) return;
    const next = [...presets.filter((item) => item.name !== name), { name, filters }];
    await savePresets(userId, next);
    setPresets(next);
    setSavingPreset(false);
    setPresetName('');
    void message.success(t('schedule.presetSaved', { name }));
  };

  const removePreset = async (name: string): Promise<void> => {
    const next = presets.filter((item) => item.name !== name);
    await savePresets(userId, next);
    setPresets(next);
  };

  const toggleColumn = (key: string, visible: boolean): void => {
    const next = visible ? hidden.filter((item) => item !== key) : [...hidden, key];
    setHidden(next);
    void saveHiddenColumns(userId, next);
  };

  const sortOrder = (key: string): 'ascend' | 'descend' | null =>
    ordering === key ? 'ascend' : ordering === `-${key}` ? 'descend' : null;

  const allColumns: DataColumns<FlightRow> = [
    {
      title: t('flight.number'), key: 'number', dataIndex: 'number', width: 120, fixed: 'left',
      sorter: true, sortOrder: sortOrder('number'),
      render: (value: string, row) => (
        <Space size={4}>
          <Link to={`/flights/${row.id}`}>
            <Mono>{value}</Mono>
          </Link>
          {row.hasConflicts ? (
            <Tooltip title={t('schedule.hasConflict')}>
              <WarningOutlined
                aria-label={t('schedule.hasConflict')}
                style={{ color: STATUS_TOKENS.critical.color }}
              />
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: t('flight.std'), key: 'stdUtc', dataIndex: 'stdUtc', width: 110,
      sorter: true, sortOrder: sortOrder('stdUtc'),
      render: (value: string) => <UtcTime value={value} withDate />,
    },
    {
      title: t('flight.sta'), key: 'staUtc', dataIndex: 'staUtc', width: 110,
      sorter: true, sortOrder: sortOrder('staUtc'),
      render: (value: string) => <UtcTime value={value} withDate />,
    },
    {
      title: t('flight.route'), key: 'route', width: 130,
      // Маршрут сортируется по аэропорту вылета.
      sorter: true, sortOrder: sortOrder('depIcao'),
      render: (_, row) => <Mono>{row.depIcao} → {row.arrIcao}</Mono>,
    },
    {
      title: t('flight.aircraft'), key: 'aircraftRegistration', dataIndex: 'aircraftRegistration',
      width: 116, sorter: true, sortOrder: sortOrder('aircraftRegistration'),
      render: (value: string | null) =>
        value ? <Mono>{value}</Mono> : <Tag>{t('schedule.noAircraft')}</Tag>,
    },
    {
      title: t('flight.client'), key: 'clientName', dataIndex: 'clientName', ellipsis: true,
      sorter: true, sortOrder: sortOrder('clientName'),
    },
    {
      title: t('flight.type'), key: 'type', dataIndex: 'type', width: 110,
      sorter: true, sortOrder: sortOrder('type'),
      render: (value: string) => t(`flightType.${value}`),
    },
    {
      title: t('flight.status'), key: 'status', dataIndex: 'status', width: 160,
      sorter: true, sortOrder: sortOrder('status'),
      render: (value: string) => <FlightStatusTag status={value} />,
    },
    {
      title: t('flight.unconfirmed'), key: 'unconfirmedServicesCount',
      dataIndex: 'unconfirmedServicesCount', width: 96, align: 'center',
      sorter: true, sortOrder: sortOrder('unconfirmedServicesCount'),
      render: (value: number) =>
        value > 0 ? (
          <Tag color="orange" style={{ margin: 0 }}>{value}</Tag>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    ...(canSeeMargin
      ? ([
          {
            title: t('flight.margin'), key: 'marginPercent', dataIndex: 'marginPercent',
            width: 100, align: 'right', sorter: true, sortOrder: sortOrder('marginPercent'),
            render: (value: string | null) => <PercentText value={value} colorBySign />,
          },
        ] as DataColumns<FlightRow>)
      : []),
  ];
  const columns = allColumns.filter((column) => !hidden.includes(String(column.key)));

  const filterBar = (
    <div className="soc-filters">
      <Input
        allowClear
        prefix={<SearchOutlined />}
        style={{ width: 260, maxWidth: '100%' }}
        placeholder={t('schedule.searchPlaceholder')}
        aria-label={t('common.search')}
        value={filters.search}
        onChange={(e) => {
          change({ search: e.target.value });
        }}
      />
      {view === 'table' ? (
        <>
          <DateOnlyPicker
            aria-label={t('schedule.periodFrom')}
            placeholder={t('schedule.periodFrom')}
            value={filters.from ? dayjs.utc(filters.from) : null}
            onChange={(value) => {
              change({ from: value ? value.format('YYYY-MM-DD') : undefined });
            }}
          />
          <DateOnlyPicker
            aria-label={t('schedule.periodTo')}
            placeholder={t('schedule.periodTo')}
            value={filters.to ? dayjs.utc(filters.to) : null}
            onChange={(value) => {
              change({ to: value ? value.format('YYYY-MM-DD') : undefined });
            }}
          />
        </>
      ) : null}
      <Select
        mode="multiple" allowClear maxTagCount="responsive" style={{ width: 170, maxWidth: '100%' }}
        placeholder={t('flight.status')}
        aria-label={t('flight.status')}
        value={filters.statuses}
        onChange={(value: FlightStatus[]) => {
          change({ statuses: value });
        }}
        options={STATUSES.map((status) => ({ value: status, label: t(`flightStatus.${status}`) }))}
      />
      <Select
        allowClear showSearch optionFilterProp="label" style={{ width: 180, maxWidth: '100%' }}
        placeholder={t('flight.client')}
        aria-label={t('flight.client')}
        value={filters.clientId}
        onChange={(value: string | undefined) => {
          change({ clientId: value });
        }}
        options={clients.map((client) => ({ value: client.id, label: client.name }))}
      />
      <Select
        allowClear showSearch optionFilterProp="label" style={{ width: 140, maxWidth: '100%' }}
        placeholder={t('flight.aircraft')}
        aria-label={t('flight.aircraft')}
        value={filters.aircraftId}
        onChange={(value: string | undefined) => {
          change({ aircraftId: value });
        }}
        options={fleet.map((aircraft) => ({ value: aircraft.id, label: aircraft.registration }))}
      />
      <Select
        allowClear showSearch optionFilterProp="label" style={{ width: 170, maxWidth: '100%' }}
        placeholder={t('fleet.type')}
        aria-label={t('fleet.type')}
        value={filters.aircraftTypeId}
        onChange={(value: string | undefined) => {
          change({ aircraftTypeId: value });
        }}
        options={aircraftTypes.map((type) => ({
          value: type.id,
          label: `${type.icaoType} · ${localized(type.name)}`,
        }))}
      />
      <Select
        allowClear style={{ width: 140, maxWidth: '100%' }}
        placeholder={t('flight.type')}
        aria-label={t('flight.type')}
        value={filters.type}
        onChange={(value: string | undefined) => {
          change({ type: value });
        }}
        options={FLIGHT_TYPES.map((type) => ({ value: type, label: t(`flightType.${type}`) }))}
      />
      <Select
        allowClear showSearch optionFilterProp="label" style={{ width: 150, maxWidth: '100%' }}
        placeholder={t('flight.airport')}
        aria-label={t('flight.airport')}
        value={filters.airport}
        onChange={(value: string | undefined) => {
          change({ airport: value });
        }}
        options={(airportsQuery.data?.data ?? []).map((airport) => ({
          value: airport.icao,
          label: `${airport.icao} — ${airport.city}`,
        }))}
      />
      <Select
        style={{ width: 230, maxWidth: '100%' }}
        aria-label={t('schedule.filterUnconfirmed')}
        value={filters.unconfirmed}
        onChange={(value: TableFilters['unconfirmed']) => {
          change({ unconfirmed: value });
        }}
        options={[
          { value: 'any', label: t('schedule.unconfirmedAny') },
          { value: 'yes', label: t('schedule.filterUnconfirmed') },
          { value: 'no', label: t('schedule.unconfirmedNone') },
        ]}
      />
      {canSeeMargin ? (
        <InputNumber<string>
          stringMode
          min="-100"
          max="100"
          style={{ width: 170, maxWidth: '100%' }}
          addonBefore={t('schedule.marginBelow')}
          addonAfter="%"
          aria-label={t('schedule.marginBelow')}
          value={filters.marginBelow ?? null}
          onChange={(value) => {
            change({ marginBelow: value ?? undefined });
          }}
        />
      ) : null}
      <Dropdown
        trigger={['click']}
        menu={{
          items: [
            ...presets.map((preset) => ({
              key: `apply:${preset.name}`,
              label: preset.name,
              extra: (
                <Button
                  type="link"
                  size="small"
                  aria-label={t('schedule.presetRemove', { name: preset.name })}
                  onClick={(event) => {
                    event.stopPropagation();
                    void removePreset(preset.name);
                  }}
                >
                  {t('common.remove')}
                </Button>
              ),
            })),
            ...(presets.length > 0 ? [{ type: 'divider' as const }] : []),
            { key: 'save', label: t('schedule.presetSave'), icon: <SaveOutlined /> },
            { key: 'reset', label: t('schedule.filtersReset') },
          ],
          onClick: ({ key }) => {
            if (key === 'save') setSavingPreset(true);
            else if (key === 'reset') change(EMPTY_FILTERS);
            else {
              const preset = presets.find((item) => `apply:${item.name}` === key);
              if (preset) change(preset.filters);
            }
          },
        }}
      >
        <Button>{t('schedule.presets')}</Button>
      </Dropdown>
    </div>
  );

  return (
    <>
      <PageHeader
        title={t('nav.schedule')}
        meta={
          <>
            <span>
              {planDay.charAt(0).toLocaleUpperCase(locale) + planDay.slice(1)} ·{' '}
              {t(`schedule.window.${scale}`, { time: formatUtc(origin) })}
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
                setSelected([]);
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
                const day = value?.format('YYYY-MM-DD') ?? todayUtc;
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
                    token={conflict.severity === 'blocking' ? 'critical' : 'warning'}
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

      {filterBar}

      <QueryState query={active}>
        {(paged) =>
          view === 'gantt' ? (
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
                <Space size={8} wrap>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('schedule.nowLabel', { time: formatUtc(nowUtc) })}
                  </Typography.Text>
                  <Button
                    size="small"
                    onClick={() => {
                      setPlanDate(null);
                    }}
                  >
                    {t('schedule.now')}
                  </Button>
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
                </Space>
              </div>
              <GanttBoard
                flights={paged.data}
                scale={scale}
                originUtc={origin}
                loadedFromUtc={loadedFrom}
              />
              {paged.meta.total > paged.data.length ? (
                <Typography.Text type="warning" style={{ fontSize: 12 }}>
                  {t('schedule.ganttTruncated', { shown: paged.data.length, total: paged.meta.total })}
                </Typography.Text>
              ) : null}
            </>
          ) : (
            <Card size="small" styles={{ body: { padding: 0 } }}>
              <DataTable<FlightRow>
                size="small"
                rowKey="id"
                columns={columns}
                dataSource={paged.data}
                scroll={{ x: 1100 }}
                pagination={{
                  current: page,
                  pageSize: PAGE_SIZE,
                  total: paged.meta.total,
                  showSizeChanger: false,
                  size: 'small',
                }}
                onChange={(pagination, _filters, sorter) => {
                  setPage(pagination.current ?? 1);
                  const single = (Array.isArray(sorter) ? sorter[0] : sorter) as
                    | SorterResult<FlightRow>
                    | undefined;
                  if (!single?.order) {
                    setOrdering('stdUtc');
                    return;
                  }
                  const key = single.columnKey === 'route' ? 'depIcao' : String(single.columnKey);
                  setOrdering(single.order === 'descend' ? `-${key}` : key);
                }}
                rowSelection={{
                  type: 'checkbox',
                  selectedRowKeys: selected,
                  onChange: (keys) => {
                    setSelected(keys.map(String));
                  },
                }}
                locale={{ emptyText: <EmptyState description={t('schedule.emptyFiltered')} /> }}
                title={() => (
                  <Space size={8} wrap style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Typography.Text type="secondary">
                      {t('schedule.totalFlights', { count: paged.meta.total })}
                    </Typography.Text>
                    <Popover
                      trigger="click"
                      placement="bottomRight"
                      content={
                        <Space direction="vertical" size={4}>
                          {OPTIONAL_COLUMNS.filter(
                            (key) => key !== 'marginPercent' || canSeeMargin,
                          ).map((key) => (
                            <Checkbox
                              key={key}
                              checked={!hidden.includes(key)}
                              onChange={(event) => {
                                toggleColumn(key, event.target.checked);
                              }}
                            >
                              {t(`schedule.column.${key}`)}
                            </Checkbox>
                          ))}
                        </Space>
                      }
                    >
                      <Button size="small" icon={<SettingOutlined />}>
                        {t('schedule.columns')}
                      </Button>
                    </Popover>
                  </Space>
                )}
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
          )
        }
      </QueryState>

      <BulkActionsModal
        mode={bulkMode}
        flights={(tableQuery.data?.data ?? []).filter((flight) => selected.includes(flight.id))}
        onClose={() => {
          setBulkMode(null);
          setSelected([]);
        }}
      />

      <Modal
        open={savingPreset}
        title={t('schedule.presetSave')}
        okText={t('common.save')}
        okButtonProps={{ disabled: presetName.trim() === '' }}
        cancelText={t('common.cancel')}
        onCancel={() => {
          setSavingPreset(false);
        }}
        onOk={() => {
          void storePreset();
        }}
      >
        <Input
          autoFocus
          value={presetName}
          placeholder={t('schedule.presetName')}
          aria-label={t('schedule.presetName')}
          onChange={(event) => {
            setPresetName(event.target.value);
          }}
          onPressEnter={() => {
            void storePreset();
          }}
        />
      </Modal>
    </>
  );
}
