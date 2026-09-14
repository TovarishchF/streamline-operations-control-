import { useState, type JSX } from 'react';
import {
  Alert, App, Button, Col, Form, Input, Modal, Row, Select, Space,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';

import { useAircraftTypes, useAirports } from '@/api/catalog';
import { useClients } from '@/api/counterparties';
import { useCreateAircraft, type CreateAircraftInput } from '@/api/fleet';
import type { AircraftStatus } from '@/api/types';
import { DateOnlyPicker } from '@/shared/ui/DateTimePicker';
import { applyApiError } from '@/shared/ui/form-errors';

const STATUSES: AircraftStatus[] = ['serviceable', 'maintenance', 'aog'];
const APPROVAL_KINDS = ['ETOPS', 'RVSM', 'MNPS', 'CAT_II', 'CAT_III', 'RNP', 'other'] as const;

interface FormValues {
  registration: string;
  typeId: string;
  operatorId?: string;
  homeBaseIcao: string;
  status: AircraftStatus;
  notes?: string;
  approvals?: {
    kind: (typeof APPROVAL_KINDS)[number];
    number?: string;
    validFrom: Dayjs;
    validTo: Dayjs;
  }[];
}

/**
 * Постановка борта в парк `[ТЗ 3.1.3]`.
 *
 * Допуски заводятся здесь же, а не «потом»: истёкший или отсутствующий
 * допуск даёт конфликт расписания (ADR-027), и борт без допусков поведёт
 * себя в проверке иначе, чем предполагает диспетчер.
 */
export function AircraftFormModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [banner, setBanner] = useState<string | null>(null);
  const [airportSearch, setAirportSearch] = useState('');

  const types = useAircraftTypes().data?.data ?? [];
  const clients = useClients().data?.data ?? [];
  const airports = useAirports({ search: airportSearch, perPage: 30 }).data?.data ?? [];
  const createAircraft = useCreateAircraft();

  const close = (): void => {
    form.resetFields();
    setBanner(null);
    onClose();
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    setBanner(null);

    const payload: CreateAircraftInput = {
      registration: values.registration.trim().toUpperCase(),
      typeId: values.typeId,
      operatorId: values.operatorId ?? null,
      homeBaseIcao: values.homeBaseIcao,
      status: values.status,
      notes: values.notes ?? '',
      approvals: (values.approvals ?? []).map((approval) => ({
        kind: approval.kind,
        number: approval.number ?? '',
        validFrom: approval.validFrom.startOf('day').toISOString(),
        validTo: approval.validTo.endOf('day').toISOString(),
      })),
    };

    try {
      const created = await createAircraft.mutateAsync(payload);
      void message.success(t('fleet.created', { registration: created.registration }));
      close();
    } catch (error) {
      setBanner(applyApiError(error, form as never, t('common.saveFailed')));
    }
  };

  return (
    <Modal
      open={open}
      width={720}
      title={t('fleet.add')}
      okText={t('common.create')}
      cancelText={t('common.cancel')}
      confirmLoading={createAircraft.isPending}
      onCancel={close}
      onOk={() => {
        void submit();
      }}
      destroyOnClose
    >
      <Form<FormValues> form={form} layout="vertical" requiredMark preserve={false}>
        {banner ? (
          <Alert type="error" showIcon message={banner} style={{ marginBottom: 12 }} />
        ) : null}

        <Row gutter={12}>
          <Col xs={24} sm={8}>
            <Form.Item
              name="registration"
              label={t('fleet.registration')}
              rules={[{ required: true }]}
              normalize={(value: string) => value.toUpperCase()}
            >
              <Input autoFocus placeholder="RA-67231" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={16}>
            <Form.Item name="typeId" label={t('fleet.type')} rules={[{ required: true }]}>
              <Select
                showSearch
                optionFilterProp="label"
                options={types.map((type) => ({
                  value: type.id,
                  label: `${type.name.ru} (${type.icaoType})`,
                }))}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col xs={24} sm={8}>
            <Form.Item
              name="homeBaseIcao"
              label={t('fleet.homeBase')}
              rules={[{ required: true }]}
            >
              <Select
                showSearch
                filterOption={false}
                onSearch={setAirportSearch}
                options={airports.map((airport) => ({
                  value: airport.icao,
                  label: `${airport.icao} — ${airport.name.ru}`,
                }))}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={8}>
            <Form.Item
              name="status"
              label={t('fleet.status')}
              initialValue="serviceable"
              rules={[{ required: true }]}
            >
              <Select
                options={STATUSES.map((status) => ({
                  value: status,
                  label: t(`aircraftStatus.${status}`),
                }))}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={8}>
            <Form.Item
              name="operatorId"
              label={t('fleet.operator')}
              tooltip={t('fleet.operatorHint')}
            >
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                options={clients.map((client) => ({ value: client.id, label: client.name }))}
              />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item label={t('fleet.approvals')} tooltip={t('fleet.approvalsHint')}>
          <Form.List name="approvals">
            {(fields, { add, remove }) => (
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {fields.map((field) => (
                  <Row key={field.key} gutter={8}>
                    <Col xs={8} sm={6}>
                      <Form.Item
                        name={[field.name, 'kind']}
                        rules={[{ required: true }]}
                        style={{ marginBottom: 0 }}
                      >
                        <Select
                          options={APPROVAL_KINDS.map((kind) => ({ value: kind, label: kind }))}
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={14} sm={6}>
                      <Form.Item name={[field.name, 'number']} style={{ marginBottom: 0 }}>
                        <Input placeholder={t('fleet.approvalNumber')} />
                      </Form.Item>
                    </Col>
                    <Col xs={11} sm={5}>
                      <Form.Item
                        name={[field.name, 'validFrom']}
                        rules={[{ required: true }]}
                        style={{ marginBottom: 0 }}
                      >
                        <DateOnlyPicker style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                    <Col xs={11} sm={5}>
                      <Form.Item
                        name={[field.name, 'validTo']}
                        rules={[{ required: true }]}
                        style={{ marginBottom: 0 }}
                      >
                        <DateOnlyPicker style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                    <Col xs={2} sm={2}>
                      <Button
                        icon={<DeleteOutlined />}
                        aria-label={t('common.remove')}
                        onClick={() => {
                          remove(field.name);
                        }}
                      />
                    </Col>
                  </Row>
                ))}
                <Button
                  type="dashed"
                  icon={<PlusOutlined />}
                  onClick={() => {
                    add({ kind: 'RVSM' });
                  }}
                >
                  {t('fleet.addApproval')}
                </Button>
              </Space>
            )}
          </Form.List>
        </Form.Item>

        <Form.Item name="notes" label={t('fleet.notes')}>
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
