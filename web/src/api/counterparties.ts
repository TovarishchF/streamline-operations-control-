/** Реестры контрагентов `[ТЗ 3.3]`. */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';

import { pagedSchema, type Paged } from './catalog';
import { request } from './client';

export const clientSchema = z.object({
  id: z.string(),
  name: z.string(),
  legalName: z.string(),
  country: z.string(),
  settlementCurrency: z.string(),
  defaultLocale: z.enum(['ru', 'en']),
  isActive: z.boolean(),
});

export type ClientRow = z.infer<typeof clientSchema>;

export const vendorSchema = z.object({
  id: z.string(),
  name: z.string(),
  legalName: z.string(),
  country: z.string(),
  settlementCurrency: z.string(),
  specializations: z.array(z.string()),
  isActive: z.boolean(),
});

export type VendorRow = z.infer<typeof vendorSchema>;

/** Реестры меняются редко: держим их в кэше пять минут. */
const REGISTRY_STALE_MS = 5 * 60 * 1000;

export function useClients(): UseQueryResult<Paged<ClientRow>> {
  return useQuery({
    queryKey: ['clients'],
    queryFn: ({ signal }) =>
      request('/clients?perPage=200', pagedSchema(clientSchema), { signal }),
    staleTime: REGISTRY_STALE_MS,
  });
}

export function useVendors(category?: string): UseQueryResult<Paged<VendorRow>> {
  const query = new URLSearchParams({ perPage: '200' });
  if (category) query.set('category', category);

  return useQuery({
    queryKey: ['vendors', category ?? ''],
    queryFn: ({ signal }) =>
      request(`/vendors?${query.toString()}`, pagedSchema(vendorSchema), { signal }),
    staleTime: REGISTRY_STALE_MS,
  });
}
