import { describe, expect, it } from 'vitest';

import { estimateRoute } from './route';

const VNUKOVO = { lat: 55.591499, lon: 37.261501 };
const PULKOVO = { lat: 59.800301, lon: 30.262501 };

describe('оценка маршрута', () => {
  // Эталон — сервер: core.geo для той же пары (338 NM, 65 мин, 715 кг
  // без назначенного борта). Оценка формы обязана совпасть с сохранённым.
  it('совпадает с расчётом сервера без борта', () => {
    expect(estimateRoute(VNUKOVO, PULKOVO, null)).toEqual({
      distanceNm: 338,
      blockTimeMin: 65,
      fuelPlanKg: 715,
    });
  });

  it('берёт скорость и расход назначенного борта', () => {
    const estimate = estimateRoute(VNUKOVO, PULKOVO, { cruiseSpeedKts: 300, fuelBurnKgPerHour: 1000 });
    expect(estimate.blockTimeMin).toBe(Math.round((estimate.distanceNm / 300) * 60 + 20));
  });

  it('нулевая скорость не даёт деления на ноль', () => {
    expect(estimateRoute(VNUKOVO, PULKOVO, { cruiseSpeedKts: 0, fuelBurnKgPerHour: 600 }).blockTimeMin).toBe(20);
  });
});
