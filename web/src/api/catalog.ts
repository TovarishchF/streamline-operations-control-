/**
 * Справочники: аэропорты, типы воздушных судов, ставки НДС, каталог услуг.
 *
 * Формы ответов описаны схемами zod: ответ сервера для клиента — внешние
 * данные, даже если контракт согласован (`CLAUDE.md § 3` п. 15). Типы при
 * этом берутся из сгенерированных, а не пишутся руками (п. 6): схема
 * проверяет то, что тип обещает.
 */
import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';

import { pageMetaSchema, request } from './client';
import type { AircraftType, Airport, ServiceCatalogItem, VatRate } from './types';

const localizedNameSchema = z.object({ ru: z.string(), en: z.string() });

export const airportSchema = z.object({
  id: z.string(),
  icao: z.string(),
  iata: z.string().nullable(),
  name: localizedNameSchema,
  city: z.string(),
  country: z.string(),
  timezone: z.string(),
  lat: z.number(),
  lon: z.number(),
  elevationFt: z.number().int(),
  isCoordinated: z.boolean(),
}) satisfies z.ZodType<Airport>;

export const aircraftTypeSchema = z.object({
  id: z.string(),
  icaoType: z.string(),
  name: localizedNameSchema,
  category: z.enum(['light', 'midsize', 'heavy', 'airliner', 'cargo']),
  seats: z.number().int(),
  cruiseSpeedKts: z.number().int(),
  fuelBurnKgPerHour: z.number().int(),
  turnaroundMin: z.number().int(),
}) satisfies z.ZodType<AircraftType>;

export const vatRateSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: localizedNameSchema,
  percent: z.string(),
  applicability: z.enum(['domestic', 'international', 'export_of_services', 'exempt']),
}) satisfies z.ZodType<VatRate>;

export const serviceAttributeSchema = z.object({
  key: z.string(),
  type: z.enum(['number', 'string', 'enum', 'boolean']),
  options: z.array(z.string()).optional(),
  required: z.boolean(),
});

export const serviceSchema = z.object({
  id: z.string(),
  code: z.string(),
  category: z.enum(['fuel', 'handling', 'catering', 'transport', 'permits', 'deicing']),
  name: localizedNameSchema,
  unit: z.enum(['L', 'kg', 'ea', 'hour', 'pax', 'flight']),
  requiresWeather: z.boolean(),
  leadTimeH: z.number().int(),
  requiredAttributes: z.array(serviceAttributeSchema),
  requiresActToComplete: z.boolean(),
}) satisfies z.ZodType<ServiceCatalogItem>;

/** Конверт постраничного ответа (`openapi.yaml` PagedResponse). */
export function pagedSchema<T>(item: z.ZodType<T>) {
  return z.object({ data: z.array(item), meta: pageMetaSchema });
}

export interface Paged<T> {
  data: T[];
  meta: { total: number; page: number; perPage: number };
}

/**
 * Справочники меняются редко, а листаются часто: держим их в кэше
 * пять минут, иначе каждый переход между экранами — повторный запрос
 * полутора тысяч аэропортов.
 */
const REFERENCE_STALE_MS = 5 * 60 * 1000;

export function useAirports(params: {
  search?: string;
  page?: number;
  perPage?: number;
}): UseQueryResult<Paged<Airport>> {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  query.set('page', String(params.page ?? 1));
  query.set('perPage', String(params.perPage ?? 50));

  return useQuery({
    queryKey: ['airports', params.search ?? '', params.page ?? 1, params.perPage ?? 50],
    queryFn: ({ signal }) =>
      request(`/airports?${query.toString()}`, pagedSchema(airportSchema), { signal }),
    staleTime: REFERENCE_STALE_MS,
    placeholderData: (previous) => previous,
  });
}

export function useAircraftTypes(): UseQueryResult<Paged<AircraftType>> {
  return useQuery({
    queryKey: ['aircraft-types'],
    queryFn: ({ signal }) =>
      request('/aircraft-types?perPage=200', pagedSchema(aircraftTypeSchema), { signal }),
    staleTime: REFERENCE_STALE_MS,
  });
}

export function useVatRates(): UseQueryResult<{ data: VatRate[] }> {
  return useQuery({
    queryKey: ['vat-rates'],
    queryFn: ({ signal }) =>
      request('/vat-rates', z.object({ data: z.array(vatRateSchema) }), { signal }),
    staleTime: REFERENCE_STALE_MS,
  });
}

export function useServices(category?: string): UseQueryResult<Paged<ServiceCatalogItem>> {
  const query = new URLSearchParams({ perPage: '200' });
  if (category) query.set('category', category);

  return useQuery({
    queryKey: ['catalog-services', category ?? ''],
    queryFn: ({ signal }) =>
      request(`/catalog/services?${query.toString()}`, pagedSchema(serviceSchema), { signal }),
    staleTime: REFERENCE_STALE_MS,
  });
}

/**
 * Аэропорты по кодам ИКАО.
 *
 * Отдельный запрос на каждый код, а не выборка из первой страницы
 * справочника: в нём больше тысячи записей, и нужный аэропорт в первые
 * двести почти наверняка не попадает. Именно так местное время рейса
 * оказывалось пустым.
 */
export function useAirportsByIcao(codes: string[]): Record<string, Airport> {
  const unique = [...new Set(codes.filter(Boolean))].sort();

  const results = useQueries({
    queries: unique.map((icao) => ({
      queryKey: ['airport', icao],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        request(`/airports?search=${icao}&perPage=1`, pagedSchema(airportSchema), { signal }),
      staleTime: REFERENCE_STALE_MS,
    })),
  });

  const found: Record<string, Airport> = {};
  for (const result of results) {
    const airport = result.data?.data[0];
    if (airport) found[airport.icao] = airport;
  }
  return found;
}
