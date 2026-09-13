import { useMemo, useRef, type JSX } from 'react';
import { Space, Tooltip, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { FlightListItem } from '@/api/types';
import { AIRCRAFT, AIRCRAFT_TYPE_BY_ID } from '@/mocks/reference';
import { useClock } from '@/shared/clock/useClock';
import { FLIGHT_STATUS_TOKENS, STATUS_TOKENS } from '@/shared/ui/status-tokens';

export type ScaleKey = 'day' | 'threeDays' | 'week';

const SCALE_HOURS: Record<ScaleKey, number> = { day: 24, threeDays: 72, week: 168 };
const ROW_HEIGHT = 34;
const LABEL_WIDTH = 148;

/**
 * Планшет суточного плана `[ТЗ 3.1.1]`.
 *
 * Строки — борта, сгруппированные по типу; в конце — группа «Без борта»
 * для рейсов, где борт ещё не назначен (`SPEC.md § 4.1`).
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
  flights: FlightListItem[];
  scale: ScaleKey;
  originUtc: Date;
}): JSX.Element {
  const { t } = useTranslation();
  const { nowUtc } = useClock();
  const scrollRef = useRef<HTMLDivElement>(null);

  const totalHours = SCALE_HOURS[scale];
  const pxPerHour = scale === 'day' ? 46 : scale === 'threeDays' ? 20 : 9;
  const boardWidth = totalHours * pxPerHour;
  const originMs = originUtc.getTime();

  /** Группировка строк: борта по типу ВС, затем «Без борта». */
  const rows = useMemo(() => {
    const used = new Set(flights.map((f) => f.aircraftId).filter(Boolean));
    const byType = new Map<string, typeof AIRCRAFT>();
    for (const aircraft of AIRCRAFT) {
      if (!used.has(aircraft.id)) continue;
      const list = byType.get(aircraft.typeId) ?? [];
      list.push(aircraft);
      byType.set(aircraft.typeId, list);
    }

    const result: Array<
      | { kind: 'group'; key: string; label: string }
      | { kind: 'aircraft'; key: string; id: string; label: string; status: string }
    > = [];

    for (const [typeId, list] of byType) {
      const type = AIRCRAFT_TYPE_BY_ID.get(typeId);
      result.push({ kind: 'group', key: `g_${typeId}`, label: type?.name.ru ?? typeId });
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

    if (flights.some((flight) => flight.aircraftId === null || flight.aircraftId === undefined)) {
      result.push({ kind: 'group', key: 'g_none', label: t('schedule.noAircraft') });
      result.push({ kind: 'aircraft', key: 'none', id: '', label: '—', status: 'serviceable' });
    }

    return result;
  }, [flights, t]);

  const hourMarks = useMemo(() => {
    const step = scale === 'day' ? 2 : scale === 'threeDays' ? 6 : 24;
    return Array.from({ length: Math.floor(totalHours / step) + 1 }, (_, i) => {
      const at = new Date(originMs + i * step * 3_600_000);
      return { left: i * step * pxPerHour, at, step };
    });
  }, [originMs, pxPerHour, scale, totalHours]);

  const nowLeft =
    nowUtc.getTime() >= originMs && nowUtc.getTime() <= originMs + totalHours * 3_600_000
      ? ((nowUtc.getTime() - originMs) / 3_600_000) * pxPerHour
      : null;

  return (
    <div style={{ display: 'flex', border: `1px solid ${STATUS_TOKENS.neutral.border}`, borderRadius: 4, overflow: 'hidden' }}>
      {/* Колонка бортов остаётся на месте при прокрутке шкалы */}
      <div style={{ width: LABEL_WIDTH, flexShrink: 0, borderInlineEnd: `1px solid ${STATUS_TOKENS.neutral.border}`, background: '#fafafa' }}>
        <div style={{ height: 28, borderBottom: `1px solid ${STATUS_TOKENS.neutral.border}` }} />
        {rows.map((row) =>
          row.kind === 'group' ? (
            <div
              key={row.key}
              style={{
                height: ROW_HEIGHT, display: 'flex', alignItems: 'center', paddingInline: 8,
                fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4,
                color: '#8c8c8c', background: '#f0f0f0',
                borderBottom: `1px solid ${STATUS_TOKENS.neutral.border}`,
              }}
            >
              {row.label}
            </div>
          ) : (
            <div
              key={row.key}
              style={{
                height: ROW_HEIGHT, display: 'flex', alignItems: 'center', gap: 6,
                paddingInline: 8, borderBottom: `1px solid ${STATUS_TOKENS.neutral.border}`,
              }}
            >
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                {row.label}
              </span>
              {row.status !== 'serviceable' ? (
                <Tooltip title={t(`aircraftStatus.${row.status}`)}>
                  <span
                    style={{
                      width: 7, height: 7, borderRadius: '50%',
                      background: row.status === 'aog' ? STATUS_TOKENS.critical.color : STATUS_TOKENS.warning.color,
                    }}
                  />
                </Tooltip>
              ) : null}
            </div>
          ),
        )}
      </div>

      <div ref={scrollRef} style={{ overflowX: 'auto', flex: 1 }}>
        <div style={{ width: boardWidth, position: 'relative' }}>
          {/* Шкала времени. Подпись зоны обязательна (CLAUDE.md § 10). */}
          <div style={{ height: 28, position: 'relative', borderBottom: `1px solid ${STATUS_TOKENS.neutral.border}`, background: '#fafafa' }}>
            {hourMarks.map(({ left, at, step }) => (
              <div
                key={left}
                style={{
                  position: 'absolute', left, top: 0, height: '100%',
                  borderInlineStart: `1px solid ${STATUS_TOKENS.neutral.border}`,
                  paddingInlineStart: 4, fontSize: 11, color: '#8c8c8c',
                  fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap',
                }}
              >
                {step >= 24
                  ? `${String(at.getUTCDate()).padStart(2, '0')}.${String(at.getUTCMonth() + 1).padStart(2, '0')}`
                  : `${String(at.getUTCHours()).padStart(2, '0')}Z`}
              </div>
            ))}
          </div>

          {rows.map((row) => {
            if (row.kind === 'group') {
              return <div key={row.key} style={{ height: ROW_HEIGHT, background: '#f0f0f0', borderBottom: `1px solid ${STATUS_TOKENS.neutral.border}` }} />;
            }

            const rowFlights = flights.filter((f) =>
              row.id === '' ? !f.aircraftId : f.aircraftId === row.id,
            );

            return (
              <div key={row.key} style={{ height: ROW_HEIGHT, position: 'relative', borderBottom: `1px solid ${STATUS_TOKENS.neutral.border}` }}>
                {rowFlights.map((flight) => {
                  const start = new Date(flight.stdUtc).getTime();
                  const end = new Date(flight.staUtc).getTime();
                  const left = ((start - originMs) / 3_600_000) * pxPerHour;
                  const width = Math.max(((end - start) / 3_600_000) * pxPerHour, 18);
                  if (left + width < 0 || left > boardWidth) return null;

                  const token = STATUS_TOKENS[FLIGHT_STATUS_TOKENS[flight.status] ?? 'neutral'];

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
                        style={{
                          position: 'absolute', left, width, top: 5, height: ROW_HEIGHT - 11,
                          background: token.background,
                          border: `1px solid ${flight.hasConflicts ? STATUS_TOKENS.critical.color : token.border}`,
                          borderInlineStartWidth: 3,
                          borderInlineStartColor: token.color,
                          borderRadius: 3, overflow: 'hidden', whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis', paddingInline: 5, fontSize: 11,
                          color: token.color, lineHeight: `${String(ROW_HEIGHT - 13)}px`,
                          fontFamily: "'JetBrains Mono', monospace",
                        }}
                      >
                        {flight.number} · {flight.depIcao}→{flight.arrIcao}
                      </Link>
                    </Tooltip>
                  );
                })}
              </div>
            );
          })}

          {/* Линия текущего момента — обновляется по useClock (SPEC § 4.1) */}
          {nowLeft !== null ? (
            <div
              style={{
                position: 'absolute', left: nowLeft, top: 0, bottom: 0, width: 2,
                background: STATUS_TOKENS.critical.color, pointerEvents: 'none', zIndex: 5,
              }}
            >
              <Typography.Text
                style={{
                  position: 'absolute', top: 0, left: 3, fontSize: 10,
                  color: STATUS_TOKENS.critical.color, background: '#fff', paddingInline: 2,
                }}
              >
                {t('schedule.now')}
              </Typography.Text>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
