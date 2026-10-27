/**
 * Предварительная оценка маршрута для формы рейса `[ТЗ 3.1.1]` (`DOMAIN.md § 7.8`).
 *
 * Окончательные расстояние, блок-тайм и топливо считает сервер
 * (`backend/core/geo.py`, `flights/services/planning.py`) при создании рейса.
 * Здесь тот же расчёт — чтобы диспетчер видел оценку до отправки формы,
 * — с теми же константами: оценка, расходящаяся с сохранённым значением,
 * хуже её отсутствия. Расчёт плановый: ветер и эшелоны не учитываются.
 */

const EARTH_RADIUS_KM = 6371;
const KM_PER_NAUTICAL_MILE = 1.852;
const TAXI_AND_APPROACH_MIN = 20;
const FUEL_RESERVE_FACTOR = 1.1;

/** Без назначенного борта — как на сервере (`planning.DEFAULT_*`). */
export const DEFAULT_CRUISE_KTS = 450;
export const DEFAULT_BURN_KG_H = 600;

export interface RouteEstimate {
  distanceNm: number;
  blockTimeMin: number;
  fuelPlanKg: number;
}

/** Ортодромия между точками, морские мили (формула гаверсинуса). */
export function distanceNm(from: { lat: number; lon: number }, to: { lat: number; lon: number }): number {
  const rad = (deg: number): number => (deg * Math.PI) / 180;
  const dPhi = rad(to.lat - from.lat);
  const dLambda = rad(to.lon - from.lon);
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLambda / 2) ** 2;
  return (2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a))) / KM_PER_NAUTICAL_MILE;
}

export function estimateRoute(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  aircraft: { cruiseSpeedKts: number; fuelBurnKgPerHour?: number | undefined } | null,
): RouteEstimate {
  const cruise = aircraft?.cruiseSpeedKts ?? DEFAULT_CRUISE_KTS;
  const burn = aircraft?.fuelBurnKgPerHour ?? DEFAULT_BURN_KG_H;
  const distance = distanceNm(from, to);
  // Блок-тайм — от нерасокруглённого расстояния, как на сервере.
  const blockTimeMin =
    cruise <= 0 ? TAXI_AND_APPROACH_MIN : Math.round((distance / cruise) * 60 + TAXI_AND_APPROACH_MIN);
  return {
    distanceNm: Math.round(distance),
    blockTimeMin,
    fuelPlanKg: Math.round((blockTimeMin / 60) * burn * FUEL_RESERVE_FACTOR),
  };
}
