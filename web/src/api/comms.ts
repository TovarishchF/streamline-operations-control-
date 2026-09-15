/**
 * Коммуникации `[ТЗ 3.5.1, 3.5.2, 3.2.2]`.
 *
 * Ссылка на `.eml` приходит подписанной и со сроком жизни, поэтому она
 * не кладётся в состояние и не кэшируется дольше списка: сохранённая
 * ссылка была бы просроченной к моменту нажатия.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { z } from 'zod';

import { pagedSchema, type Paged } from './catalog';
import { newIdempotencyKey, request } from './client';

export const messageChannelSchema = z.enum(['email', 'messenger', 'portal']);
export const outboxStatusSchema = z.enum(['queued', 'sent', 'delivered', 'failed']);

export type MessageChannel = z.infer<typeof messageChannelSchema>;
export type OutboxStatus = z.infer<typeof outboxStatusSchema>;

const recipientSchema = z.object({
  name: z.string().default(''),
  address: z.string().default(''),
  locale: z.string().optional(),
});

const attachmentRefSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
});

export const outboxMessageSchema = z.object({
  id: z.string(),
  channel: messageChannelSchema,
  channelMode: z.string().default(''),
  to: z.array(recipientSchema).default([]),
  templateCode: z.string().default(''),
  subject: z.string(),
  body: z.string(),
  attachments: z.array(attachmentRefSchema).default([]),
  relatedTo: z
    .object({ entityType: z.string(), entityId: z.string() })
    .nullable()
    .default(null),
  status: outboxStatusSchema,
  attempts: z.number().int().default(0),
  lastError: z.string().nullable().default(null),
  sentAt: z.string().nullable().default(null),
  emlUrl: z.string().nullable().default(null),
});

export type OutboxMessageRow = z.infer<typeof outboxMessageSchema>;

export const inboxMessageSchema = z.object({
  id: z.string(),
  channel: messageChannelSchema,
  from: z.string().default(''),
  subject: z.string().default(''),
  body: z.string().default(''),
  receivedAt: z.string(),
  recognized: z.boolean(),
  serviceOrderId: z.string().nullable().default(null),
  suggestedAction: z.string().nullable().default(null),
  appliedAt: z.string().nullable().default(null),
});

export type InboxMessageRow = z.infer<typeof inboxMessageSchema>;

function listQuery(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams({ perPage: '100' });
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  return query.toString();
}

// ─────────────────────────── Исходящие ───────────────────────────

export function useOutbox(params: {
  channel?: string;
  status?: string;
}): UseQueryResult<Paged<OutboxMessageRow>> {
  return useQuery({
    queryKey: ['outbox', params.channel ?? '', params.status ?? ''],
    queryFn: ({ signal }) =>
      request(`/outbox?${listQuery(params)}`, pagedSchema(outboxMessageSchema), { signal }),
  });
}

/**
 * Повторная отправка `[ТЗ 3.5.2]`.
 *
 * Повторяется только то, что не ушло: сервер отказывает в повторе
 * отправленного, потому что второй экземпляр письма поставщик прочитает
 * как второй заказ.
 */
export function useRetryMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      request(`/outbox/${id}/retry`, outboxMessageSchema, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['outbox'] });
    },
  });
}

// ─────────────────────────── Входящие ───────────────────────────

export function useInbox(params: {
  unrecognizedOnly?: boolean;
}): UseQueryResult<Paged<InboxMessageRow>> {
  return useQuery({
    queryKey: ['inbox', params.unrecognizedOnly ?? false],
    queryFn: ({ signal }) =>
      request(
        `/inbox?${listQuery({
          unrecognizedOnly: params.unrecognizedOnly ? 'true' : undefined,
        })}`,
        pagedSchema(inboxMessageSchema),
        { signal },
      ),
  });
}

/**
 * Применение входящего к заявке `[ТЗ 3.2.2]`.
 *
 * Без параметров применяется то, что предложил разбор. С параметрами —
 * это ручной разбор письма, которое система не опознала.
 */
export function useApplyInbox() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; serviceOrderId?: string; transition?: string }) =>
      request(`/inbox/${input.id}/apply`, inboxMessageSchema, {
        method: 'POST',
        body: {
          ...(input.serviceOrderId ? { serviceOrderId: input.serviceOrderId } : {}),
          ...(input.transition ? { transition: input.transition } : {}),
        },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
      void queryClient.invalidateQueries({ queryKey: ['service-orders'] });
    },
  });
}

// ─────────────────────────── Уведомления ───────────────────────────

export const notificationSchema = z.object({
  id: z.string(),
  kind: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  title: z.string(),
  body: z.string().default(''),
  link: z.string().default(''),
  readAt: z.string().nullable().default(null),
  createdAt: z.string(),
});

export type NotificationRow = z.infer<typeof notificationSchema>;

export function useNotifications(unreadOnly = false): UseQueryResult<Paged<NotificationRow>> {
  return useQuery({
    queryKey: ['notifications', unreadOnly],
    queryFn: ({ signal }) =>
      request(
        `/notifications?${listQuery({ unreadOnly: unreadOnly ? 'true' : undefined })}`,
        pagedSchema(notificationSchema),
        { signal },
      ),
    // Колокольчик обновляется сам: событие приходит от чужого действия,
    // а не от действия читателя, и ждать перезагрузки страницы незачем.
    refetchInterval: 60_000,
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      request(`/notifications/${id}/read`, z.undefined(), { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

// ─────────────────────────── Шаблоны ───────────────────────────

const localizedSchema = z.object({ ru: z.string(), en: z.string() });

export const messageTemplateSchema = z.object({
  id: z.string(),
  code: z.string(),
  channel: messageChannelSchema,
  subject: localizedSchema,
  body: localizedSchema,
  variables: z.array(z.string()).default([]),
});

export type MessageTemplateRow = z.infer<typeof messageTemplateSchema>;

const templatesSchema = z.object({ data: z.array(messageTemplateSchema) });

export function useMessageTemplates(): UseQueryResult<MessageTemplateRow[]> {
  return useQuery({
    queryKey: ['message-templates'],
    queryFn: async ({ signal }) =>
      (await request('/message-templates', templatesSchema, { signal })).data,
  });
}

export function useUpdateMessageTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      id: string;
      subject: { ru: string; en: string };
      body: { ru: string; en: string };
    }) =>
      request(`/message-templates/${input.id}`, messageTemplateSchema, {
        method: 'PATCH',
        body: { subject: input.subject, body: input.body },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['message-templates'] });
    },
  });
}

const previewSchema = z.object({
  subject: z.string(),
  body: z.string(),
  // Без значения по умолчанию: сервер поле возвращает всегда, а `default`
  // сделал бы его необязательным в выводимом типе.
  missing: z.array(z.string()),
});

export type TemplatePreview = z.infer<typeof previewSchema>;

/**
 * Предпросмотр шаблона на выбранном рейсе `[ТЗ 3.5.2]`.
 *
 * Возвращает и перечень переменных без значения: пропуск должен быть
 * виден здесь, а не у получателя письма.
 */
export function usePreviewTemplate() {
  return useMutation({
    mutationFn: (input: { id: string; flightId: string; locale: 'ru' | 'en' }) =>
      request(`/message-templates/${input.id}/preview`, previewSchema, {
        method: 'POST',
        body: { flightId: input.flightId, locale: input.locale },
      }),
  });
}
