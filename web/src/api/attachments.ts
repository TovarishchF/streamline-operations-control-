/**
 * Вложения `[ТЗ 3.3.3]`.
 *
 * Файл идёт из браузера **прямо в объектное хранилище** по подписанной
 * ссылке, минуя сервер приложения (ADR-007). Порядок жёсткий:
 *
 * 1. `POST /attachments` — сервер проверяет тип и размер и выдаёт ссылку;
 * 2. `PUT` по этой ссылке — байты идут в хранилище;
 * 3. `POST /attachments/{id}/confirm` — сервер убеждается, что файл дошёл.
 *
 * Только после третьего шага идентификатор можно передавать в создание
 * договора: незавершённую загрузку сервер отбросит.
 */
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';

import { ApiError, request } from './client';

export const attachmentKindSchema = z.enum([
  'act',
  'receipt',
  'invoice',
  'waybill',
  'contract',
  'other',
]);

export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

export const attachmentRefSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  kind: attachmentKindSchema,
  storageKey: z.string(),
  downloadUrl: z.string().nullable(),
  uploadedAt: z.string().nullable(),
  uploadedBy: z.string().nullable(),
});

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

const attachmentUploadSchema = z.object({
  attachment: attachmentRefSchema,
  uploadUrl: z.string(),
  expiresInSeconds: z.number().int(),
});

/**
 * Загружает файл и возвращает готовое вложение.
 *
 * Все три шага — одна операция с точки зрения человека: он выбрал файл
 * и ждёт результата. Разбивать их на три кнопки было бы издевательством.
 */
export async function uploadAttachment(
  file: File,
  kind: AttachmentKind,
): Promise<AttachmentRef> {
  const reserved = await request('/attachments', attachmentUploadSchema, {
    method: 'POST',
    body: {
      fileName: file.name,
      // Браузер не всегда определяет тип: у файла, перетащенного из архива,
      // `type` бывает пустым. Сервер отказал бы с невнятным сообщением.
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      kind,
    },
  });

  const put = await fetch(reserved.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });

  if (!put.ok) {
    throw new ApiError(
      put.status,
      'UPLOAD_FAILED',
      `Не удалось передать файл в хранилище (HTTP ${String(put.status)})`,
      {},
    );
  }

  return request(`/attachments/${reserved.attachment.id}/confirm`, attachmentRefSchema, {
    method: 'POST',
  });
}

export function useUploadAttachment() {
  return useMutation({
    mutationFn: (input: { file: File; kind: AttachmentKind }) =>
      uploadAttachment(input.file, input.kind),
  });
}
