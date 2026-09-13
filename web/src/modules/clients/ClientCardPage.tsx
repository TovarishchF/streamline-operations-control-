import { useMemo, useState, type JSX } from 'react';
import {
  Alert, Button, Card, Col, Descriptions, Divider, InputNumber, Row, Select, Space, Table, Tabs,
  Tag, Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { TariffRule } from '@/api/types';
import { CLIENT_BY_ID, TARIFF_RULES } from '@/mocks/counterparties';
import { AIRPORTS, SERVICES, SERVICE_BY_ID, SERVICE_CATEGORIES } from '@/mocks/reference';
import { DateText, EmptyState, MoneyText, Mono } from '@/shared/ui/primitives';
import { NotFoundPage } from '@/modules/misc/NotFoundPage';

/**
 * Приоритет тарифного правила `DOMAIN.md § 7.2`.
 *
 * Услуга (3) → категория (2) → всё (1); совпадение аэропорта добавляет 1.
 * При равном приоритете выигрывает более поздний `validFrom`.
 */
function priorityOf(rule: TariffRule): number {
  let priority = 1;
  if (rule.scope.serviceId) priority = 3;
  else if (rule.scope.category) priority = 2;
  if (rule.scope.airportIcao) priority += 1;
  return priority;
}

/** Карточка клиента с тарифами и калькулятором-песочницей `[ТЗ 3.4.1]`. */
export function ClientCardPage(): JSX.Element {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const client = id ? CLIENT_BY_ID.get(id) : undefined;

  const [serviceId, setServiceId] = useState<string>('svc_hnd_basic');
  const [airport, setAirport] = useState<string>('UUEE');
  const [purchase, setPurchase] = useState<number>(48000);

  const rules = useMemo(
    () => TARIFF_RULES.filter((rule) => rule.clientId === id),
    [id],
  );

  /**
   * Песочница: показывает, **какое правило сработало и почему**
   * (`SPEC.md § 7.1`). Без объяснимости тарифная логика неотлаживаема.
   *
   * `CLAUDE.md § 3` п. 16 — на сервере это `POST /clients/{id}/tariffs/simulate`;
   * здесь воспроизведён вид ответа для утверждения компоновки.
   */
  const simulation = useMemo(() => {
    const service = SERVICE_BY_ID.get(serviceId);
    const candidates = rules
      .filter((rule) => {
        if (rule.scope.serviceId && rule.scope.serviceId !== serviceId) return false;
        if (rule.scope.category && rule.scope.category !== service?.category) return false;
        if (rule.scope.airportIcao && rule.scope.airportIcao !== airport) return false;
        return true;
      })
      .map((rule) => ({ rule, priority: priorityOf(rule) }))
      .sort((a, b) =>
        b.priority - a.priority || b.rule.validFrom.localeCompare(a.rule.validFrom),
      );

    const winner = candidates[0];
    if (!winner) {
      return { candidates, winner: null, sale: purchase * 1.15, steps: [
        { step: t('tariff.stepNoRule'), detail: t('tariff.defaultMarkup'), value: '15.0000' },
      ] };
    }

    const pricing = winner.rule.pricing;
    let sale = purchase;
    const steps: Array<{ step: string; detail: string; value: string }> = [];

    steps.push({
      step: t('tariff.stepSelected'),
      detail: `${t('tariff.priority')} ${String(winner.priority)}, ${t('contract.validFrom')} ${winner.rule.validFrom.slice(0, 10)}`,
      value: '',
    });

    if ('markupPercent' in pricing) {
      sale = purchase * (1 + Number.parseFloat(pricing.markupPercent) / 100);
      steps.push({ step: t('tariffMode.cost_plus'), detail: `${purchase.toFixed(2)} × (1 + ${pricing.markupPercent}/100)`, value: sale.toFixed(4) });
    } else if ('price' in pricing) {
      sale = Number.parseFloat(pricing.price.amount);
      steps.push({ step: t('tariffMode.fixed'), detail: t('tariff.fixedIgnoresPurchase'), value: sale.toFixed(4) });
    } else {
      sale = purchase;
      steps.push({ step: t('tariffMode.pass_through'), detail: t('tariff.passThroughHint'), value: sale.toFixed(4) });
    }

    const discount = winner.rule.discount;
    if (discount) {
      const before = sale;
      // Скидка применяется ПОСЛЕ наценки (DOMAIN § 7.2), а не вместо неё.
      const discountValue = Number.parseFloat(discount.value ?? '0');
      sale = discount.kind === 'percent' ? sale * (1 - discountValue / 100) : sale - discountValue;
      steps.push({
        step: t('tariff.stepDiscount'),
        detail: `${before.toFixed(2)} − ${discountValue.toFixed(2)}${discount.kind === 'percent' ? ' %' : ''}`,
        value: sale.toFixed(4),
      });
    }

    return { candidates, winner, sale, steps };
  }, [rules, serviceId, airport, purchase, t]);

  if (!client) return <NotFoundPage />;

  const tariffColumns: ColumnsType<TariffRule> = [
    {
      title: t('tariff.scope'), key: 'scope', width: 280,
      render: (_, row) => (
        <Space size={4} wrap>
          {row.scope.serviceId ? (
            <Tag color="blue" style={{ margin: 0 }}>{SERVICE_BY_ID.get(row.scope.serviceId)?.name.ru}</Tag>
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
      title: t('tariff.priority'), key: 'priority', width: 110, align: 'right',
      render: (_, row) => <Mono>{priorityOf(row)}</Mono>,
    },
    {
      title: t('tariff.mode'), key: 'mode', width: 200,
      render: (_, row) => {
        const pricing = row.pricing;
        if ('markupPercent' in pricing) {
          return (
            <Space size={6}>
              <Tag style={{ margin: 0 }}>{t('tariffMode.cost_plus')}</Tag>
              <Mono>+{Number.parseFloat(pricing.markupPercent).toFixed(0)} %</Mono>
            </Space>
          );
        }
        if ('price' in pricing) {
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
            −{Number.parseFloat(row.discount.value ?? '0').toFixed(0)}
            {row.discount.kind === 'percent' ? ' %' : ''}
          </Mono>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: t('catalog.validity'), key: 'validity', width: 200,
      render: (_, row) => (
        <Space size={4}>
          <DateText value={row.validFrom} />
          <span>—</span>
          <DateText value={row.validTo} />
        </Space>
      ),
    },
  ];

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
                      ? `, ${Number.parseFloat(client.paymentTerms.prepaymentPercent).toFixed(0)} %`
                      : ''}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('client.creditLimit')}>
                    <MoneyText value={client.creditLimit ?? null} />
                  </Descriptions.Item>
                  <Descriptions.Item label={t('client.locale')}>
                    <Tag>{client.defaultLocale?.toUpperCase()}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('client.contact')} span={2}>
                    <Space direction="vertical" size={2}>
                      {(client.contacts ?? []).map((contact) => (
                        <Space key={contact.email} size={8} wrap>
                          <span>{contact.name}</span>
                          <Typography.Text type="secondary">{contact.role}</Typography.Text>
                          <Mono>{contact.email}</Mono>
                          {contact.isPrimary ? <Tag color="blue">{t('client.primary')}</Tag> : null}
                        </Space>
                      ))}
                    </Space>
                  </Descriptions.Item>
                </Descriptions>
              </Card>
            ),
          },
          {
            key: 'tariffs',
            label: `${t('client.tabs.tariffs')} (${String(rules.length)})`,
            children: (
              <Row gutter={[12, 12]}>
                <Col xs={24} lg={14}>
                  <Card size="small" styles={{ body: { padding: 0 } }}>
                    <Table<TariffRule>
                      size="small" rowKey="id" columns={tariffColumns} dataSource={rules}
                      pagination={false} scroll={{ x: 850 }}
                      locale={{ emptyText: <EmptyState description={t('tariff.noRules')} /> }}
                    />
                  </Card>
                </Col>

                <Col xs={24} lg={10}>
                  <Card size="small" title={t('tariff.sandbox')}>
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {t('tariff.sandboxHint')}
                      </Typography.Text>

                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                        <Select
                          style={{ width: '100%' }} value={serviceId} onChange={setServiceId}
                          showSearch optionFilterProp="label"
                          options={SERVICES.map((s) => ({ value: s.id, label: s.name.ru }))}
                        />
                        <Select
                          style={{ width: '100%' }} value={airport} onChange={setAirport}
                          showSearch optionFilterProp="label"
                          options={AIRPORTS.map((a) => ({ value: a.icao, label: `${a.icao} — ${a.city}` }))}
                        />
                        <InputNumber
                          style={{ width: '100%' }} value={purchase}
                          onChange={(value) => { setPurchase(value ?? 0); }}
                          addonBefore={t('service.purchaseCost')}
                        />
                      </Space>

                      <Divider style={{ margin: '4px 0' }} />

                      <Space direction="vertical" size={4} style={{ width: '100%' }}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {t('tariff.explanation')}
                        </Typography.Text>
                        {simulation.steps.map((step, index) => (
                          <Space key={index} size={6} wrap>
                            <Tag style={{ margin: 0 }}>{index + 1}</Tag>
                            <Typography.Text style={{ fontSize: 12 }}>{step.step}</Typography.Text>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {step.detail}
                            </Typography.Text>
                            {step.value ? <Mono>{Number.parseFloat(step.value).toFixed(2)}</Mono> : null}
                          </Space>
                        ))}
                      </Space>

                      <Alert
                        type="success"
                        message={
                          <Space size={8}>
                            <span>{t('service.salePrice')}:</span>
                            <MoneyText
                              value={{ amount: simulation.sale.toFixed(4), currency: client.settlementCurrency }}
                              strong
                            />
                          </Space>
                        }
                      />

                      {simulation.candidates.length > 1 ? (
                        <Space direction="vertical" size={2} style={{ width: '100%' }}>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {t('tariff.otherCandidates')}
                          </Typography.Text>
                          {simulation.candidates.slice(1).map(({ rule, priority }) => (
                            <Typography.Text key={rule.id} type="secondary" style={{ fontSize: 12 }}>
                              <Mono>{rule.id}</Mono> — {t('tariff.priority')} {priority},{' '}
                              {t('tariff.notSelected')}
                            </Typography.Text>
                          ))}
                        </Space>
                      ) : null}
                    </Space>
                  </Card>
                </Col>
              </Row>
            ),
          },
        ]}
      />
    </Space>
  );
}

export { SERVICE_CATEGORIES, Button };
