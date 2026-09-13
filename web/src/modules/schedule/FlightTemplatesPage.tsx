import { useState, type JSX } from 'react';
import {
  Alert, Button, Card, DatePicker, Form, Modal, Space, Table, Tag, Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';

import type { FlightTemplate } from '@/api/types';
import { CLIENT_BY_ID } from '@/mocks/counterparties';
import { FLIGHT_TEMPLATES } from '@/mocks/flights';
import { AIRCRAFT_TYPE_BY_ID, AIRPORT_UTC_OFFSET, SERVICE_BY_ID } from '@/mocks/reference';
import { Can } from '@/shared/auth/Can';
import { EmptyState, Mono } from '@/shared/ui/primitives';

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
  const [generating, setGenerating] = useState<FlightTemplate | null>(null);

  const columns: ColumnsType<FlightTemplate> = [
    { title: t('template.name'), dataIndex: 'name', width: 260, fixed: 'left' },
    {
      title: t('flight.client'), dataIndex: 'clientId', width: 200,
      render: (value: string) => CLIENT_BY_ID.get(value)?.name ?? value,
    },
    {
      title: t('flight.route'), key: 'route', width: 130,
      render: (_, row) => <Mono>{row.depIcao} → {row.arrIcao}</Mono>,
    },
    {
      title: t('template.depTimeLocal'), dataIndex: 'depTimeLocal', width: 170,
      render: (value: string, row) => {
        const offset = AIRPORT_UTC_OFFSET[row.depIcao] ?? 0;
        return (
          <Space direction="vertical" size={0}>
            <Mono>{value} LT</Mono>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <Mono>UTC{offset >= 0 ? '+' : ''}{offset}</Mono>
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: t('template.aircraftType'), dataIndex: 'aircraftTypeId', width: 180,
      render: (value: string) => AIRCRAFT_TYPE_BY_ID.get(value)?.name.ru ?? value,
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
          {(row.defaultServices ?? [])
            .map((item) => SERVICE_BY_ID.get(item.serviceId ?? '')?.name.ru ?? item.serviceId)
            .join(', ')}
        </Typography.Text>
      ),
    },
    {
      title: t('common.actions'), key: 'actions', width: 150, fixed: 'right',
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
          <Button type="primary">{t('template.create')}</Button>
        </Can>
      </Space>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Table<FlightTemplate>
          size="small" rowKey="id" columns={columns} dataSource={FLIGHT_TEMPLATES}
          pagination={false} scroll={{ x: 1300 }}
          locale={{ emptyText: <EmptyState /> }}
        />
      </Card>

      <Modal
        open={generating !== null}
        title={t('template.generateTitle', { name: generating?.name ?? '' })}
        okText={t('template.previewSeries')}
        cancelText={t('common.cancel')}
        width={600}
        onCancel={() => { setGenerating(null); }}
        onOk={() => { setGenerating(null); }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Form layout="vertical">
            <Form.Item label={t('template.period')} required>
              <DatePicker.RangePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label={t('template.exceptions')}>
              <DatePicker multiple style={{ width: '100%' }} />
            </Form.Item>
          </Form>

          <Alert type="info" showIcon message={t('template.dstNotice')} />
          <Alert type="warning" showIcon message={t('template.editDoesNotAffectExisting')} />
        </Space>
      </Modal>
    </Space>
  );
}
