import { useMemo, useState, type JSX } from 'react';
import { Card, Segmented } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

import { MONO_STACK, SANS_STACK, SOC_COLORS } from '@/app/theme';
import { useFxRates, type FxSnapshot } from '@/api/billing';
import {
  change, dailyCandles, periodStats, weeklyCandles,
  type Candle, type Change, type Direction, type RatePoint,
} from '@/domain/fx';
import { useClock } from '@/shared/clock/useClock';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { EChart, type ChartOption } from '@/shared/ui/EChart';
import { Notice } from '@/shared/ui/Notice';
import { PageHeader } from '@/shared/ui/PageHeader';
import { DateText } from '@/shared/ui/primitives';
import { QueryState } from '@/shared/ui/QueryState';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

const PAIRS = ['USD', 'EUR'] as const;
type Pair = (typeof PAIRS)[number];

/** Периоды графика, дней — как переключатель на биржевом терминале. */
const RANGES = { '1W': 7, '1M': 31, '3M': 92, '6M': 183, '1Y': 366 } as const;
type RangeKey = keyof typeof RANGES;
const RANGE_KEYS = Object.keys(RANGES) as RangeKey[];

/** Дальше трёх месяцев дневные свечи сливаются в штрихи — свеча становится недельной. */
const WEEKLY_RANGES: ReadonlySet<RangeKey> = new Set(['6M', '1Y']);

/** История грузится за год одним запросом; периоды режутся на клиенте. */
const HISTORY_DAYS = 366;

/** Рост — зелёный, падение — красный: привычная биржевая пара цветов. */
const DIRECTION_COLOR: Record<Direction, string> = {
  up: STATUS_TOKENS.done.dot,
  down: STATUS_TOKENS.critical.dot,
  flat: SOC_COLORS.ink3,
};

function localeOf(language: string): string {
  return language.startsWith('en') ? 'en-GB' : 'ru-RU';
}

/**
 * Курс для подписи: четыре знака, как публикует ЦБ. Строка превращается
 * в число только для форматирования — арифметики здесь нет.
 */
function formatRate(value: string, locale: string, digits = 4): string {
  return Number(value).toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatChange(value: Change, locale: string): string {
  const sign = value.direction === 'down' ? '−' : value.direction === 'up' ? '+' : '';
  const abs = formatRate(value.abs.replace('-', ''), locale);
  const pct = value.pct === null ? '' : ` (${sign}${formatRate(value.pct.replace('-', ''), locale, 2)} %)`;
  return `${sign}${abs}${pct}`;
}

function shortDate(date: string, locale: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, {
    timeZone: 'UTC', day: '2-digit', month: '2-digit',
  });
}

function fullDate(date: string, locale: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, { timeZone: 'UTC' });
}

/** `#22a35a` → `rgba(34, 163, 90, a)` для заливки под линией. */
function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${String((value >> 16) & 255)}, ${String((value >> 8) & 255)}, ${String(value & 255)}, ${String(alpha)})`;
}

function ChangeText({ value, suffix }: { value: Change; suffix?: string }): JSX.Element {
  const { i18n } = useTranslation();
  const locale = localeOf(i18n.language);
  return (
    <span className={`soc-fx__change is-${value.direction}`}>
      {value.direction === 'up' ? <ArrowUpOutlined /> : null}
      {value.direction === 'down' ? <ArrowDownOutlined /> : null}
      {formatChange(value, locale)}
      {suffix ? <span className="soc-fx__change-note">{suffix}</span> : null}
    </span>
  );
}

/**
 * Настройки графика: линия с заливкой или свечи, перекрестье с подписями
 * на осях, ось цены справа и метка последнего курса — биржевой вид.
 *
 * Числа здесь — координаты точек для холста, не деньги: подписи и разницы
 * считаются из десятичных строк (`domain/fx.ts`).
 */
function buildOption({
  kind, points, candles, direction, locale, labels,
}: {
  kind: 'line' | 'candles';
  points: RatePoint[];
  candles: Candle[];
  direction: Direction;
  locale: string;
  labels: {
    rate: string;
    open: string;
    high: string;
    low: string;
    close: string;
    week: (date: string) => string;
  };
}): ChartOption {
  const color = DIRECTION_COLOR[direction];
  const last = points[points.length - 1]?.rate;
  const axisText = { color: SOC_COLORS.ink3, fontFamily: MONO_STACK, fontSize: 11 };
  const weekly = kind === 'candles' && candles.length < points.length;
  const dates = kind === 'line' ? points.map((p) => p.date) : candles.map((c) => c.date);

  const lastPrice = last
    ? {
        symbol: ['none', 'none'],
        silent: true,
        data: [{ yAxis: Number(last) }],
        lineStyle: { color, type: 'dashed', width: 1 },
        label: {
          position: 'end',
          formatter: formatRate(last, locale),
          color: '#ffffff',
          backgroundColor: color,
          padding: [3, 6],
          borderRadius: 4,
          fontFamily: MONO_STACK,
          fontSize: 11,
        },
      }
    : undefined;

  const tooltipRow = (label: string, value: string): string =>
    `<div style="display:flex;justify-content:space-between;gap:16px"><span style="color:${SOC_COLORS.ink2}">${label}</span><b>${value}</b></div>`;

  return {
    animation: false,
    grid: { left: 12, right: 76, top: 16, bottom: 28 },
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: kind === 'candles',
      axisLine: { lineStyle: { color: SOC_COLORS.line } },
      axisTick: { show: false },
      axisLabel: {
        ...axisText,
        hideOverlap: true,
        // Крайние подписи прижаты к краям: иначе первая обрезается полем.
        alignMinLabel: 'left',
        alignMaxLabel: 'right',
        formatter: (date: string) => shortDate(date, locale),
      },
    },
    yAxis: {
      type: 'value',
      position: 'right',
      scale: true,
      splitNumber: 5,
      axisLabel: { ...axisText, formatter: (value: number) => formatRate(String(value), locale, 2) },
      splitLine: { lineStyle: { color: SOC_COLORS.chartGrid } },
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        lineStyle: { color: SOC_COLORS.ink3, type: 'dashed' },
        crossStyle: { color: SOC_COLORS.ink3, type: 'dashed' },
        label: {
          backgroundColor: SOC_COLORS.chrome,
          fontFamily: MONO_STACK,
          fontSize: 11,
          formatter: (params: { axisDimension: string; value: string | number }) =>
            params.axisDimension === 'x'
              ? fullDate(String(params.value), locale)
              : formatRate(String(params.value), locale),
        },
      },
      backgroundColor: SOC_COLORS.surfaceRaised,
      borderColor: SOC_COLORS.line,
      padding: [8, 10],
      textStyle: { color: SOC_COLORS.ink, fontFamily: SANS_STACK, fontSize: 12 },
      formatter: (params: Array<{ dataIndex: number }>) => {
        const index = params[0]?.dataIndex ?? 0;
        if (kind === 'line') {
          const point = points[index];
          if (!point) return '';
          const previous = points[index - 1];
          const delta = previous ? change(previous.rate, point.rate) : null;
          return [
            `<div style="margin-bottom:4px;color:${SOC_COLORS.ink2}">${fullDate(point.date, locale)}</div>`,
            tooltipRow(labels.rate, formatRate(point.rate, locale)),
            delta
              ? `<div style="color:${DIRECTION_COLOR[delta.direction]};text-align:right">${formatChange(delta, locale)}</div>`
              : '',
          ].join('');
        }
        const candle = candles[index];
        if (!candle) return '';
        const delta = change(candle.open, candle.close);
        return [
          `<div style="margin-bottom:4px;color:${SOC_COLORS.ink2}">${weekly ? labels.week(candle.date) : fullDate(candle.date, locale)}</div>`,
          tooltipRow(labels.open, formatRate(candle.open, locale)),
          tooltipRow(labels.high, formatRate(candle.high, locale)),
          tooltipRow(labels.low, formatRate(candle.low, locale)),
          tooltipRow(labels.close, formatRate(candle.close, locale)),
          `<div style="color:${DIRECTION_COLOR[delta.direction]};text-align:right">${formatChange(delta, locale)}</div>`,
        ].join('');
      },
    },
    dataZoom: [{ type: 'inside' }],
    series: [
      kind === 'line'
        ? {
            type: 'line',
            data: points.map((p) => Number(p.rate)),
            showSymbol: false,
            symbolSize: 6,
            lineStyle: { width: 1.75, color },
            itemStyle: { color },
            areaStyle: {
              color: {
                type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                colorStops: [
                  { offset: 0, color: withAlpha(color, 0.22) },
                  { offset: 1, color: withAlpha(color, 0) },
                ],
              },
            },
            markLine: lastPrice,
          }
        : {
            type: 'candlestick',
            data: candles.map((c) => [Number(c.open), Number(c.close), Number(c.low), Number(c.high)]),
            barMaxWidth: 12,
            itemStyle: {
              color: DIRECTION_COLOR.up,
              color0: DIRECTION_COLOR.down,
              borderColor: DIRECTION_COLOR.up,
              borderColor0: DIRECTION_COLOR.down,
            },
            markLine: lastPrice,
          },
    ],
  };
}

interface Row {
  date: string;
  usd: string | undefined;
  usdChange: Change | null;
  eur: string | undefined;
  eurChange: Change | null;
}

function FxBoard({ snapshot }: { snapshot: FxSnapshot }): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = localeOf(i18n.language);
  const [pair, setPair] = useState<Pair>('USD');
  const [range, setRange] = useState<RangeKey>('3M');
  const [kind, setKind] = useState<'line' | 'candles'>('line');

  const history = useMemo(() => snapshot.history ?? [], [snapshot.history]);

  const series = useMemo(
    () =>
      history.flatMap((item) => {
        const rate = item.rates[pair];
        return rate ? [{ date: item.date, rate }] : [];
      }),
    [history, pair],
  );

  const visible = useMemo(() => {
    const last = series[series.length - 1];
    if (!last) return [];
    const from = new Date(`${last.date}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - RANGES[range]);
    const cutoff = from.toISOString().slice(0, 10);
    return series.filter((point) => point.date > cutoff);
  }, [series, range]);

  const stats = periodStats(visible);
  const latest = series[series.length - 1];
  const previous = series[series.length - 2];
  const day = latest && previous ? change(previous.rate, latest.rate) : null;

  const option = useMemo(
    () =>
      buildOption({
        kind,
        points: visible,
        candles: WEEKLY_RANGES.has(range) ? weeklyCandles(visible) : dailyCandles(visible),
        direction: stats?.change.direction ?? 'flat',
        locale,
        labels: {
          rate: t('fx.rate'),
          open: t('fx.open'),
          high: t('fx.high'),
          low: t('fx.low'),
          close: t('fx.close'),
          week: (date) => t('fx.weekOf', { date: fullDate(date, locale) }),
        },
      }),
    [kind, visible, range, stats?.change.direction, locale, t],
  );

  const rows: Row[] = useMemo(
    () =>
      history
        .map((item, index) => {
          const before = history[index - 1];
          const usd = item.rates['USD'];
          const eur = item.rates['EUR'];
          const usdBefore = before?.rates['USD'];
          const eurBefore = before?.rates['EUR'];
          return {
            date: item.date,
            usd,
            usdChange: usd && usdBefore ? change(usdBefore, usd) : null,
            eur,
            eurChange: eur && eurBefore ? change(eurBefore, eur) : null,
          };
        })
        .reverse(),
    [history],
  );

  const rateCell = (value: string | undefined): JSX.Element =>
    value ? <span>{formatRate(value, locale)}</span> : <span>—</span>;
  const changeCell = (value: Change | null): JSX.Element =>
    value ? <ChangeText value={value} /> : <span>—</span>;

  const columns: DataColumns<Row> = [
    {
      title: t('fx.date'), dataIndex: 'date', width: 130, minWidth: 110,
      render: (value: string) => <DateText value={value} />,
    },
    {
      title: 'USD/RUB', dataIndex: 'usd', align: 'right', width: 140, minWidth: 110,
      render: rateCell,
    },
    {
      title: t('fx.dayChange'), key: 'usdChange', align: 'right', width: 180, minWidth: 150,
      sortBy: (row) => (row.usdChange ? Number(row.usdChange.abs) : null),
      render: (_: unknown, row: Row) => changeCell(row.usdChange),
    },
    {
      title: 'EUR/RUB', dataIndex: 'eur', align: 'right', width: 140, minWidth: 110,
      render: rateCell,
    },
    {
      title: t('fx.dayChange'), key: 'eurChange', align: 'right', width: 180, minWidth: 150,
      sortBy: (row) => (row.eurChange ? Number(row.eurChange.abs) : null),
      render: (_: unknown, row: Row) => changeCell(row.eurChange),
    },
  ];

  return (
    <>
      {snapshot.staleSince ? (
        <Notice
          id={`fx.stale:${snapshot.staleSince}`}
          type="warning"
          showIcon
          message={t('fx.stale', { date: fullDate(snapshot.staleSince, locale) })}
        />
      ) : null}

      <Card styles={{ body: { padding: 0 } }}>
        <div className="soc-fx__toolbar">
          <Segmented<Pair>
            value={pair}
            onChange={setPair}
            options={PAIRS.map((code) => ({ value: code, label: `${code}/RUB` }))}
          />
          <div className="soc-fx__controls">
            <Segmented<RangeKey>
              value={range}
              onChange={setRange}
              options={RANGE_KEYS.map((key) => ({ value: key, label: t(`fx.range.${key}`) }))}
            />
            <Segmented<'line' | 'candles'>
              value={kind}
              onChange={setKind}
              options={[
                { value: 'line', label: t('fx.line') },
                { value: 'candles', label: t('fx.candles') },
              ]}
            />
          </div>
        </div>

        <div className="soc-fx__quote">
          <div className="soc-fx__pair">
            <span className="soc-code">{pair}/RUB</span>
            <span>{t(`fx.currencyName.${pair}`)}</span>
          </div>
          {latest ? (
            <div className="soc-fx__price-row">
              <span className="soc-fx__price">
                {formatRate(latest.rate, locale)}
                <span className="soc-fx__unit">RUB</span>
              </span>
              {day ? <ChangeText value={day} suffix={t('fx.perDay')} /> : null}
            </div>
          ) : null}
        </div>

        {stats ? (
          <dl className="soc-fx__stats">
            <div>
              <dt>{t('fx.open')}</dt>
              <dd>{formatRate(stats.open, locale)}</dd>
            </div>
            <div>
              <dt>{t('fx.high')}</dt>
              <dd>{formatRate(stats.high, locale)}</dd>
            </div>
            <div>
              <dt>{t('fx.low')}</dt>
              <dd>{formatRate(stats.low, locale)}</dd>
            </div>
            <div>
              <dt>{t('fx.periodChange')}</dt>
              <dd><ChangeText value={stats.change} /></dd>
            </div>
          </dl>
        ) : null}

        <div className="soc-fx__chart">
          <EChart
            option={option}
            height={360}
            label={t('fx.chartLabel', { pair: `${pair}/RUB` })}
          />
        </div>
      </Card>

      <Card title={t('fx.history')} styles={{ body: { padding: 0 } }}>
        <DataTable<Row>
          size="small"
          rowKey="date"
          columns={columns}
          dataSource={rows}
          scroll={{ x: 720 }}
          pagination={{ pageSize: 15, size: 'small', showSizeChanger: false }}
        />
      </Card>
    </>
  );
}

/**
 * Курсы валют `[ТЗ 3.4.1]` — в виде биржевого терминала: пара, период,
 * линия или свечи, последний курс с изменением за день и сводка периода.
 *
 * ADR-004: база — рубль, `rates[c]` — сколько рублей стоит одна единица
 * валюты `c`, номинал источника нормализован при загрузке. График строится
 * по сохранённым в базе курсам, а не по запросу к источнику.
 *
 * При недоступности источника система работает на последнем известном курсе
 * и выводит предупреждение — предсказуемая деградация вместо падения.
 */
export function FxPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const { nowUtc } = useClock();
  const query = useFxRates(nowUtc, HISTORY_DAYS);
  const snapshot = query.data;
  const locale = localeOf(i18n.language);

  return (
    <>
      <PageHeader
        title={t('nav.fx')}
        meta={
          snapshot ? (
            <span>
              {/* Дата — того курса, что показан: в выходные это пятничный. */}
              {snapshot.source === 'live'
                ? t('fx.sourceLive', { date: fullDate(snapshot.staleSince ?? snapshot.date, locale) })
                : t('fx.sourceOff', { date: fullDate(snapshot.staleSince ?? snapshot.date, locale) })}
            </span>
          ) : null
        }
      />
      <QueryState query={query}>{(data) => <FxBoard snapshot={data} />}</QueryState>
    </>
  );
}
