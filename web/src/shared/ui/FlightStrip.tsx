import type { JSX } from 'react';
import { Link } from 'react-router-dom';

import { formatUtc } from '@/shared/clock/useClock';
import { StatusPill } from './primitives';
import type { StatusToken } from './status-tokens';

/** Меньше четырёх часов до вылета — обратный отсчёт становится предупреждением. */
const SOON_MINUTES = 240;

/** Обратный отсчёт `T−3:56`: знак минуса настоящий, а не дефис. */
function countdown(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `T−${String(hours)}:${String(rest).padStart(2, '0')}`;
}

/**
 * Рейс как полоса диспетчерского стрипа: номер, плечо, статус и отсчёт
 * в одной строке (карточка FlightStrip дизайн-системы).
 *
 * Полосы ставятся друг под другом, а не в таблицу.
 */
export function FlightStrip({
  flightId,
  flightNo,
  tail,
  typeCode,
  dep,
  arr,
  status,
  minutesToEtd,
}: {
  flightId: string;
  flightNo: string;
  tail: string | null;
  typeCode: string | null;
  dep: { icao: string; etd: string };
  arr: { icao: string; eta: string };
  status: { token: StatusToken; label: string };
  minutesToEtd?: number;
}): JSX.Element {
  return (
    <div className="soc-strip">
      <div className="soc-strip__id">
        <Link to={`/flights/${flightId}`} className="soc-strip__no soc-code--link">
          {flightNo}
        </Link>
        <span className="soc-strip__tail">
          {[tail ?? '—', typeCode].filter(Boolean).join(' · ')}
        </span>
      </div>
      <div className="soc-strip__leg">
        <div className="soc-strip__pt">
          <span className="soc-strip__icao">{dep.icao}</span>
          <span className="soc-strip__t">ETD {formatUtc(new Date(dep.etd))}</span>
        </div>
        <div className="soc-strip__path" aria-hidden="true">
          <svg viewBox="0 0 100 18" preserveAspectRatio="none">
            <path d="M2 15 Q50 -6 98 15" />
          </svg>
        </div>
        <div className="soc-strip__pt soc-strip__pt--arr">
          <span className="soc-strip__icao">{arr.icao}</span>
          <span className="soc-strip__t">ETA {formatUtc(new Date(arr.eta))}</span>
        </div>
      </div>
      <div className="soc-strip__side">
        <StatusPill token={status.token} label={status.label} size="sm" />
        {minutesToEtd !== undefined ? (
          <span
            className={
              minutesToEtd < SOON_MINUTES ? 'soc-strip__eta is-soon' : 'soc-strip__eta'
            }
          >
            {countdown(minutesToEtd)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
