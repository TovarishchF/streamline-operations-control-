import { useState, type JSX } from 'react';
import {
  Alert, App, Button, Card, DatePicker, Form, Modal, Space, Tag, Typography,
} from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import type { Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';

import { useAircraftTypes, useServices } from '@/api/catalog';
import { ApiError } from '@/api/client';
import { useClients } from '@/api/counterparties';
import {
  useCreateTemplate,
  useFlightTemplates,
  useGenerateSeries,
  type FlightTemplateRow,
} from '@/api/flights';
import { Can } from '@/shared/auth/Can';
import { EmptyState, Mono } from '@/shared/ui/primitives';

import { TemplateFormModal } from './TemplateFormModal';

const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * Шаблоны регулярных рейсов `[ТЗ 3.1.1]`.
 *
 * Время вылета хранится **в локальной зоне аэропорта вылета** и переводится
 * в UTC на каждую дату отдельно — с учётом перехода на летнее время. Хранение
 * шаблона сразу в UTC ломало бы расписание дважды в год.
 *
 * Изменение шаблона не трогает уже созданные рейсы, и это написано подсказкой
 * в форме (`SPEC.md § 4.5`): иначе диспетчер решит, что правка применится
 * задним числом.
 */
export function FlightTemplatesPage(): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();

  const [generating, setGenerating] = useState<FlightTemplateRow | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [period, setPeriod] = useState<[Dayjs, Dayjs] | null>(null);

  const templates = useFlightTemplates();
  const generateSeries = useGenerateSeries();
  const createTemplate = useCreateTemplate();

  // Справочники для названий: шаблон хранит связи, а не копии наименований.
  const clients = new Map(
    (useClients().data?.data ?? []).map((client) => [client.id, client.name]),
  );
  const types = new Map(
    (useAircraftTypes().data?.data ?? []).map((type) => [type.id, type.icaoType]),
  );
  const services = new Map(
    (useServices().data?.data ?? []).map((service) => [service.id, service.name.ru]),
  );

  const generate = async (): Promise<void> => {
    if (!generating || !period) return;
    try {
      const created = await generateSeries.mutateAsync({
        id: generating.id,
        fromDate: period[0].format('YYYY-MM-DD'),
        toDate: period[1].format('YYYY-MM-DD'),
      });
      void message.success(t('template.generated', { count: created.data.length }));
      setGenerating(null);
      setPeriod(null);
    } catch (error) {
      void message.error(
        error instanceof ApiError ? error.message : t('template.generateFailed'),
      );
    }
  };

  const columns: DataColumns<FlightTemplateRow> = [
    { title: t('template.name'), dataIndex: 'name', width: 260, fixed: 'left' },
    {
      title: t('flight.client'), dataIndex: 'clientId', width: 200,
      render: (value: string) => clients.get(value) ?? value,
    },
    {
      title: t('flight.route'), key: 'route', width: 130,
      render: (_, row) => <Mono>{row.depIcao} → {row.arrIcao}</Mono>,
    },
    {
      title: t('template.aircraftType'), dataIndex: 'aircraftTypeId', width: 120,
      render: (value: string) => <Mono>{types.get(value) ?? value}</Mono>,
    },
    {
      title: t('template.depTimeLocal'), dataIndex: 'depTimeLocal', width: 130,
      render: (value: string) => <Mono>{value} LT</Mono>,
    },
    {
      title: t('template.weekdays'), dataIndex: 'weekdays', width: 220,
      render: (value: number[]) => (
        <Space size={2} wrap>
          {WEEKDAY_KEYS.map((key, index) => (
            <Tag
              key={key}
              color={value.includes(index + 1) ? 'blue' : 'default'}
              style={{ margin: 0, opacity: value.includes(index + 1) ? 1 : 0.4 }}
            >
              {t(`weekday.${key}`)}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: t('template.defaultServices'), key: 'services', ellipsis: true,
      render: (_, row) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {row.defaultServices
            .map((item) => services.get(item.serviceId) ?? item.serviceId)
            .join(', ')}
        </Typography.Text>
      ),
    },
    {
      title: t('common.actions'), key: 'actions', sortable: false, width: 150, fixed: 'right',
      render: (_, row) => (
        <Can permission="flight.create">
          <Button size="small" type="primary" onClick={() => { setGenerating(row); }}>
            {t('template.generate')}
          </Button>
        </Can>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.templates')}</Typography.Title>
        <Can permission="flight.create">
          <Button
            type="primary"
            loading={createTemplate.isPending}
            onClick={() => { setFormOpen(true); }}
          >
            {t('template.create')}
          </Button>
        </Can>
      </Space>

      {templates.isError ? <Alert type="error" showIcon message={t('common.error')} /> : null}

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <DataTable<FlightTemplateRow>
          size="small" rowKey="id" columns={columns}
          dataSource={templates.data?.data ?? []}
          loading={templates.isFetching}
          pagination={false} scroll={{ x: 1300 }}
          locale={{ emptyText: <EmptyState description={t('template.empty')} /> }}
        />
      </Card>

      <TemplateFormModal open={formOpen} onClose={() => { setFormOpen(false); }} />

      <Modal
        open={generating !== null}
        title={t('template.generateTitle', { name: generating?.name ?? '' })}
        okText={t('template.generate')}
        cancelText={t('common.cancel')}
        width={600}
        okButtonProps={{ disabled: period === null }}
        confirmLoading={generateSeries.isPending}
        onCancel={() => { setGenerating(null); setPeriod(null); }}
        onOk={() => { void generate(); }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Form layout="vertical">
            <Form.Item label={t('template.period')} required>
              <DatePicker.RangePicker
                style={{ width: '100%' }}
                value={period}
                onChange={(value) => {
                  setPeriod(
                    value && value[0] && value[1] ? [value[0], value[1]] : null,
                  );
                }}
              />
            </Form.Item>
          </Form>

          <Alert type="info" showIcon message={t('template.dstNotice')} />
          <Alert type="warning" showIcon message={t('template.editDoesNotAffectExisting')} />
        </Space>
      </Modal>
    </Space>
  );
}
