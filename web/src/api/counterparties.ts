/** Реестры контрагентов и договоры `[ТЗ 3.3]`. */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { z } from 'zod';

import { attachmentRefSchema } from './attachments';
import { currencyCodeSchema, moneySchema, pagedSchema, type Paged } from './catalog';
import { newIdempotencyKey, request } from './client';

export const paymentTermsSchema = z.object({
  mode: z.enum(['prepayment', 'postpayment', 'deferred']),
  deferDays: z.number().int(),
  prepaymentPercent: z.string().optional(),
});

export type PaymentTermsInput = z.infer<typeof paymentTermsSchema>;

export const contactSchema = z.object({
  name: z.string(),
  role: z.string().optional(),
  email: z.string(),
  phone: z.string().nullable().optional(),
  locale: z.enum(['ru', 'en']),
  isPrimary: z.boolean(),
});

export type ContactInput = z.infer<typeof contactSchema>;

export const clientSchema = z.object({
  id: z.string(),
  name: z.string(),
  legalName: z.string(),
  country: z.string(),
  settlementCurrency: currencyCodeSchema,
  paymentTerms: paymentTermsSchema,
  contacts: z.array(contactSchema).default([]),
  defaultLocale: z.enum(['ru', 'en']),
  creditLimit: moneySchema.nullable(),
  isActive: z.boolean(),
  dataSource: z.string(),
  isDemo: z.boolean(),
});

export type ClientRow = z.infer<typeof clientSchema>;

export const vendorCertificateSchema = z.object({
  kind: z.enum(['IATA', 'ADR', 'ISO', 'other']),
  number: z.string(),
  validFrom: z.string(),
  validTo: z.string(),
});

export type VendorCertificateInput = z.infer<typeof vendorCertificateSchema>;

export const vendorSchema = z.object({
  id: z.string(),
  name: z.string(),
  legalName: z.string(),
  country: z.string(),
  settlementCurrency: currencyCodeSchema,
  specializations: z.array(z.string()),
  coverage: z.object({ airports: z.array(z.string()), regions: z.array(z.string()) }),
  paymentTerms: paymentTermsSchema,
  contacts: z.array(contactSchema).default([]),
  certificates: z.array(vendorCertificateSchema).default([]),
  exchangeMethod: z.enum(['portal', 'email', 'api']),
  manualQualityScore: z.number().int(),
  isActive: z.boolean(),
  dataSource: z.string(),
  isDemo: z.boolean(),
});

export type VendorRow = z.infer<typeof vendorSchema>;

export const contractStatusSchema = z.enum(['active', 'expiring', 'expired', 'terminated']);

export const vendorContractSchema = z.object({
  id: z.string(),
  vendorId: z.string(),
  number: z.string(),
  validFrom: z.string(),
  validTo: z.string(),
  terminatedAt: z.string().nullable(),
  currency: currencyCodeSchema,
  paymentTerms: paymentTermsSchema,
  status: contractStatusSchema,
  attachments: z.array(attachmentRefSchema).default([]),
});

export type VendorContractRow = z.infer<typeof vendorContractSchema>;

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

export function useClient(id: string | undefined): UseQueryResult<ClientRow> {
  return useQuery({
    queryKey: ['client', id],
    queryFn: ({ signal }) => request(`/clients/${id ?? ''}`, clientSchema, { signal }),
    enabled: Boolean(id),
  });
}

export interface CreateClientInput {
  name: string;
  legalName: string;
  country: string;
  settlementCurrency: z.infer<typeof currencyCodeSchema>;
  paymentTerms: PaymentTermsInput;
  defaultLocale: 'ru' | 'en';
  contacts: ContactInput[];
  creditLimit?: z.infer<typeof moneySchema> | null;
}

export function useCreateClient() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateClientInput) =>
      request('/clients', clientSchema, {
        method: 'POST',
        body: input,
        // Ключ генерируется на попытку, а не на рендер: иначе повтор после
        // обрыва связи считался бы новой операцией и завёл второго клиента.
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
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

export function useVendor(id: string | undefined): UseQueryResult<VendorRow> {
  return useQuery({
    queryKey: ['vendor', id],
    queryFn: ({ signal }) => request(`/vendors/${id ?? ''}`, vendorSchema, { signal }),
    enabled: Boolean(id),
  });
}

export interface CreateVendorInput {
  name: string;
  legalName: string;
  country: string;
  settlementCurrency: z.infer<typeof currencyCodeSchema>;
  specializations: string[];
  coverage: { airports: string[]; regions: string[] };
  paymentTerms: PaymentTermsInput;
  contacts: ContactInput[];
  certificates: VendorCertificateInput[];
  manualQualityScore: number;
  exchangeMethod: 'portal' | 'email' | 'api';
}

export function useCreateVendor() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateVendorInput) =>
      request('/vendors', vendorSchema, {
        method: 'POST',
        body: input,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['vendors'] });
    },
  });
}

export function useContracts(params: {
  vendorId?: string;
  status?: string;
}): UseQueryResult<Paged<VendorContractRow>> {
  const query = new URLSearchParams({ perPage: '200' });
  if (params.vendorId) query.set('vendorId', params.vendorId);
  if (params.status) query.set('status', params.status);

  return useQuery({
    queryKey: ['contracts', params.vendorId ?? '', params.status ?? ''],
    queryFn: ({ signal }) =>
      request(`/contracts?${query.toString()}`, pagedSchema(vendorContractSchema), { signal }),
  });
}

export interface CreateContractInput {
  vendorId: string;
  number: string;
  validFrom: string;
  validTo: string;
  currency: z.infer<typeof currencyCodeSchema>;
  paymentTerms: PaymentTermsInput;
  attachmentIds: string[];
}

export function useCreateContract() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateContractInput) =>
      request('/contracts', vendorContractSchema, {
        method: 'POST',
        body: input,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['contracts'] });
    },
  });
}
