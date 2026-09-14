import { useMemo, useState, type JSX } from 'react';
import {
  Alert, App, Button, Card, Col, Descriptions, Form, Input, InputNumber, Row, Select, Space,
  Typography,
} from 'antd';
import type { Dayjs } from 'dayjs';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useAirports } from '@/api/catalog';
import { ApiError } from '@/api/client';
import { useFleet } from '@/api/fleet';
import { useCreateFlight } from '@/api/flights';
import { useClients } from '@/api/counterparties';
import { useClock } from '@/shared/clock/useClock';
import { DateTimePicker } from '@/shared/ui/DateTimePicker';
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

interface FormValues {
  clientId: string;
  type: (typeof FLIGHT_TYPES)[number];
  dep: string;
  arr: string;
  std: Dayjs;
  aircraftId?: string;
  pax: number;
  remarks?: string;
}

/**
 * Создание рейса `[ТЗ 3.1.1]`.
 *
 * Форма действительно создаёт рейс: он появляется в суточном плане и в таблице,
 * открывается его карточка. На M10 вызов хранилища заменяется на
 * `POST /flights`, форма и проверки остаются теми же.
 *
 * Расстояние, блок-тайм и плановое топливо считает сервер
 * (`CLAUDE.md § 3` п. 16). Показанная оценка — предварительная, для формы.
 * Ветер, эшелоны и запасные аэродромы не учитываются, и это написано рядом.
 */
export function FlightCreatePage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const { nowUtc } = useClock();

  // Справочники и парк — с сервера: создать рейс в аэропорт, которого нет
  // в справочнике, сервер не даст, и предлагать такой выбор нельзя.
  const airportsQuery = useAirports({ perPage: 200 });
  const fleetQuery = useFleet();
  const airports = useMemo(() => airportsQuery.data?.data ?? [], [airportsQuery.data]);
  const fleet = useMemo(() => fleetQuery.data?.data ?? [], [fleetQuery.data]);
  const clients = useClients().data?.data ?? [];
  const createFlight = useCreateFlight();

  const [form] = Form.useForm<FormValues>();
  const [dep, setDep] = useState<string>('UUWW');
  const [arr, setArr] = useState<string>('ULLI');
  const [aircraftId, setAircraftId] = useState<string | undefined>();

  /**
   * Предварительная оценка для формы.
   *
   * Окончательный расчёт делает сервер (`DOMAIN § 7.8`) — здесь он повторён,
   * чтобы диспетчер видел расстояние и время в пути до отправки формы.
   * Значения после создания берутся из ответа сервера, а не отсюда.
   */
  const estimate = useMemo(() => {
    const from = airports.find((item) => item.icao === dep);
    const to = airports.find((item) => item.icao === arr);
    if (!from || !to) return null;

    const aircraft = aircraftId ? fleet.find((item) => item.id === aircraftId) : undefined;
    const speed = aircraft?.type?.cruiseSpeedKts ?? 450;
    const burn = aircraft?.type?.fuelBurnKgPerHour ?? 1000;

    const distanceNm = Math.round(haversineNm([from.lat, from.lon], [to.lat, to.lon]));
    const blockTimeMin = Math.round((distanceNm / speed) * 60 + 20);

    return { distanceNm, blockTimeMin, fuelPlanKg: Math.round((blockTimeMin / 60) * burn * 1.1) };
  }, [airports, fleet, dep, arr, aircraftId]);

  const sameAirport = dep === arr;

  const handleFinish = (values: FormValues): void => {
    createFlight.mutate(
      {
        clientId: values.clientId,
        aircraftId: values.aircraftId ?? null,
        type: values.type,
        depIcao: dep,
        arrIcao: arr,
        stdUtc: values.std.toISOString(),
        paxCount: values.pax,
        remarks: values.remarks,
      },
      {
        onSuccess: (flight) => {
          void message.success(t('flight.created', { number: flight.number }));
          navigate(`/flights/${flight.id}`);
        },
        onError: (cause: unknown) => {
          void message.error(
            cause instanceof ApiError ? cause.message : t('auth.serverUnavailable'),
          );
        },
      },
    );
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('schedule.newFlight')}
      </Typography.Title>

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={14}>
          <Card size="small">
            <Form<FormValues>
              form={form}
              layout="vertical"
              onFinish={handleFinish}
              initialValues={{ type: 'charter', pax: 4 }}
            >
              <Row gutter={12}>
                <Col xs={24} md={12}>
                  <Form.Item
                    label={t('flight.client')}
                    name="clientId"
                    rules={[{ required: true, message: t('common.required') }]}
                  >
                    <Select
                      showSearch
                      optionFilterProp="label"
                      options={clients.map((c) => ({
                        value: c.id,
                        label: `${c.name} (${c.settlementCurrency})`,
                      }))}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label={t('flight.type')} name="type">
                    <Select
                      options={FLIGHT_TYPES.map((code) => ({
                        value: code,
                        label: t(`flightType.${code}`),
                      }))}
                    />
                  </Form.Item>
                </Col>

                <Col xs={24} md={12}>
                  <Form.Item label={t('flight.departure')} required>
                    <Select
                      showSearch
                      optionFilterProp="label"
                      value={dep}
                      onChange={setDep}
                      options={airports.map((a) => ({
                        value: a.icao,
                        label: `${a.icao} — ${a.city}`,
                      }))}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    label={t('flight.arrival')}
                    required
                    validateStatus={sameAirport ? 'error' : undefined}
                    help={sameAirport ? t('flight.sameAirport') : undefined}
                  >
                    <Select
                      showSearch
                      optionFilterProp="label"
                      value={arr}
                      onChange={setArr}
                      options={airports.map((a) => ({
                        value: a.icao,
                        label: `${a.icao} — ${a.city}`,
                      }))}
                    />
                  </Form.Item>
                </Col>

                <Col xs={24} md={12}>
                  <Form.Item
                    label={t('flight.std')}
                    name="std"
                    rules={[{ required: true, message: t('common.required') }]}
                    extra={t('flight.stdHint')}
                  >
                    <DateTimePicker style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    label={t('flight.aircraft')}
                    name="aircraftId"
                    extra={t('flight.aircraftOptionalHint')}
                  >
                    <Select
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      onChange={(value: string | undefined) => {
                        setAircraftId(value);
                      }}
                      options={fleet.map((a) => ({
                        value: a.id,
                        label: `${a.registration} — ${a.type?.icaoType ?? ''}${
                          a.status === 'serviceable' ? '' : ` (${t(`aircraftStatus.${a.status}`)})`
                        }`,
                      }))}
                    />
                  </Form.Item>
                </Col>

                <Col xs={24} md={12}>
                  <Form.Item label={t('flight.pax')} name="pax">
                    <InputNumber min={0} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>

              <Form.Item label={t('flight.remarks')} name="remarks">
                <Input.TextArea rows={2} />
              </Form.Item>

              <Space>
                <Button type="primary" htmlType="submit" disabled={sameAirport}>
                  {t('flight.create')}
                </Button>
                <Button
                  onClick={() => {
                    navigate('/schedule');
                  }}
                >
                  {t('common.cancel')}
                </Button>
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
              <Typography.Text
                type="secondary"
                style={{ fontSize: 12, display: 'block', marginTop: 8 }}
              >
                {t('flight.estimateHint')}
              </Typography.Text>
            </Card>

            <Alert type="info" showIcon message={t('flight.conflictCheckNotice')} />

            <Card size="small" styles={{ body: { padding: 10 } }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('flight.nowHint', { time: `${String(nowUtc.getUTCHours()).padStart(2, '0')}:${String(nowUtc.getUTCMinutes()).padStart(2, '0')}Z` })}
              </Typography.Text>
            </Card>
          </Space>
        </Col>
      </Row>
    </Space>
  );
}
