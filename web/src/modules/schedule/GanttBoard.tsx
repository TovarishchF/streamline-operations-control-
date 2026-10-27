import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Alert, App, Input, Modal, Space, Tag, Typography } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Timeline,
  type TimelineGroup,
  type TimelineItem,
  type TimelineOptions,
} from 'vis-timeline/standalone';
import 'vis-timeline/styles/vis-timeline-graph2d.min.css';

import { ApiError } from '@/api/client';
import { useFleet } from '@/api/fleet';
import {
  conflictsFromError,
  updateFlight,
  type FlightRow,
  type FlightUpdateInput,
} from '@/api/flights';
import { usePermission } from '@/shared/auth/session';
import { formatUtc, useClock, useClockStore } from '@/shared/clock/useClock';
import { useLocalizedName } from '@/shared/i18n/useLocalizedName';
import { FLIGHT_STATUS_TOKENS } from '@/shared/ui/status-tokens';

export type ScaleKey = 'day' | 'threeDays' | 'week';

export const SCALE_HOURS: Record<ScaleKey, number> = { day: 24, threeDays: 72, week: 168 };

/** Строка «Без борта» (`SPEC.md § 4.1`). */
const NO_AIRCRAFT = 'none';

/** Рейсы, которые уже не двигают: они состоялись или закрыты. */
const FROZEN = new Set(['in_flight', 'arrived', 'completed', 'cancelled']);

const MINUTE = 60_000;
const SNAP_MINUTES = 5;

/**
 * Время UTC на шкале планшета.
 *
 * vis-timeline рисует шкалу в зоне браузера, а планшет диспетчера — в UTC
 * (`CLAUDE.md § 10`). Единственный способ переключить шкалу — встроенный
 * в сборку moment, а его код проекта не использует (`CLAUDE.md § 5`).
 * Поэтому на шкалу кладётся момент с тем же временем на циферблате,
 * что у UTC: часы и минуты переносятся покомпонентно, без арифметики
 * смещений. Обратный перевод так же покомпонентный и точный. Неточность
 * одна: в зоне браузера с переходом на летнее время несуществующий час
 * перехода не изображается.
 */
function toAxis(utcMs: number): Date {
  const at = new Date(utcMs);
  return new Date(
    at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(),
    at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds(),
  );
}

function fromAxis(value: Date | number | string): Date {
  const at = new Date(value);
  return new Date(Date.UTC(
    at.getFullYear(), at.getMonth(), at.getDate(),
    at.getHours(), at.getMinutes(), at.getSeconds(),
  ));
}

/**
 * Текст в разметку планшета. vis-timeline кладёт содержимое полос
 * и подсказок как HTML (с фильтром XSS), а наименование клиента — данные,
 * а не разметка: «A<b>» должно показаться как есть.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Шаг 5 минут: плановое время кратно пяти. */
function snap(date: Date): Date {
  const step = SNAP_MINUTES * MINUTE;
  return new Date(Math.round(date.getTime() / step) * step);
}

interface PendingMove {
  flight: FlightRow;
  patch: FlightUpdateInput;
  conflicts: { kind: string; message: string }[];
  settle: (accepted: boolean) => void;
}

/**
 * Планшет суточного плана `[ТЗ 3.1.1, 3.1.3]` на vis-timeline (`SPEC.md § 4.1`).
 *
 * Строки — борта, сгруппированные по типу; в конце — «Без борта».
 * Перенос полосы меняет время вылета с сохранением длительности,
 * растягивание — время прилёта, перенос на другую строку — борт.
 * Несколько выделенных полос (Ctrl/Shift) переносятся вместе.
 *
 * Каждое действие идёт тем же сценарием, что и форма: сервер проверяет
 * конфликты, новый конфликт требует подтверждения с причиной (409
 * `SCHEDULE_CONFLICT`), изменение пишется в аудит и уходит письмами.
 * Полоса остаётся на новом месте сразу, а при отказе возвращается.
 */
export function GanttBoard({
  flights,
  scale,
  originUtc,
  loadedFromUtc,
}: {
  flights: FlightRow[];
  scale: ScaleKey;
  originUtc: Date;
  /** Начало выборки: прокрутка левее показала бы пустоту вместо рейсов. */
  loadedFromUtc: Date;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const localized = useLocalizedName();
  const { nowUtc } = useClock();
  const canEdit = usePermission('flight.edit');

  const container = useRef<HTMLDivElement | null>(null);
  const timeline = useRef<Timeline | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [reason, setReason] = useState('');

  const fleetQuery = useFleet();
  const fleet = useMemo(() => fleetQuery.data?.data ?? [], [fleetQuery.data]);
  const byId = useMemo(() => new Map(flights.map((flight) => [flight.id, flight])), [flights]);

  const originMs = originUtc.getTime();
  const endMs = originMs + SCALE_HOURS[scale] * 3_600_000;

  /** Строки: борта по типу ВС — вложенными группами, затем «Без борта». */
  const groups = useMemo<TimelineGroup[]>(() => {
    const byType = new Map<string, typeof fleet>();
    for (const aircraft of fleet) {
      const label = localized(aircraft.type?.name) || aircraft.typeId;
      byType.set(label, [...(byType.get(label) ?? []), aircraft]);
    }

    const result: TimelineGroup[] = [];
    let order = 0;
    for (const [label, list] of [...byType.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const sorted = [...list].sort((a, b) => a.registration.localeCompare(b.registration));
      result.push({
        id: `type:${label}`,
        content: escapeHtml(label),
        className: 'soc-gantt-type',
        nestedGroups: sorted.map((aircraft) => aircraft.id),
        showNested: true,
        order: order++,
      });
      for (const aircraft of sorted) {
        result.push({
          id: aircraft.id,
          content: escapeHtml(aircraft.registration),
          title: t(`aircraftStatus.${aircraft.status}`),
          className: aircraft.status === 'serviceable' ? '' : `soc-gantt-aircraft is-${aircraft.status}`,
          order: order++,
        });
      }
    }
    result.push({ id: NO_AIRCRAFT, content: escapeHtml(t('schedule.noAircraft')), order: order++ });
    return result;
  }, [fleet, localized, t]);

  const items = useMemo<TimelineItem[]>(
    () =>
      flights.map((flight) => {
        const token = FLIGHT_STATUS_TOKENS[flight.status] ?? 'neutral';
        const frozen = FROZEN.has(flight.status);
        return {
          id: flight.id,
          group: flight.aircraftId ?? NO_AIRCRAFT,
          start: toAxis(new Date(flight.stdUtc).getTime()),
          end: toAxis(new Date(flight.staUtc).getTime()),
          content: `<b>${escapeHtml(flight.number)}</b> ${flight.depIcao}→${flight.arrIcao}`,
          title: [
            `${flight.number} · ${flight.clientName}`,
            `${flight.depIcao} → ${flight.arrIcao}`,
            `${formatUtc(new Date(flight.stdUtc))} — ${formatUtc(new Date(flight.staUtc))}`,
            t(`flightStatus.${flight.status}`),
            ...(flight.hasConflicts ? [t('schedule.hasConflict')] : []),
          ]
            .map(escapeHtml)
            .join('<br>'),
          className: `soc-bar soc-bar--${token}${flight.hasConflicts ? ' is-conflict' : ''}`,
          editable: canEdit && !frozen
            ? { updateTime: true, updateGroup: true, remove: false }
            : false,
          type: 'range',
        };
      }),
    [flights, canEdit, t],
  );

  /**
   * Сохранение переноса. Вызывается из `onMove` планшета: пока сервер
   * не ответил, полоса стоит на новом месте; отказ возвращает её.
   */
  const save = async (flight: FlightRow, patch: FlightUpdateInput): Promise<boolean> => {
    try {
      await updateFlight(flight.id, patch);
      void queryClient.invalidateQueries({ queryKey: ['flights'] });
      void queryClient.invalidateQueries({ queryKey: ['flight-conflicts'] });
      void queryClient.invalidateQueries({ queryKey: ['flight', flight.id] });
      void message.success(t('schedule.moved', { number: flight.number }));
      return true;
    } catch (error) {
      const conflicts = conflictsFromError(error);
      if (conflicts.length > 0) {
        // Новый конфликт: решает человек, с причиной (`SPEC.md § 4.1`).
        return new Promise<boolean>((resolve) => {
          setReason('');
          setPending({ flight, patch, conflicts, settle: resolve });
        });
      }
      void message.error(error instanceof ApiError ? error.message : t('common.saveFailed'));
      return false;
    }
  };

  // Обработчик меняется с каждым рендером, а планшет создаётся один раз:
  // он берёт актуальную версию через ссылку.
  const onMove = useRef<(item: TimelineItem, done: (item: TimelineItem | null) => void) => void>(
    () => undefined,
  );
  onMove.current = (item, done) => {
    const flight = byId.get(String(item.id));
    if (!flight || item.end === undefined) {
      done(null);
      return;
    }
    const start = fromAxis(item.start);
    const end = fromAxis(item.end);
    const oldStart = new Date(flight.stdUtc).getTime();
    const oldEnd = new Date(flight.staUtc).getTime();
    const group = item.group === NO_AIRCRAFT || item.group === undefined ? null : String(item.group);

    const patch: FlightUpdateInput = {};
    if (group !== flight.aircraftId) patch.aircraftId = group;
    const sameLength = end.getTime() - start.getTime() === oldEnd - oldStart;
    if (start.getTime() !== oldStart) patch.stdUtc = start.toISOString();
    // Перенос целиком передаёт только вылет: длительность сохраняет сервер.
    if (end.getTime() !== oldEnd && !(sameLength && patch.stdUtc)) patch.staUtc = end.toISOString();

    if (Object.keys(patch).length === 0) {
      done(item);
      return;
    }
    void save(flight, patch).then((accepted) => {
      done(accepted ? item : null);
    });
  };

  // Создание планшета — один раз на монтирование.
  useEffect(() => {
    if (!container.current) return undefined;
    const options: TimelineOptions = {
      stack: false,
      multiselect: true,
      orientation: { axis: 'top' },
      margin: { item: 4 },
      groupOrder: 'order',
      zoomMin: 3_600_000,
      showCurrentTime: false,
      snap,
      format: {
        minorLabels: { minute: 'HH:mm', hour: 'HH', weekday: 'DD.MM', day: 'DD.MM' },
        majorLabels: { minute: 'DD.MM', hour: 'DD.MM', weekday: 'MM.YYYY', day: 'MM.YYYY' },
      },
      tooltip: { followMouse: true, overflowMethod: 'cap' },
      onMove: (item, done) => {
        onMove.current(item, done);
      },
    };
    const instance = new Timeline(container.current, [], [], options);
    instance.addCustomTime(toAxis(useClockStore.getState().nowUtc.getTime()), 'now');
    instance.on('doubleClick', (props: { item?: string | number | null }) => {
      if (props.item !== null && props.item !== undefined) navigate(`/flights/${String(props.item)}`);
    });
    timeline.current = instance;
    return () => {
      instance.destroy();
      timeline.current = null;
    };
    // Создаётся один раз: данные и окно передаются эффектами ниже.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    timeline.current?.setGroups(groups);
    timeline.current?.setItems(items);
  }, [groups, items]);

  useEffect(() => {
    const instance = timeline.current;
    if (!instance) return;
    instance.setOptions({
      min: toAxis(loadedFromUtc.getTime()),
      max: toAxis(endMs),
      zoomMax: SCALE_HOURS[scale] * 3_600_000,
    });
    instance.setWindow(toAxis(originMs), toAxis(endMs), { animation: false });
  }, [originMs, endMs, scale, loadedFromUtc]);

  // Линия «сейчас» — по часам сервера (ADR-014), а не по часам браузера.
  const nowMinute = Math.floor(nowUtc.getTime() / MINUTE);
  useEffect(() => {
    const instance = timeline.current;
    if (!instance) return;
    instance.setCustomTime(toAxis(nowMinute * MINUTE), 'now');
    instance.setCustomTimeTitle(formatUtc(new Date(nowMinute * MINUTE)), 'now');
  }, [nowMinute]);

  const settle = (accepted: boolean): void => {
    pending?.settle(accepted);
    setPending(null);
  };

  return (
    <div className="soc-gantt">
      <div ref={container} className="soc-gantt__timeline" aria-label={t('schedule.gantt')} />
      <Typography.Text type="secondary" className="soc-gantt__hint">
        {canEdit ? t('schedule.ganttHint') : t('schedule.ganttReadOnlyHint')}
      </Typography.Text>

      <Modal
        open={pending !== null}
        title={t('schedule.conflictConfirmTitle', { number: pending?.flight.number ?? '' })}
        okText={t('schedule.conflictConfirm')}
        okButtonProps={{ disabled: reason.trim() === '' }}
        cancelText={t('common.cancel')}
        onCancel={() => {
          settle(false);
        }}
        onOk={() => {
          if (!pending) return;
          const { flight, patch } = pending;
          const settleWith = pending.settle;
          setPending(null);
          void save(flight, { ...patch, conflictOverrideReason: reason.trim() }).then(settleWith);
        }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message={t('schedule.conflictConfirmHint')}
            description={
              <Space direction="vertical" size={2}>
                {pending?.conflicts.map((conflict) => (
                  <span key={`${conflict.kind}:${conflict.message}`}>
                    <Tag style={{ margin: 0, marginInlineEnd: 6 }}>{t(`conflictKind.${conflict.kind}`)}</Tag>
                    {conflict.message}
                  </span>
                ))}
              </Space>
            }
          />
          <Input.TextArea
            rows={3}
            autoFocus
            value={reason}
            placeholder={t('schedule.conflictReason')}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        </Space>
      </Modal>
    </div>
  );
}
