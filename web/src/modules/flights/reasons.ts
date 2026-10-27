/**
 * Справочник причин отмены и AOG (`SPEC.md § 4.4`): выбирается из списка,
 * а не вводится текстом, чтобы причины можно было считать в отчётах.
 * Один список для панели статуса и для массовых действий.
 */
export const FLIGHT_REASON_CODES: Record<'cancel' | 'aog', readonly string[]> = {
  cancel: ['client_request', 'weather', 'technical', 'no_permit', 'commercial', 'other'],
  aog: ['technical', 'crew', 'weather', 'airport', 'other'],
};
