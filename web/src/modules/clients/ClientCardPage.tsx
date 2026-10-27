import { useState, type JSX } from 'react';
import {
  Alert, Button, Card, Col, Descriptions, Divider, Form, InputNumber, Row, Select, Space, Tabs,
  Tag, Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/client';
import { useServices } from '@/api/catalog';
import {
  useClient,
  useClientTariffs,
  useTariffSimulation,
  type SimulateTariffInput,
  type TariffRuleRow,
} from '@/api/counterparties';
import { Can } from '@/shared/auth/Can';
import { usePermission } from '@/shared/auth/session';
import { useLocalizedName } from '@/shared/i18n/useLocalizedName';
import { AirportSelect } from '@/shared/ui/AirportSelect';
import { DateTimePicker } from '@/shared/ui/DateTimePicker';
import { QueryState } from '@/shared/ui/QueryState';
import { DateText, EmptyState, MoneyText, Mono } from '@/shared/ui/primitives';
import { NotFoundPage } from '@/modules/misc/NotFoundPage';
import { TariffRuleModal } from './TariffRuleModal';

interface SandboxValues {
  serviceId: string;
  airportIcao: string;
  onDate: Dayjs;
  quantity: string;
  purchaseAmount?: string;
}

/**
 * Карточка клиента с тарифами и калькулятором-песочницей `[ТЗ 3.4.1]`.
 *
 * Песочница считает на сервере (`POST /clients/{id}/tariffs/simulate`)
 * тем же расчётом, что и цена продажи в заявке: какое правило сработало,
 * почему и как получена сумма (`SPEC.md § 7.1`). Своя арифметика здесь
 * показала бы цену, которой в заявке не будет (`CLAUDE.md § 3` п. 16).
 */
export function ClientCardPage(): JSX.Element {
  const { t } = useTranslation();
  const localized = useLocalizedName();
  const { id } = useParams<{ id: string }>();
  const clientQuery = useClient(id);
  const client = clientQuery.data;
  const canSeeTariffs = usePermission('tariff.view');
  const tariffs = useClientTariffs(id, canSeeTariffs);
  const rules = tariffs.data?.data ?? [];
  const services = useServices().data?.data ?? [];

  const [adding, setAdding] = useState(false);
  const [sandbox] = Form.useForm<SandboxValues>();
  const [simulated, setSimulated] = useState<SimulateTariffInput | null>(null);
  const simulation = useTariffSimulation(id, simulated);

  if (clientQuery.isError) return <NotFoundPage />;
  if (!client) return <QueryState query={clientQuery}>{() => null}</QueryState>;

  const serviceName = (serviceId: string): string => {
    const service = services.find((item) => item.id === serviceId);
    return service ? localized(service.name) : serviceId;
  };

  const runSandbox = async (): Promise<void> => {
    const values = await sandbox.validateFields();
    setSimulated({
      serviceId: values.serviceId,
      airportIcao: values.airportIcao,
      onDate: values.onDate.toISOString(),
      quantity: values.quantity,
      purchasePrice: values.purchaseAmount
        ? { amount: values.purchaseAmount, currency: client.settlementCurrency }
        : null,
    });
  };

  const tariffColumns: DataColumns<TariffRuleRow> = [
    {
      title: t('tariff.scope'), key: 'scope', width: 280,
      render: (_, row) => (
        <Space size={4} wrap>
          {row.scope.serviceId ? (
            <Tag color="blue" style={{ margin: 0 }}>{serviceName(row.scope.serviceId)}</Tag>
          ) : row.scope.category ? (
            <Tag style={{ margin: 0 }}>{t(`serviceCategory.${row.scope.category}`)}</Tag>
          ) : (
            <Tag style={{ margin: 0 }}>{t('tariff.allServices')}</Tag>
          )}
          {row.scope.airportIcao ? <Mono>{row.scope.airportIcao}</Mono> : null}
        </Space>
      ),
    },
    {
      title: t('tariff.priority'), dataIndex: 'priority', width: 110, align: 'right',
      render: (value: number) => <Mono>{value}</Mono>,
    },
    {
      title: t('tariff.mode'), key: 'mode', width: 220,
      render: (_, row) => {
        const pricing = row.pricing;
        if (pricing.mode === 'cost_plus') {
          return (
            <Space size={6}>
              <Tag style={{ margin: 0 }}>{t('tariffMode.cost_plus')}</Tag>
              <Mono>+{pricing.markupPercent} %</Mono>
            </Space>
          );
        }
        if (pricing.mode === 'fixed') {
          return (
            <Space size={6}>
              <Tag style={{ margin: 0 }}>{t('tariffMode.fixed')}</Tag>
              <MoneyText value={pricing.price} />
            </Space>
          );
        }
        return <Tag style={{ margin: 0 }}>{t('tariffMode.pass_through')}</Tag>;
      },
    },
    {
      title: t('tariff.discount'), key: 'discount', width: 130,
      render: (_, row) =>
        row.discount ? (
          <Mono>
            −{row.discount.value}
            {row.discount.kind === 'percent' ? ' %' : ` ${client.settlementCurrency}`}
          </Mono>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: t('catalog.validity'), key: 'validity', width: 220,
      render: (_, row) => (
        <Space size={4}>
          <DateText value={row.validFrom} />
          <span>—</span>
          <DateText value={row.validTo} />
        </Space>
      ),
    },
  ];

  const result = simulation.data;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small">
        <Space direction="vertical" size={2}>
          <Space size={8} wrap align="center">
            <Typography.Title level={4} style={{ margin: 0 }}>{client.name}</Typography.Title>
            {!client.isActive ? <Tag>{t('common.inactive')}</Tag> : null}
            <Tag><Mono>{client.settlementCurrency}</Mono></Tag>
          </Space>
          <Typography.Text type="secondary">{client.legalName}</Typography.Text>
        </Space>
      </Card>

      <Tabs
        items={[
          {
            key: 'profile',
            label: t('client.tabs.profile'),
            children: (
              <Card size="small">
                <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered>
                  <Descriptions.Item label={t('client.country')}>
                    <Mono>{client.country}</Mono>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('client.currency')}>
                    <Mono>{client.settlementCurrency}</Mono>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('client.paymentTerms')}>
                    {t(`paymentMode.${client.paymentTerms.mode}`)}
                    {client.paymentTerms.deferDays
                      ? `, ${String(client.paymentTerms.deferDays)} ${t('common.days')}`
                      : ''}
                    {client.paymentTerms.prepaymentPercent
                      ? `, ${client.paymentTerms.prepaymentPercent} %`
                      : ''}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('client.creditLimit')}>
                    <MoneyText value={client.creditLimit} />
                  </Descriptions.Item>
                  <Descriptions.Item label={t('client.locale')}>
                    <Tag>{client.defaultLocale.toUpperCase()}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('client.contact')} span={2}>
                    {client.contacts.length > 0 ? (
                      <Space direction="vertical" size={2}>
                        {client.contacts.map((contact) => (
                          <Space key={contact.email} size={8} wrap>
                            <span>{contact.name}</span>
                            {contact.role ? (
                              <Typography.Text type="secondary">{contact.role}</Typography.Text>
                            ) : null}
                            <Mono>{contact.email}</Mono>
                            {contact.isPrimary ? <Tag color="blue">{t('client.primary')}</Tag> : null}
                          </Space>
                        ))}
                      </Space>
                    ) : (
                      <Typography.Text type="secondary">—</Typography.Text>
                    )}
                  </Descriptions.Item>
                </Descriptions>
              </Card>
            ),
          },
          ...(canSeeTariffs
            ? [
                {
                  key: 'tariffs',
                  label: `${t('client.tabs.tariffs')} (${String(rules.length)})`,
                  children: (
                    <Row gutter={[12, 12]}>
                      <Col xs={24} lg={14}>
                        <Card
                          size="small"
                          title={t('client.tabs.tariffs')}
                          extra={
                            <Can permission="tariff.edit">
                              <Button
                                size="small"
                                type="primary"
                                icon={<PlusOutlined />}
                                onClick={() => {
                                  setAdding(true);
                                }}
                              >
                                {t('tariff.add')}
                              </Button>
                            </Can>
                          }
                          styles={{ body: { padding: 0 } }}
                        >
                          <QueryState query={tariffs}>
                            {() => (
                              <DataTable<TariffRuleRow>
                                size="small" rowKey="id" columns={tariffColumns} dataSource={rules}
                                pagination={false} scroll={{ x: 900 }}
                                locale={{ emptyText: <EmptyState description={t('tariff.noRules')} /> }}
                              />
                            )}
                          </QueryState>
                        </Card>
                      </Col>

                      <Col xs={24} lg={10}>
                        <Card size="small" title={t('tariff.sandbox')}>
                          <Space direction="vertical" size={12} style={{ width: '100%' }}>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {t('tariff.sandboxHint')}
                            </Typography.Text>

                            <Form<SandboxValues>
                              form={sandbox}
                              layout="vertical"
                              initialValues={{ quantity: '1' }}
                              onFinish={() => {
                                void runSandbox();
                              }}
                            >
                              <Form.Item
                                name="serviceId"
                                label={t('service.name')}
                                rules={[{ required: true, message: t('common.required') }]}
                              >
                                <Select
                                  showSearch
                                  optionFilterProp="label"
                                  options={services.map((service) => ({
                                    value: service.id,
                                    label: `${service.code} · ${localized(service.name)}`,
                                  }))}
                                />
                              </Form.Item>
                              <Form.Item
                                name="airportIcao"
                                label={t('flight.airport')}
                                rules={[{ required: true, message: t('common.required') }]}
                              >
                                <AirportSelect />
                              </Form.Item>
                              <Row gutter={8}>
                                <Col xs={24} sm={14}>
                                  <Form.Item
                                    name="onDate"
                                    label={t('tariff.onDate')}
                                    rules={[{ required: true, message: t('common.required') }]}
                                  >
                                    <DateTimePicker style={{ width: '100%' }} />
                                  </Form.Item>
                                </Col>
                                <Col xs={24} sm={10}>
                                  <Form.Item
                                    name="quantity"
                                    label={t('service.quantity')}
                                    rules={[{ required: true, message: t('common.required') }]}
                                  >
                                    <InputNumber<string> stringMode min="0" precision={4} style={{ width: '100%' }} />
                                  </Form.Item>
                                </Col>
                              </Row>
                              <Form.Item
                                name="purchaseAmount"
                                label={t('tariff.purchaseUnitPrice')}
                                extra={t('tariff.purchaseUnitPriceHint')}
                              >
                                <InputNumber<string>
                                  stringMode
                                  min="0"
                                  precision={2}
                                  addonAfter={client.settlementCurrency}
                                  style={{ width: '100%' }}
                                />
                              </Form.Item>
                              <Button htmlType="submit" type="primary" loading={simulation.isFetching}>
                                {t('tariff.calculate')}
                              </Button>
                            </Form>

                            {simulation.isError ? (
                              <Alert
                                type="error"
                                showIcon
                                message={
                                  simulation.error instanceof ApiError
                                    ? simulation.error.message
                                    : t('common.error')
                                }
                              />
                            ) : null}

                            {result ? (
                              <>
                                <Divider style={{ margin: '4px 0' }} />
                                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                    {t('tariff.explanation')}
                                  </Typography.Text>
                                  {result.explanation.map((step, index) => (
                                    <Space key={`${step.step}:${String(index)}`} size={6} wrap>
                                      <Tag style={{ margin: 0 }}>{t(`tariff.step.${step.step}`, step.step)}</Tag>
                                      <Typography.Text style={{ fontSize: 12 }}>{step.detail}</Typography.Text>
                                      {step.value ? <Mono>{step.value}</Mono> : null}
                                    </Space>
                                  ))}
                                </Space>

                                <Alert
                                  type="success"
                                  message={
                                    <Space size={8}>
                                      <span>{t('service.salePrice')}:</span>
                                      <MoneyText value={result.salePrice} strong />
                                    </Space>
                                  }
                                />

                                {result.candidateRules.length > 0 ? (
                                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                      {t('tariff.candidates')}
                                    </Typography.Text>
                                    {result.candidateRules.map((candidate) => (
                                      <Typography.Text
                                        key={candidate.ruleId}
                                        type={candidate.selected ? undefined : 'secondary'}
                                        style={{ fontSize: 12 }}
                                      >
                                        {candidate.selected ? <Tag color="green">{t('tariff.selected')}</Tag> : null}
                                        <Mono>{candidate.ruleId}</Mono> — {candidate.reason}
                                      </Typography.Text>
                                    ))}
                                  </Space>
                                ) : null}
                              </>
                            ) : null}
                          </Space>
                        </Card>
                      </Col>
                    </Row>
                  ),
                },
              ]
            : []),
        ]}
      />

      <TariffRuleModal
        clientId={client.id}
        currency={client.settlementCurrency}
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
      />
    </Space>
  );
}
