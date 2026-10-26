import { useMemo, type CSSProperties, type JSX } from 'react';
import { Space, Tooltip } from 'antd';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useFleet } from '@/api/fleet';
import type { FlightRow } from '@/api/flights';
import { formatUtc, useClock } from '@/shared/clock/useClock';
import { FLIGHT_STATUS_TOKENS } from '@/shared/ui/status-tokens';

export type ScaleKey = 'day' | 'threeDays' | 'week';

export const SCALE_HOURS: Record<ScaleKey, number> = { day: 24, threeDays: 72, week: 168 };

/** Шаг делений шкалы, часов. */
const TICK_HOURS: Record<ScaleKey, number> = { day: 2, threeDays: 6, week: 24 };

/**
 * Пикселей на час, ниже которых шкала не сжимается: на настольном экране
 * сутки помещаются в ширину, трое суток и неделя прокручиваются. Сутки —
 * 760 px вместе с колонкой бортов, как у макета: уже деления сливаются.
 */
const MIN_PX_PER_HOUR: Record<ScaleKey, number> = { day: 24, threeDays: 20, week: 9 };

/** Колонка бортов (`--lab` макета). */
const LABEL_WIDTH = 184;

/**
 * Планшет суточного плана `[ТЗ 3.1.1]`.
 *
 * Строки — борта, сгруппированные по типу; в конце — группа «Без борта»
 * для рейсов, где борт ещё не назначен (`SPEC.md § 4.1`).
 *
 * Вид — карточка GanttBoard и макет `docs/design/mockups/screens/03-schedule.html`:
 * полосы в цвет статуса с ведущей кромкой 3 px, красная обводка конфликта,
 * линия «сейчас» цвета `mark-red` с меткой времени.
 *
 * На вехе M10 сюда встанет `vis-timeline` с перетаскиванием: перенос полосы
 * меняет время вылета, растягивание — продолжительность, перенос на другую
 * строку — смену борта, и каждое действие проходит через тот же сценарий,
 * что и форма (проверка конфликтов → подтверждение → аудит → уведомления).
 * Пока это статический планшет для утверждения компоновки.
 */
export function GanttBoard({
  flights,
  scale,
  originUtc,
}: {
  flights: FlightRow[];
  scale: ScaleKey;
  originUtc: Date;
}): JSX.Element {
  const { t } = useTranslation();
  const { nowUtc } = useClock();

  // Парк берётся с сервера: строки планшета — это борта, и строить их
  // по набору для макетов значило бы показывать пустой планшет
  // при настоящем расписании.
  const fleetQuery = useFleet();
  const fleet = useMemo(() => fleetQuery.data?.data ?? [], [fleetQuery.data]);

  const totalHours = SCALE_HOURS[scale];
  const tickHours = TICK_HOURS[scale];
  const originMs = originUtc.getTime();
  const endMs = originMs + totalHours * 3_600_000;

  /** Доля окна от его начала, 0…1. */
  const fraction = (ms: number): number => (ms - originMs) / (endMs - originMs);

  // Выборка захватывает сутки до окна (рейс мог вылететь раньше и ещё быть
  // в воздухе). Строки и полосы — только по рейсам, которые попадают в окно:
  // иначе борт с завершившимся вчера рейсом стоял бы пустой строкой.
  const inWindow = useMemo(
    () =>
      flights.filter(
        (flight) =>
          new Date(flight.staUtc).getTime() > originMs &&
          new Date(flight.stdUtc).getTime() < endMs,
      ),
    [flights, originMs, endMs],
  );

  /** Группировка строк: борта по типу ВС, затем «Без борта». */
  const rows = useMemo(() => {
    const used = new Set(inWindow.map((flight) => flight.aircraftId).filter(Boolean));
    const byType = new Map<string, { id: string; registration: string; status: string }[]>();

    for (const aircraft of fleet) {
      if (!used.has(aircraft.id)) continue;
      const label = aircraft.type?.name.ru ?? aircraft.typeId;
      const list = byType.get(label) ?? [];
      list.push({
        id: aircraft.id,
        registration: aircraft.registration,
        status: aircraft.status,
      });
      byType.set(label, list);
    }

    const result: Array<
      | { kind: 'group'; key: string; label: string }
      | { kind: 'aircraft'; key: string; id: string; label: string; status: string }
    > = [];

    for (const [typeLabel, list] of byType) {
      result.push({ kind: 'group', key: `g_${typeLabel}`, label: typeLabel });
      for (const aircraft of list) {
        result.push({
          kind: 'aircraft',
          key: aircraft.id,
          id: aircraft.id,
          label: aircraft.registration,
          status: aircraft.status,
        });
      }
    }

    if (inWindow.some((flight) => flight.aircraftId === null)) {
      result.push({ kind: 'group', key: 'g_none', label: t('schedule.noAircraft') });
      result.push({ kind: 'aircraft', key: 'none', id: '', label: '—', status: 'serviceable' });
    }

    return result;
  }, [fleet, inWindow, t]);

  const ticks = useMemo(
    () =>
      Array.from({ length: totalHours / tickHours }, (_, i) => {
        const at = new Date(originMs + i * tickHours * 3_600_000);
        return { left: (i * tickHours) / totalHours, at };
      }),
    [originMs, tickHours, totalHours],
  );

  const now = nowUtc.getTime() >= originMs && nowUtc.getTime() <= endMs ? fraction(nowUtc.getTime()) : null;

  // Колонка бортов, число делений и минимальная ширина — в CSS-переменных:
  // от них считаются сетка дорожек и положение линии «сейчас».
  const gridStyle = {
    '--lab': `${String(LABEL_WIDTH)}px`,
    '--ticks': String(ticks.length),
    minWidth: LABEL_WIDTH + totalHours * MIN_PX_PER_HOUR[scale],
  } as CSSProperties;

  return (
    <div className="soc-gantt">
      <div className="soc-gantt__scroll">
        <div className="soc-gantt__grid" style={gridStyle}>
          {/* Линия текущего момента — обновляется по useClock (SPEC § 4.1).
              Стоит первой, чтобы последней в сетке оставалась строка. */}
          {now !== null ? (
            <div
              className="soc-gantt__now"
              style={{ left: `calc(var(--lab) + (100% - var(--lab)) * ${String(now)})` }}
            >
              <div className="soc-now">
                <span>{formatUtc(nowUtc)}</span>
              </div>
            </div>
          ) : null}

          {/* Шкала времени. Подпись зоны обязательна (CLAUDE.md § 10). */}
          <div className="soc-gantt__head">
            <div className="soc-gantt__label">{t('flight.aircraft')}</div>
            <div className="soc-gantt__scale">
              {ticks.map(({ left, at }) => (
                <span key={left} style={{ left: `${String(left * 100)}%` }}>
                  {tickHours >= 24
                    ? `${String(at.getUTCDate()).padStart(2, '0')}.${String(at.getUTCMonth() + 1).padStart(2, '0')}`
                    : `${String(at.getUTCHours()).padStart(2, '0')}Z`}
                </span>
              ))}
            </div>
          </div>

          {rows.map((row) => {
            if (row.kind === 'group') {
              return (
                <div key={row.key} className="soc-gantt__row soc-gantt__row--group">
                  <div className="soc-gantt__label" title={row.label}>
                    <span className="soc-gantt__type">{row.label}</span>
                  </div>
                  <div className="soc-gantt__lane" />
                </div>
              );
            }

            const rowFlights = inWindow.filter((f) =>
              row.id === '' ? !f.aircraftId : f.aircraftId === row.id,
            );

            return (
              <div key={row.key} className="soc-gantt__row">
                <div className="soc-gantt__label">
                  {row.label}
                  {row.status !== 'serviceable' ? (
                    <Tooltip title={t(`aircraftStatus.${row.status}`)}>
                      <span
                        role="img"
                        aria-label={t(`aircraftStatus.${row.status}`)}
                        className={row.status === 'aog' ? 'soc-gantt__flag' : 'soc-gantt__flag is-warn'}
                      />
                    </Tooltip>
                  ) : null}
                </div>
                <div className="soc-gantt__lane">
                  {rowFlights.map((flight) => {
                    const start = Math.max(new Date(flight.stdUtc).getTime(), originMs);
                    const end = Math.min(new Date(flight.staUtc).getTime(), endMs);
                    if (end <= start) return null;

                    const token = FLIGHT_STATUS_TOKENS[flight.status] ?? 'neutral';
                    const classes = ['soc-bar', `soc-bar--${token}`];
                    if (flight.hasConflicts) classes.push('is-conflict');

                    return (
                      <Tooltip
                        key={flight.id}
                        title={
                          <Space direction="vertical" size={0}>
                            <span>{flight.number} · {flight.clientName}</span>
                            <span>{flight.depIcao} → {flight.arrIcao}</span>
                            <span>
                              {new Date(flight.stdUtc).toISOString().slice(11, 16)}Z —{' '}
                              {new Date(flight.staUtc).toISOString().slice(11, 16)}Z
                            </span>
                            <span>{t(`flightStatus.${flight.status}`)}</span>
                            {flight.hasConflicts ? <span>⚠ {t('schedule.hasConflict')}</span> : null}
                          </Space>
                        }
                      >
                        <Link
                          to={`/flights/${flight.id}`}
                          className={classes.join(' ')}
                          style={{
                            left: `${String(fraction(start) * 100)}%`,
                            width: `${String((fraction(end) - fraction(start)) * 100)}%`,
                          }}
                        >
                          <b>{flight.number}</b> {flight.depIcao}→{flight.arrIcao}
                        </Link>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
