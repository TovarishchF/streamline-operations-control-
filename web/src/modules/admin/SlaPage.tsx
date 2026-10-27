import { useState, type JSX } from 'react';
import {
  App, Button, Card, Col, Form, InputNumber, Modal, Row, Select, Space, Tag, Typography,
} from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useTranslation } from 'react-i18next';

import {
  useCreateSlaRule,
  useSettings,
  useSlaRules,
  useUpdateSettings,
  type SlaRuleRow,
} from '@/api/admin';
import { ApiError } from '@/api/client';
import { useVendors } from '@/api/counterparties';
import { EmptyState, Mono } from '@/shared/ui/primitives';
import { QueryState } from '@/shared/ui/QueryState';

const CATEGORIES = ['fuel', 'handling', 'catering', 'transport', 'permits', 'deicing'] as const;
const SLA_WEIGHT_KEYS = ['onTimeConfirm', 'slaCompliance', 'billing', 'quality'] as const;
const SUGGEST_WEIGHT_KEYS = ['price', 'rating', 'proximity'] as const;

/**
 * Правила SLA и веса рейтинга поставщика `[ТЗ 3.2.3, 3.3.1]`.
 *
 * G-39: института SLA в оригинальном ТЗ нет — упомянуты только «штрафы
 * за нарушение SLA» в целях. Значения по умолчанию заданы нами и подлежат
 * замене на реальные сроки из договоров заказчика. Новое правило вытесняет
 * прежнее той же области, история остаётся.
 */
export function SlaPage(): JSX.Element {
  const { t } = useTranslation();
  const rules = useSlaRules();
  const vendors = useVendors().data?.data ?? [];
  const [adding, setAdding] = useState(false);

  const columns: DataColumns<SlaRuleRow> = [
    {
      title: t('sla.scope'), key: 'scope', width: 300,
      render: (_, row) =>
        row.scope.vendorId ? (
          <Space size={4} wrap>
            <Tag color="blue">{t('sla.byVendor')}</Tag>
            <span>{vendors.find((v) => v.id === row.scope.vendorId)?.name ?? row.scope.vendorId}</span>
            {row.scope.category ? <span>· {t(`serviceCategory.${row.scope.category}`)}</span> : null}
          </Space>
        ) : row.scope.category ? (
          <Space size={4}>
            <Tag>{t('sla.byCategory')}</Tag>
            <span>{t(`serviceCategory.${row.scope.category}`)}</span>
          </Space>
        ) : (
          <Tag>{t('sla.default')}</Tag>
        ),
    },
    {
      title: t('sla.confirmMinutes'), dataIndex: 'confirmMinutes', width: 180, align: 'right',
      render: (value: number) => <Mono>{t('sla.minutesValue', { value })}</Mono>,
    },
    {
      title: t('sla.completionMinutes'), dataIndex: 'completionMinutes', width: 180, align: 'right',
      render: (value: number | null) =>
        value === null ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Mono>{t('sla.minutesValue', { value })}</Mono>
        ),
    },
    {
      title: t('sla.penalty'), key: 'penalty', width: 160,
      render: (_, row) =>
        row.penalty.kind === 'none' || !row.penalty.value ? (
          <Typography.Text type="secondary">{t('sla.noPenalty')}</Typography.Text>
        ) : (
          <Mono>
            {row.penalty.value}
            {row.penalty.kind === 'percent' ? ' %' : ''}
          </Mono>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row align="middle" gutter={[8, 8]}>
        <Col flex="auto">
          <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.sla')}</Typography.Title>
        </Col>
        <Col>
          <Button type="primary" onClick={() => { setAdding(true); }}>
            {t('sla.add')}
          </Button>
        </Col>
      </Row>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <QueryState query={rules}>
          {(list) => (
            <DataTable<SlaRuleRow>
              size="small" rowKey="id" columns={columns} dataSource={list.data}
              pagination={false} scroll={{ x: 820 }}
              locale={{ emptyText: <EmptyState /> }}
            />
          )}
        </QueryState>
      </Card>

      <WeightsCard />

      <SlaRuleModal
        open={adding}
        vendors={vendors.map((vendor) => ({ value: vendor.id, label: vendor.name }))}
        onClose={() => { setAdding(false); }}
      />
    </Space>
  );
}

/**
 * Веса рейтинга (`DOMAIN.md § 7.4`) и подбора «сбалансированно» (`§ 7.5`).
 * Сумма весов — единица; проверяет её сервер, ошибка показывается как есть.
 */
function WeightsCard(): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const settings = useSettings();
  const update = useUpdateSettings();
  const [sla, setSla] = useState<Record<string, string> | null>(null);
  const [suggest, setSuggest] = useState<Record<string, string> | null>(null);

  const slaValues = sla ?? settings.data?.slaWeights ?? {};
  const suggestValues = suggest ?? settings.data?.vendorSuggestWeights ?? {};

  const save = async (): Promise<void> => {
    try {
      await update.mutateAsync({
        ...(sla ? { slaWeights: sla } : {}),
        ...(suggest ? { vendorSuggestWeights: suggest } : {}),
      });
      setSla(null);
      setSuggest(null);
      void message.success(t('sla.weightsSaved'));
    } catch (error) {
      void message.error(error instanceof ApiError ? error.message : t('common.saveFailed'));
    }
  };

  const field = (
    label: string,
    value: string | undefined,
    onChange: (next: string) => void,
  ): JSX.Element => (
    <Space key={label} direction="vertical" size={0}>
      <Typography.Text style={{ fontSize: 12 }}>{label}</Typography.Text>
      <InputNumber<string>
        stringMode
        step="0.05"
        min="0"
        max="1"
        precision={2}
        aria-label={label}
        value={value ?? null}
        onChange={(next) => {
          onChange(next ?? '0');
        }}
        style={{ width: 110 }}
      />
    </Space>
  );

  return (
    <Card size="small" title={t('sla.weights')}>
      <QueryState query={settings} skeletonRows={2}>
        {() => (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('sla.weightsHint')}
            </Typography.Text>
            <Space size={16} wrap>
              {SLA_WEIGHT_KEYS.map((key) =>
                field(t(`sla.weight_${key}`), slaValues[key], (next) => {
                  setSla({ ...slaValues, [key]: next });
                }),
              )}
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('sla.suggestWeightsHint')}
            </Typography.Text>
            <Space size={16} wrap>
              {SUGGEST_WEIGHT_KEYS.map((key) =>
                field(t(`vendor.weight_${key}`), suggestValues[key], (next) => {
                  setSuggest({ ...suggestValues, [key]: next });
                }),
              )}
            </Space>
            <Button
              type="primary"
              disabled={!sla && !suggest}
              loading={update.isPending}
              onClick={() => { void save(); }}
            >
              {t('common.save')}
            </Button>
          </Space>
        )}
      </QueryState>
    </Card>
  );
}

interface SlaFormValues {
  category?: string;
  vendorId?: string;
  confirmMinutes: number;
  completionMinutes?: number;
  penaltyKind: 'none' | 'fixed' | 'percent';
  penaltyValue?: string;
}

/** Новое правило SLA: категория, поставщик либо оба; пустая область — общее правило. */
function SlaRuleModal({
  open,
  vendors,
  onClose,
}: {
  open: boolean;
  vendors: { value: string; label: string }[];
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [form] = Form.useForm<SlaFormValues>();
  const create = useCreateSlaRule();
  const penaltyKind = Form.useWatch('penaltyKind', form);

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    try {
      await create.mutateAsync({
        scope: { category: values.category ?? null, vendorId: values.vendorId ?? null },
        confirmMinutes: values.confirmMinutes,
        completionMinutes: values.completionMinutes ?? null,
        penalty: {
          kind: values.penaltyKind,
          value: values.penaltyKind === 'none' ? null : (values.penaltyValue ?? null),
        },
      });
      void message.success(t('sla.created'));
      form.resetFields();
      onClose();
    } catch (error) {
      void message.error(error instanceof ApiError ? error.message : t('common.saveFailed'));
    }
  };

  return (
    <Modal
      open={open}
      title={t('sla.add')}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={create.isPending}
      onCancel={onClose}
      onOk={() => { void submit(); }}
      destroyOnClose
    >
      <Form<SlaFormValues>
        form={form}
        layout="vertical"
        requiredMark
        preserve={false}
        initialValues={{ penaltyKind: 'none', confirmMinutes: 120 }}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {t('sla.addHint')}
        </Typography.Paragraph>
        <Form.Item name="category" label={t('service.category')}>
          <Select
            allowClear
            options={CATEGORIES.map((value) => ({ value, label: t(`serviceCategory.${value}`) }))}
          />
        </Form.Item>
        <Form.Item name="vendorId" label={t('service.vendor')}>
          <Select allowClear showSearch optionFilterProp="label" options={vendors} />
        </Form.Item>
        <Form.Item
          name="confirmMinutes"
          label={t('sla.confirmMinutes')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <InputNumber min={1} precision={0} addonAfter={t('common.minutesShort')} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="completionMinutes" label={t('sla.completionMinutes')} extra={t('sla.completionHint')}>
          <InputNumber min={1} precision={0} addonAfter={t('common.minutesShort')} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="penaltyKind" label={t('sla.penalty')}>
          <Select
            options={[
              { value: 'none', label: t('sla.noPenalty') },
              { value: 'percent', label: t('sla.penaltyPercent') },
              { value: 'fixed', label: t('sla.penaltyFixed') },
            ]}
          />
        </Form.Item>
        {penaltyKind !== 'none' ? (
          <Form.Item
            name="penaltyValue"
            label={t('sla.penaltyValue')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <InputNumber<string> stringMode min="0" precision={2} style={{ width: '100%' }} />
          </Form.Item>
        ) : null}
      </Form>
    </Modal>
  );
}
