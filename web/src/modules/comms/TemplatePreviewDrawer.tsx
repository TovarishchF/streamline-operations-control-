import { useState, type JSX } from 'react';
import { Alert, Button, Card, Drawer, Select, Space, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { usePreviewTemplate, type MessageTemplateRow } from '@/api/comms';
import { useFlights } from '@/api/flights';
import { Mono } from '@/shared/ui/primitives';

/**
 * Предпросмотр шаблона на выбранном рейсе `[ТЗ 3.5.2]` (`SPEC.md § 8.2`).
 *
 * Собирает сервер — тем же сборщиком, что и настоящую отправку. Собирать
 * текст в браузере значило бы показывать не то письмо, которое уйдёт,
 * а ради этого предпросмотр и существует.
 *
 * Отдельно показываются переменные, для которых на выбранном рейсе
 * не нашлось значения: письмо с провалом посреди фразы уходить получателю
 * не должно.
 */
export function TemplatePreviewDrawer({
  open,
  template,
  locale,
  onClose,
}: {
  open: boolean;
  template: MessageTemplateRow;
  locale: 'ru' | 'en';
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [flightId, setFlightId] = useState<string | undefined>();

  const flights = useFlights({});
  const preview = usePreviewTemplate();

  const build = (id: string): void => {
    setFlightId(id);
    preview.mutate({ id: template.id, flightId: id, locale });
  };

  return (
    <Drawer
      open={open}
      width={640}
      title={
        <Space size={8}>
          {t('comms.preview')}
          <Mono>{template.code}</Mono>
          <Tag>{locale.toUpperCase()}</Tag>
        </Space>
      }
      onClose={onClose}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space size={8} wrap>
          <Select
            style={{ minWidth: 260 }}
            placeholder={t('comms.previewFlight')}
            showSearch
            optionFilterProp="label"
            loading={flights.isLoading}
            value={flightId}
            onChange={build}
            options={(flights.data?.data ?? []).map((flight) => ({
              value: flight.id,
              label: `${flight.number} · ${flight.depIcao} → ${flight.arrIcao}`,
            }))}
          />
          <Button
            disabled={!flightId}
            loading={preview.isPending}
            onClick={() => {
              if (flightId) build(flightId);
            }}
          >
            {t('comms.previewRefresh')}
          </Button>
        </Space>

        {preview.isError ? (
          <Alert type="error" showIcon message={t('comms.previewFailed')} />
        ) : null}

        {preview.data ? (
          <>
            {preview.data.missing.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                message={t('comms.previewMissing')}
                description={
                  <Space size={4} wrap>
                    {preview.data.missing.map((name) => (
                      <Tag key={name} style={{ margin: 0 }}>
                        <Mono>{`{{${name}}}`}</Mono>
                      </Tag>
                    ))}
                  </Space>
                }
              />
            ) : null}

            <Typography.Text strong>{preview.data.subject}</Typography.Text>

            <Card size="small" styles={{ body: { padding: 12 } }}>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
                {preview.data.body}
              </pre>
            </Card>
          </>
        ) : (
          <Typography.Text type="secondary">{t('comms.previewHint')}</Typography.Text>
        )}
      </Space>
    </Drawer>
  );
}
