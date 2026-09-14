import { useMemo, useState, type JSX } from 'react';
import {
  Alert, App, Button, Form, Input, InputNumber, List, Modal, Radio, Select, Space, Steps, Tag, Typography,
} from 'antd';
import { CheckCircleTwoTone, CloseCircleTwoTone, WarningTwoTone } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

import type { Flight } from '@/api/flights';
import type { ServiceCategory, ServiceCheckResult } from '@/api/types';
import { CONTRACT_BY_VENDOR, VENDOR_BY_ID, VENDOR_PRICES } from '@/mocks/counterparties';
import { SERVICES, SERVICE_CATEGORIES } from '@/mocks/reference';
import { useClock } from '@/shared/clock/useClock';
import { useSocStore } from '@/mocks/store';
import { MoneyText, Mono } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

/**
 * Мастер заказа услуги `[ТЗ 3.2.2]`.
 *
 * Шаги: категория → услуга → плечо → атрибуты → поставщик → проверки.
 *
 * Автоматические проверки (`SPEC.md § 5.2`) выполняются **до** отправки
 * и показываются списком. Провал проверок 1–3 (доступность услуги, действующий
 * контракт, актуальная цена) блокирует отправку. Провал 4–5 (лидтайм, погодное
 * условие) требует подтверждения с причиной, и причина идёт в аудит.
 */
export function ServiceOrderWizard({
  flight,
  open,
  onClose,
}: {
  flight: Flight;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const createOrder = useSocStore((state) => state.createOrder);
  const { nowUtc } = useClock();
  const [step, setStep] = useState(0);
  const [category, setCategory] = useState<ServiceCategory | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [leg, setLeg] = useState<'departure' | 'arrival'>('departure');
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState<number>(1);
  const [overrideReason, setOverrideReason] = useState('');

  const service = serviceId ? SERVICES.find((s) => s.id === serviceId) : null;
  const airport = leg === 'departure' ? flight.depIcao : flight.arrIcao;

  const candidates = useMemo(
    () =>
      VENDOR_PRICES.filter((price) => price.serviceId === serviceId && price.airportIcao === airport),
    [serviceId, airport],
  );

  /** Проверки `SPEC.md § 5.2`. Порядок и блокирующий признак — оттуда же. */
  const checks: ServiceCheckResult[] = useMemo(() => {
    if (!service) return [];

    const price = candidates.find((c) => c.vendorId === vendorId) ?? candidates[0];
    const contract = vendorId ? CONTRACT_BY_VENDOR.get(vendorId) : undefined;
    const hoursToDeparture = (new Date(flight.stdUtc).getTime() - nowUtc.getTime()) / 3_600_000;

    return [
      {
        code: 'availability',
        passed: candidates.length > 0,
        blocking: true,
        message: candidates.length > 0
          ? t('service.checkAvailabilityOk', { count: candidates.length, airport })
          : t('service.checkAvailabilityFail', { airport }),
      },
      {
        code: 'contract_valid',
        passed: contract !== undefined && contract.status !== 'expired',
        blocking: true,
        message: contract === undefined
          ? t('service.checkContractMissing')
          : contract.status === 'expired'
            ? t('service.checkContractExpired', {
                vendor: VENDOR_BY_ID.get(vendorId ?? '')?.name ?? '',
                date: new Date(contract.validTo).toLocaleDateString('ru-RU'),
              })
            : t('service.checkContractOk', { number: contract.number }),
      },
      {
        code: 'price_valid',
        passed: price !== undefined,
        blocking: true,
        message: price
          ? t('service.checkPriceOk')
          : t('service.checkPriceFail'),
      },
      {
        code: 'lead_time',
        passed: hoursToDeparture >= service.leadTimeH,
        blocking: false,
        message: hoursToDeparture >= service.leadTimeH
          ? t('service.checkLeadTimeOk', { hours: service.leadTimeH })
          : t('service.checkLeadTimeFail', {
              required: service.leadTimeH,
              actual: Math.max(0, Math.round(hoursToDeparture)),
            }),
      },
      ...(service.requiresWeather
        ? [
            {
              code: 'weather' as const,
              passed: true,
              blocking: false,
              // ADR-029: подсказка диспетчеру, решение принимает командир ВС
              message: t('service.checkWeather'),
            },
          ]
        : []),
    ];
  }, [service, candidates, vendorId, flight.stdUtc, airport, nowUtc, t]);

  const blockingFailed = checks.some((c) => c.blocking && !c.passed);
  const softFailed = checks.some((c) => !c.blocking && !c.passed);
  const canSubmit = !blockingFailed && (!softFailed || overrideReason.trim().length > 0);

  const reset = (): void => {
    setStep(0);
    setCategory(null);
    setServiceId(null);
    setVendorId(null);
    setQuantity(1);
    setOverrideReason('');
  };

  return (
    <Modal
      open={open}
      width={720}
      title={t('service.wizardTitle')}
      onCancel={() => { onClose(); reset(); }}
      footer={
        <Space>
          {step > 0 ? (
            <Button onClick={() => { setStep((s) => s - 1); }}>{t('common.back')}</Button>
          ) : null}
          {step < 2 ? (
            <Button
              type="primary"
              disabled={step === 0 ? !serviceId : false}
              onClick={() => { setStep((s) => s + 1); }}
            >
              {t('common.next')}
            </Button>
          ) : (
            <Button
              type="primary"
              disabled={!canSubmit}
              onClick={() => {
                if (!serviceId || !vendorId) return;
                const order = createOrder({
                  flightId: flight.id,
                  serviceId,
                  leg,
                  quantity: String(quantity),
                  vendorId,
                });
                if (!order) {
                  void message.error(t('service.orderFailed'));
                  return;
                }
                void message.success(t('service.orderCreated'));
                onClose();
                reset();
              }}
            >
              {t('service.submitOrder')}
            </Button>
          )}
        </Space>
      }
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Steps
          size="small"
          current={step}
          items={[
            { title: t('service.stepService') },
            { title: t('service.stepVendor') },
            { title: t('service.stepChecks') },
          ]}
        />

        {step === 0 ? (
          <Form layout="vertical">
            <Form.Item label={t('service.category')} required>
              <Select
                value={category}
                onChange={(value: ServiceCategory) => {
                  setCategory(value);
                  setServiceId(null);
                }}
                options={SERVICE_CATEGORIES.map((code) => ({
                  value: code,
                  label: t(`serviceCategory.${code}`),
                }))}
              />
            </Form.Item>

            <Form.Item label={t('service.name')} required>
              <Select
                value={serviceId}
                disabled={!category}
                onChange={setServiceId}
                options={SERVICES.filter((s) => s.category === category).map((s) => ({
                  value: s.id,
                  label: `${s.name.ru} (${s.code})`,
                }))}
              />
            </Form.Item>

            <Form.Item label={t('service.leg')} required>
              <Radio.Group
                value={leg}
                onChange={(e) => { setLeg(e.target.value as 'departure' | 'arrival'); }}
                optionType="button"
                options={[
                  { label: `${t('serviceLeg.departure')} — ${flight.depIcao}`, value: 'departure' },
                  { label: `${t('serviceLeg.arrival')} — ${flight.arrIcao}`, value: 'arrival' },
                ]}
              />
            </Form.Item>

            {service ? (
              <Form.Item label={`${t('service.quantity')}, ${t(`serviceUnit.${service.unit}`)}`} required>
                <InputNumber
                  min={1}
                  value={quantity}
                  onChange={(value) => { setQuantity(value ?? 1); }}
                  style={{ width: 180 }}
                />
              </Form.Item>
            ) : null}

            {(service?.requiredAttributes?.length ?? 0) > 0 ? (
              <Alert
                type="info"
                message={t('service.requiredAttributes')}
                description={service?.requiredAttributes?.map((attr) => attr.key).join(', ')}
              />
            ) : null}
          </Form>
        ) : null}

        {step === 1 ? (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text type="secondary">
              {t('service.vendorsAt', { airport })}
            </Typography.Text>
            {candidates.length === 0 ? (
              <Alert type="error" showIcon message={t('service.checkAvailabilityFail', { airport })} />
            ) : (
              <List
                bordered
                dataSource={candidates}
                renderItem={(price) => {
                  const vendor = VENDOR_BY_ID.get(price.vendorId);
                  const contract = CONTRACT_BY_VENDOR.get(price.vendorId);
                  const selected = vendorId === price.vendorId;
                  return (
                    <List.Item
                      style={{
                        cursor: 'pointer',
                        background: selected ? STATUS_TOKENS.progress.background : undefined,
                      }}
                      onClick={() => { setVendorId(price.vendorId); }}
                    >
                      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
                        <Space direction="vertical" size={0}>
                          <Space size={6}>
                            <Typography.Text strong>{vendor?.name}</Typography.Text>
                            {vendor?.rating?.sufficientData ? (
                              <Tag>{Number.parseFloat(vendor.rating.rating ?? '0').toFixed(1)} / 5</Tag>
                            ) : (
                              <Tag>{t('vendor.insufficientData')}</Tag>
                            )}
                            {contract?.status === 'expired' ? (
                              <Tag color="red">{t('contract.expired')}</Tag>
                            ) : contract?.status === 'expiring' ? (
                              <Tag color="orange">{t('contract.expiring')}</Tag>
                            ) : null}
                          </Space>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {t('contract.number')}: <Mono>{contract?.number ?? '—'}</Mono>
                          </Typography.Text>
                        </Space>
                        <MoneyText value={price.price} strong />
                      </Space>
                    </List.Item>
                  );
                }}
              />
            )}
          </Space>
        ) : null}

        {step === 2 ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <List
              size="small"
              bordered
              dataSource={checks}
              renderItem={(check) => (
                <List.Item>
                  <Space align="start" size={8}>
                    {check.passed ? (
                      <CheckCircleTwoTone twoToneColor={STATUS_TOKENS.done.color} />
                    ) : check.blocking ? (
                      <CloseCircleTwoTone twoToneColor={STATUS_TOKENS.critical.color} />
                    ) : (
                      <WarningTwoTone twoToneColor={STATUS_TOKENS.warning.color} />
                    )}
                    <Space direction="vertical" size={0}>
                      <Typography.Text strong>{t(`service.check.${check.code}`)}</Typography.Text>
                      <Typography.Text type="secondary">{check.message}</Typography.Text>
                    </Space>
                  </Space>
                </List.Item>
              )}
            />

            {blockingFailed ? (
              <Alert type="error" showIcon message={t('service.blockedByChecks')} />
            ) : null}

            {softFailed ? (
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Alert type="warning" showIcon message={t('service.overrideRequired')} />
                <Input.TextArea
                  rows={2}
                  placeholder={t('service.overridePlaceholder')}
                  value={overrideReason}
                  onChange={(e) => { setOverrideReason(e.target.value); }}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('flight.reasonGoesToAudit')}
                </Typography.Text>
              </Space>
            ) : null}

            {!blockingFailed ? (
              <Alert type="info" showIcon message={t('service.whatHappensNext')} />
            ) : null}
          </Space>
        ) : null}
      </Space>
    </Modal>
  );
}
