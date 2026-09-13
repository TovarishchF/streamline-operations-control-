import { useMemo, useState, type JSX } from 'react';
import { Alert, Modal, Radio, Slider, Space, Tag, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useTranslation } from 'react-i18next';

import type { Flight, ServiceOrder, VendorCandidate } from '@/api/types';
import { CONTRACT_BY_VENDOR, VENDOR_BY_ID, VENDOR_PRICES } from '@/mocks/counterparties';
import { MoneyText, Mono } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

type Preset = 'price' | 'rating' | 'proximity' | 'balanced';

const PRESETS: Record<Preset, [number, number, number]> = {
  price: [1, 0, 0],
  rating: [0, 1, 0],
  proximity: [0, 0, 1],
  balanced: [0.5, 0.3, 0.2],
};

/**
 * Подбор поставщика `[ТЗ 3.3.2]`.
 *
 * Перед применением показывается таблица сравнения кандидатов с разложением
 * балла на составляющие и влиянием на маржу рейса: **решение должно быть
 * объяснимым** (`SPEC.md § 6.2`). Цифра без разложения выглядит выдуманной,
 * и диспетчер ей не поверит.
 *
 * Формула — `DOMAIN.md § 7.5`. На сервере это `POST /vendors/suggest`;
 * здесь показан вид ответа.
 */
export function VendorSuggestModal({
  order,
  flight,
  onClose,
}: {
  order: ServiceOrder | null;
  flight: Flight;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [preset, setPreset] = useState<Preset>('balanced');
  const [weights, setWeights] = useState<[number, number, number]>(PRESETS.balanced);

  const candidates: VendorCandidate[] = useMemo(() => {
    if (!order) return [];

    const prices = VENDOR_PRICES.filter(
      (p) => p.serviceId === order.serviceId && p.airportIcao === order.airportIcao,
    );
    if (prices.length === 0) return [];

    const costs = prices.map((p) => Number.parseFloat(p.price.amount));
    const minCost = Math.min(...costs);
    const maxCost = Math.max(...costs);
    const currentCost = Number.parseFloat(order.purchaseCost?.amount ?? '0');
    const quantity = Number.parseFloat(order.quantity);

    const [wPrice, wRating, wProximity] = weights;

    return prices
      .map((price) => {
        const vendor = VENDOR_BY_ID.get(price.vendorId);
        const cost = Number.parseFloat(price.price.amount);
        const priceScore = maxCost === minCost ? 1 : 1 - (cost - minCost) / (maxCost - minCost);
        const ratingScore = vendor?.rating?.sufficientData
          ? Number.parseFloat(vendor.rating.rating ?? '0') / 5
          : 0.5;
        const hasBase = vendor?.coverage?.airports?.includes(order.airportIcao) ?? false;
        const proximityScore = hasBase ? 1 : 0.4;

        const total = wPrice * priceScore + wRating * ratingScore + wProximity * proximityScore;
        const marginImpact = (currentCost - cost * quantity).toFixed(4);

        return {
          vendorId: price.vendorId,
          vendorName: vendor?.name ?? price.vendorId,
          cost: { amount: (cost * quantity).toFixed(4), currency: price.price.currency },
          priceScore: priceScore.toFixed(4),
          ratingScore: ratingScore.toFixed(4),
          proximityScore: proximityScore.toFixed(4),
          totalScore: total.toFixed(4),
          distanceKm: hasBase ? 0 : 45,
          hasBaseAtAirport: hasBase,
          marginImpact: { amount: marginImpact, currency: price.price.currency },
        } satisfies VendorCandidate;
      })
      .sort((a, b) => Number.parseFloat(b.totalScore) - Number.parseFloat(a.totalScore));
  }, [order, weights]);

  const columns: DataColumns<VendorCandidate> = [
    {
      title: t('vendor.name'),
      dataIndex: 'vendorName',
      render: (value: string, row) => {
        const contract = CONTRACT_BY_VENDOR.get(row.vendorId);
        const current = order?.vendorId === row.vendorId;
        return (
          <Space direction="vertical" size={0}>
            <Space size={6}>
              <span>{value}</span>
              {current ? <Tag color="blue">{t('vendor.current')}</Tag> : null}
              {contract?.status === 'expired' ? <Tag color="red">{t('contract.expired')}</Tag> : null}
              {contract?.status === 'expiring' ? <Tag color="orange">{t('contract.expiring')}</Tag> : null}
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.hasBaseAtAirport ? t('vendor.hasBase') : t('vendor.distanceKm', { km: row.distanceKm })}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: t('vendor.cost'),
      key: 'cost',
      width: 140,
      align: 'right',
      render: (_, row) => <MoneyText value={row.cost} />,
    },
    {
      title: t('vendor.priceScore'),
      dataIndex: 'priceScore',
      width: 96,
      align: 'right',
      render: (value: string) => <Mono>{Number.parseFloat(value).toFixed(2)}</Mono>,
    },
    {
      title: t('vendor.ratingScore'),
      dataIndex: 'ratingScore',
      width: 96,
      align: 'right',
      render: (value: string) => <Mono>{Number.parseFloat(value).toFixed(2)}</Mono>,
    },
    {
      title: t('vendor.proximityScore'),
      dataIndex: 'proximityScore',
      width: 106,
      align: 'right',
      render: (value: string) => <Mono>{Number.parseFloat(value).toFixed(2)}</Mono>,
    },
    {
      title: t('vendor.totalScore'),
      dataIndex: 'totalScore',
      width: 100,
      align: 'right',
      render: (value: string) => <Mono>{Number.parseFloat(value).toFixed(3)}</Mono>,
    },
    {
      title: t('vendor.marginImpact'),
      key: 'impact',
      width: 150,
      align: 'right',
      render: (_, row) => <MoneyText value={row.marginImpact} colorBySign />,
    },
  ];

  return (
    <Modal
      open={order !== null}
      width={980}
      title={t('vendor.suggestTitle', { service: order?.service?.name.ru ?? '' })}
      okText={t('vendor.applySelected')}
      cancelText={t('common.cancel')}
      onCancel={onClose}
      onOk={onClose}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space size={12} wrap align="center">
          <Radio.Group
            size="small"
            optionType="button"
            value={preset}
            onChange={(e) => {
              const next = e.target.value as Preset;
              setPreset(next);
              setWeights(PRESETS[next]);
            }}
            options={[
              { label: t('vendor.presetPrice'), value: 'price' },
              { label: t('vendor.presetRating'), value: 'rating' },
              { label: t('vendor.presetProximity'), value: 'proximity' },
              { label: t('vendor.presetBalanced'), value: 'balanced' },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('vendor.weights')}: {weights.map((w) => w.toFixed(1)).join(' / ')}
          </Typography.Text>
        </Space>

        <Space size={16} wrap style={{ width: '100%' }}>
          {(['price', 'rating', 'proximity'] as const).map((key, index) => (
            <Space key={key} direction="vertical" size={0} style={{ width: 190 }}>
              <Typography.Text style={{ fontSize: 12 }}>{t(`vendor.weight_${key}`)}</Typography.Text>
              <Slider
                min={0}
                max={1}
                step={0.1}
                value={weights[index]}
                onChange={(value: number) => {
                  const next: [number, number, number] = [...weights];
                  next[index] = value;
                  setWeights(next);
                }}
              />
            </Space>
          ))}
        </Space>

        {candidates.length === 0 ? (
          <Alert type="error" showIcon message={t('vendor.noCandidates')} />
        ) : (
          <DataTable<VendorCandidate>
            size="small"
            rowKey="vendorId"
            columns={columns}
            dataSource={candidates}
            pagination={false}
            scroll={{ x: 900 }}
            rowSelection={{ type: 'radio', defaultSelectedRowKeys: [candidates[0]?.vendorId ?? ''] }}
            rowClassName={(row) =>
              row.vendorId === order?.vendorId ? 'soc-row-current' : ''
            }
          />
        )}

        <Alert
          type="info"
          showIcon
          message={t('vendor.snapshotNotice')}
          description={t('vendor.snapshotHint', { currency: flight.billingCurrency })}
        />
      </Space>
    </Modal>
  );
}

export { STATUS_TOKENS };
