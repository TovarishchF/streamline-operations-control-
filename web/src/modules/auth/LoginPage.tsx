import { useState, type JSX } from 'react';
import { Alert, Button, Form, Input, Space, Tag, Typography } from 'antd';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useLoginAccounts, type LoginAccount } from '@/api/auth';
import { RegistrationModal } from './RegistrationModal';
import { ApiError } from '@/api/client';
import { SOC_COLORS, SOC_RADIUS } from '@/app/theme';
import { useSession } from '@/shared/auth/session';
import { formatUtc, useClock, useClockTicker } from '@/shared/clock/useClock';

/**
 * Вход `[ТЗ 4.3]`.
 *
 * **ADR-013:** аутентификация настоящая всегда. Пароль проверяется сервером,
 * после пяти неудачных попыток учётная запись блокируется на пятнадцать минут,
 * второй фактор запрашивается, если приложение-аутентификатор привязано.
 * Переключателя «войти как» не существует ни в какой сборке: обход
 * аутентификации запрещён. Список учётных записей на экране входа — не обход:
 * он подставляет **логин**, пароль по-прежнему набирается, и вход идёт
 * обычным путём через сервер.
 *
 * Сообщение об ошибке приходит с сервера и не уточняет, что именно не подошло:
 * иначе форма входа превращается в справочник логинов.
 *
 * Компоновка — макет `docs/design/mockups/screens/01-login.html`: слева
 * панель знака на `chrome`, справа форма на `canvas`.
 */
export function LoginPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const signIn = useSession((s) => s.signIn);
  const submitTwoFactor = useSession((s) => s.submitTwoFactor);
  // Сервер отдаёт время только вошедшим: до входа часы идут от браузера
  // (`useClock`, synced: false) — это всё равно UTC с подписью зоны.
  useClockTicker();
  const { nowUtc } = useClock();

  const [form] = Form.useForm<{ username: string; password: string }>();
  const accounts = useLoginAccounts().data ?? [];
  // Пришли по «Сменить сотрудника» — список сотрудников стоит над формой:
  // выбирают из него, а не набирают логин заново.
  const switching = useSearchParams()[0].get('switch') === '1';
  const [registering, setRegistering] = useState(false);

  const [step, setStep] = useState<'credentials' | 'twoFactor'>('credentials');
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);

  const handle = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setLocked(false);
    try {
      await action();
    } catch (cause) {
      if (cause instanceof ApiError) {
        setError(cause.message);
        setLocked(cause.code === 'ACCOUNT_LOCKED');
      } else {
        setError(t('auth.serverUnavailable'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="soc soc-login">
      {/* Белый знак — на `chrome`, как в рельсе. Входящий видит, чья это
          система, до ввода логина. */}
      <section className="soc-login__brand">
        <svg
          className="soc-login__arcs"
          viewBox="0 0 700 720"
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
        >
          <path d="M-40 640 Q330 120 760 260" />
          <path d="M-40 700 Q360 200 760 340" />
          <path d="M-40 580 Q300 40 760 180" />
          <path className="is-hot" d="M60 560 Q360 150 640 250" />
          <circle cx="60" cy="560" r="4" />
          <circle cx="640" cy="250" r="4" />
        </svg>
        <img src="/brand/streamline-fs-white.png" alt={t('app.fullName')} />
        <div className="soc-login__claim">
          <h1>{t('auth.claimTitle')}</h1>
          <p>{t('auth.claimText')}</p>
        </div>
        <div className="soc-login__stamp">
          <span>{formatUtc(nowUtc)}</span>
        </div>
      </section>

      <section className="soc-login__form-wrap">
        <div className="soc-login__form">
          <h2>{t('auth.title')}</h2>
          <p className="soc-login__sub">{t('auth.subtitle')}</p>

          {error ? (
            <Alert type={locked ? 'warning' : 'error'} showIcon message={error} />
          ) : null}

          {step === 'credentials' && switching && accounts.length > 0 ? (
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('auth.pickAccount')}
              </Typography.Text>
              <Space size={6} wrap>
                {accounts.map((account) => (
                  <AccountChip
                    key={account.username}
                    account={account}
                    onPick={() => {
                      form.setFieldsValue({ username: account.username, password: '' });
                      form.focusField('password');
                    }}
                  />
                ))}
              </Space>
            </Space>
          ) : null}

          {step === 'credentials' ? (
            <Form
              form={form}
              name="login"
              layout="vertical"
              requiredMark={false}
              onFinish={(values: { username: string; password: string }) => {
                void handle(async () => {
                  const result = await signIn(values.username, values.password);
                  if (result === 'two-factor') {
                    setStep('twoFactor');
                  } else {
                    navigate('/');
                  }
                });
              }}
            >
              <Form.Item
                label={t('auth.username')}
                name="username"
                rules={[{ required: true, message: t('auth.usernameRequired') }]}
              >
                <Input autoComplete="username" size="large" autoFocus />
              </Form.Item>
              <Form.Item
                label={t('auth.password')}
                name="password"
                rules={[{ required: true, message: t('auth.passwordRequired') }]}
              >
                <Input.Password autoComplete="current-password" size="large" />
              </Form.Item>
              <Button type="primary" htmlType="submit" size="large" block loading={busy}>
                {t('auth.signIn')}
              </Button>

              <p className="soc-login__help">
                {t('register.haveNoAccount')}{' '}
                {/* Настоящая кнопка, а не `<a>` без адреса: ссылка без
                    `href` не получает фокус, и клавиатура её пропускает. */}
                <Button
                  type="link"
                  onClick={() => {
                    setRegistering(true);
                  }}
                >
                  {t('register.openForm')}
                </Button>
              </p>

              {accounts.length > 0 && !switching ? (
                <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 16 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('auth.pickAccount')}
                  </Typography.Text>
                  <Space size={6} wrap>
                    {accounts.map((account) => (
                      <AccountChip
                        key={account.username}
                        account={account}
                        onPick={() => {
                          form.setFieldsValue({ username: account.username, password: '' });
                          form.focusField('password');
                        }}
                      />
                    ))}
                  </Space>
                </Space>
              ) : null}
            </Form>
          ) : (
            <Form
              layout="vertical"
              onFinish={(values: { code: string }) => {
                void handle(async () => {
                  await submitTwoFactor(values.code.trim());
                  navigate('/');
                });
              }}
            >
              <Alert type="info" showIcon message={t('auth.twoFactorHint')} />
              <Form.Item
                label={t('auth.twoFactorCode')}
                name="code"
                style={{ marginTop: 12 }}
                rules={[{ required: true, message: t('auth.twoFactorRequired') }]}
              >
                <Input
                  size="large"
                  autoComplete="one-time-code"
                  style={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: 4 }}
                />
              </Form.Item>
              <Space style={{ width: '100%' }} direction="vertical" size={8}>
                <Button type="primary" htmlType="submit" size="large" block loading={busy}>
                  {t('auth.confirm')}
                </Button>
                <Button
                  type="link"
                  block
                  onClick={() => {
                    setStep('credentials');
                    setError(null);
                  }}
                >
                  {t('common.cancel')}
                </Button>
              </Space>
            </Form>
          )}
        </div>
      </section>

      <RegistrationModal
        open={registering}
        onClose={() => {
          setRegistering(false);
        }}
      />
    </div>
  );
}

/**
 * Учётная запись одним нажатием.
 *
 * Подставляет **логин** и переводит фокус на пароль: набор сокращается
 * на одну строку, вход остаётся настоящим (ADR-013).
 */
function AccountChip({
  account,
  onPick,
}: {
  account: LoginAccount;
  onPick: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onPick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 28,
        paddingInline: 10,
        borderRadius: SOC_RADIUS.pill,
        border: `1px solid ${SOC_COLORS.line}`,
        background: SOC_COLORS.surface,
        color: SOC_COLORS.ink2,
        font: 'inherit',
        cursor: 'pointer',
      }}
    >
      {account.name}
      <Tag
        style={{
          margin: 0,
          borderRadius: SOC_RADIUS.pill,
          background: SOC_COLORS.surfaceSunken,
          borderColor: SOC_COLORS.line,
          color: SOC_COLORS.ink3,
          fontSize: 11,
          lineHeight: '16px',
        }}
      >
        {t(`roles.${account.role}`, account.role)}
      </Tag>
    </button>
  );
}
