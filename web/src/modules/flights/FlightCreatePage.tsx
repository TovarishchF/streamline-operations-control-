import { useMemo, useState, type JSX } from 'react';
import {
  Alert, Button, Card, Col, DatePicker, Descriptions, Form, Input, InputNumber, Row, Select, Space,
  Typography,
} from 'antd';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { CLIENTS } from '@/mocks/counterparties';
import { AIRCRAFT, AIRCRAFT_TYPE_BY_ID, AIRPORTS, AIRPORT_BY_ICAO } from '@/mocks/reference';
import { Mono } from '@/shared/ui/primitives';

const FLIGHT_TYPES = ['charter', 'ferry', 'ambulance', 'cargo', 'technical'] as const;

/** Ортодромия по гаверсинусу — та же формула, что на сервере (`DOMAIN.md § 7.8`). */
function haversineNm(a: [number, number], b: [number, number]): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return (6371 * 2 * Math.asin(Math.sqrt(h))) / 1.852;
}

/**
 * Создание рейса `[ТЗ 3.1.1]`.
 *
 * Расстояние, блок-тайм, плановое топливо и время прилёта считает **сервер**
 * (`CLAUDE.md § 3` п. 16). Показанная здесь оценка — предварительный расчёт
 * для формы, чтобы диспетчер видел порядок величин до отправки; окончательные
 * значения приходят в ответе.
 *
 * Ветер, эшелоны и запасные аэродромы не учитываются: расчёт плановый
 * и оценочный, и это написано рядом.
 */
export function FlightCreatePage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [dep, setDep] = useState<string>('UUWW');
  const [arr, setArr] = useState<string>('ULLI');
  const [aircraftId, setAircraftId] = useState<string | undefined>();

  const estimate = useMemo(() => {
    const from = AIRPORT_BY_ICAO.get(dep);
    const to = AIRPORT_BY_ICAO.get(arr);
    if (!from || !to) return null;

    const aircraft = aircraftId ? AIRCRAFT.find((a) => a.id === aircraftId) : undefined;
    const type = aircraft ? AIRCRAFT_TYPE_BY_ID.get(aircraft.typeId) : undefined;
    const speed = type?.cruiseSpeedKts ?? 450;
    const burn = type?.fuelBurnKgPerHour ?? 1000;

    const distanceNm = Math.round(haversineNm([from.lat, from.lon], [to.lat, to.lon]));
    const blockTimeMin = Math.round((distanceNm / speed) * 60 + 20);
    const fuelPlanKg = Math.round((blockTimeMin / 60) * burn * 1.1);

    return { distanceNm, blockTimeMin, fuelPlanKg };
  }, [dep, arr, aircraftId]);

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('schedule.newFlight')}</Typography.Title>

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={14}>
          <Card size="small">
            <Form
              layout="vertical"
              onFinish={() => {
                navigate('/schedule');
              }}
            >
              <Row gutter={12}>
                <Col xs={24} md={12}>
                  <Form.Item label={t('flight.client')} name="clientId" rules={[{ required: true, message: t('common.required') }]}>
                    <Select
                      showSearch optionFilterProp="label"
                      options={CLIENTS.filter((c) => c.isActive).map((c) => ({ value: c.id, label: c.name }))}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label={t('flight.type')} name="type" initialValue="charter">
                    <Select
                      options={FLIGHT_TYPES.map((code) => ({ value: code, label: t(`flightType.${code}`) }))}
                    />
                  </Form.Item>
                </Col>

                <Col xs={24} md={12}>
                  <Form.Item label={t('flight.departure')} required>
                    <Select
                      showSearch optionFilterProp="label" value={dep} onChange={setDep}
                      options={AIRPORTS.map((a) => ({ value: a.icao, label: `${a.icao} — ${a.city}` }))}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label={t('flight.arrival')} required>
                    <Select
                      showSearch optionFilterProp="label" value={arr} onChange={setArr}
                      options={AIRPORTS.map((a) => ({ value: a.icao, label: `${a.icao} — ${a.city}` }))}
                    />
                  </Form.Item>
                </Col>

                <Col xs={24} md={12}>
                  <Form.Item
                    label={t('flight.std')} name="std"
                    rules={[{ required: true, message: t('common.required') }]}
                    extra={t('flight.stdHint')}
                  >
                    <DatePicker showTime style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label={t('flight.aircraft')} extra={t('flight.aircraftOptionalHint')}>
                    <Select
                      allowClear showSearch optionFilterProp="label"
                      value={aircraftId} onChange={setAircraftId}
                      options={AIRCRAFT.map((a) => ({
                        value: a.id,
                        label: `${a.registration} — ${AIRCRAFT_TYPE_BY_ID.get(a.typeId)?.icaoType ?? ''}${a.status !== 'serviceable' ? ` (${t(`aircraftStatus.${a.status}`)})` : ''}`,
                      }))}
                    />
                  </Form.Item>
                </Col>

                <Col xs={24} md={12}>
                  <Form.Item label={t('flight.pax')} name="pax" initialValue={4}>
                    <InputNumber min={0} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>

              <Form.Item label={t('flight.remarks')} name="remarks">
                <Input.TextArea rows={2} />
              </Form.Item>

              <Space>
                <Button type="primary" htmlType="submit">{t('common.save')}</Button>
                <Button onClick={() => { navigate('/schedule'); }}>{t('common.cancel')}</Button>
              </Space>
            </Form>
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Card size="small" title={t('flight.estimate')}>
              {estimate ? (
                <Descriptions size="small" column={1} bordered>
                  <Descriptions.Item label={t('flight.distance')}>
                    <Mono>{estimate.distanceNm} NM</Mono>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('flight.blockTime')}>
                    <Mono>
                      {Math.floor(estimate.blockTimeMin / 60)} ч {estimate.blockTimeMin % 60} м
                    </Mono>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('flight.fuelPlan')}>
                    <Mono>{estimate.fuelPlanKg} кг</Mono>
                  </Descriptions.Item>
                </Descriptions>
              ) : null}
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                {t('flight.estimateHint')}
              </Typography.Text>
            </Card>

            <Alert type="info" showIcon message={t('flight.conflictCheckNotice')} />
          </Space>
        </Col>
      </Row>
    </Space>
  );
}
