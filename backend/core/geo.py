"""Географические расчёты `[ТЗ 3.1.1]` (`DOMAIN.md § 7.8`).

Расчёт плановый и оценочный: ветер, эшелоны, запасные аэродромы и профиль
полёта не учитываются. Рядом с результатом в интерфейсе стоит пометка об этом.
Точный расчёт требует данных производителя ВС и планировщика маршрутов —
зафиксировано в `GAPS.md`.
"""

from __future__ import annotations

import math

EARTH_RADIUS_KM = 6371.0
KM_PER_NAUTICAL_MILE = 1.852

# Надбавка на руление, ожидание и заход на посадку. `DOMAIN.md § 7.8`.
TAXI_AND_APPROACH_MIN = 20

# Запас топлива к расчётному расходу: те же 10 %, что и в формуле ТЗ.
FUEL_RESERVE_FACTOR = 1.1


def distance_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Ортодромия между точками в морских милях (формула гаверсинуса)."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    )
    kilometres = 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))
    return kilometres / KM_PER_NAUTICAL_MILE


def block_time_min(distance: float, cruise_speed_kts: int) -> int:
    """Время от отрыва колодок до постановки на колодки, минуты.

    Нулевая крейсерская скорость означала бы деление на ноль: такой тип ВС
    в справочник попасть не должен, но расчёт не место для падения.
    """
    if cruise_speed_kts <= 0:
        return TAXI_AND_APPROACH_MIN
    return round(distance / cruise_speed_kts * 60 + TAXI_AND_APPROACH_MIN)


def fuel_plan_kg(block_time: int, fuel_burn_kg_per_hour: int) -> int:
    """Плановая заправка с десятипроцентным запасом."""
    return round(block_time / 60 * fuel_burn_kg_per_hour * FUEL_RESERVE_FACTOR)
