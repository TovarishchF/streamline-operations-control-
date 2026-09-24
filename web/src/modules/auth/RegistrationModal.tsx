import { useState, type JSX } from 'react';
import {
  Alert, Button, Form, Input, Modal, Result, Select, Space, Typography,
} from 'antd';
import { useTranslation } from 'react-i18next';

import { useRegister, type RegistrationInput } from '@/api/auth';
import { ApiError } from '@/api/client';
import { SOC_COLORS, SOC_RADIUS } from '@/app/theme';
import { CountrySelect } from '@/shared/ui/CountrySelect';

/**
 * Регистрация заказчика или поставщика `[ТЗ 4.3]` (ADR-037).
 *
 * Два разных сценария под одним словом. **Заказчик** регистрируется сам:
 * после подтверждения адреса доступ открывается без участия человека —
 * чужих данных он не видит, а своих у новой карточки нет. **Поставщик**
 * заполняет данные организации, и заявка уходит руководителю: взять
 * поставщика в работу — решение о закупке, а не о доступе.
 *
 * После подачи экран говорит «проверьте почту», а не «учётная запись
 * создана»: ответ сервера одинаков для свободного и занятого адреса,
 * иначе форма регистрации превращается в справочник клиентуры.
 */

/** Правила, которым обязан удовлетворять пароль. Повторяют серверную политику. */
const SPECIAL = '!@#$%^&*()-_=+[]{}:;,.?~';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';

/** Проверка множеством, а не регулярным выражением: знаки препинания
 *  внутри класса символов требуют экранирования, и правило, которое
 *  легко сломать опечаткой, здесь не нужно. */
const ALLOWED = new Set([...LETTERS.split(''), ...DIGITS.split(''), ...SPECIAL.split('')]);

interface Rule {
  key: string;
  ok: (value: string) => boolean;
}

const RULES: Rule[] = [
  { key: 'length', ok: (v) => v.length >= 12 },
  { key: 'letter', ok: (v) => /[A-Za-z]/.test(v) },
  { key: 'digit', ok: (v) => /[0-9]/.test(v) },
  { key: 'special', ok: (v) => v.split('').some((c) => SPECIAL.includes(c)) },
  { key: 'allowed', ok: (v) => v.split('').every((c) => ALLOWED.has(c)) },
];

function passwordProblems(value: string, t: (key: string) => string): string[] {
  if (!value) return [];
  return RULES.filter((rule) => !rule.ok(value)).map((rule) =>
    t(`register.passwordRule.${rule.key}`),
  );
}

/**
 * Список требований с отметкой выполненных.
 *
 * Показывать их все сразу, а не по одному при отказе: подбирать пароль
 * методом проб, получая по одной претензии за попытку, — худший способ
 * узнать правило.
 */
function PasswordRules({ value = '' }: { value?: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <Space direction="vertical" size={2} style={{ marginTop: 4 }}>
      {RULES.map((rule) => {
        const done = value.length > 0 && rule.ok(value);
        return (
          <Space key={rule.key} size={6}>
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                borderRadius: 999,
                background: done ? SOC_COLORS.brand : SOC_COLORS.borderStrong,
              }}
            />
            <Typography.Text
              style={{
                fontSize: 12,
                color: done ? SOC_COLORS.ink : SOC_COLORS.inkSecondary,
              }}
            >
              {t(`register.passwordRule.${rule.key}`)}
            </Typography.Text>
          </Space>
        );
      })}
    </Space>
  );
}

type Kind = 'client' | 'vendor';

const CATEGORIES = [
  'fuel', 'handling', 'catering', 'transport', 'permits', 'deicing',
] as const;

interface FormValues {
  contactName: string;
  passwordRepeat: string;
  email: string;
  phone?: string;
  password: string;
  companyName: string;
  legalName?: string;
  country?: string;
  taxId?: string;
  website?: string;
  specializations?: string[];
  coverageAirports?: string[];
  comment?: string;
}

function KindCard({
  kind,
  active,
  title,
  hint,
  onPick,
}: {
  kind: Kind;
  active: boolean;
  title: string;
  hint: string;
  onPick: (kind: Kind) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => {
        onPick(kind);
      }}
      aria-pressed={active}
      style={{
        flex: 1,
        minWidth: 0,
        textAlign: 'left',
        padding: '10px 12px',
        borderRadius: SOC_RADIUS.panel,
        border: `1px solid ${active ? SOC_COLORS.brand200 : SOC_COLORS.border}`,
        background: active ? SOC_COLORS.brand100 : SOC_COLORS.surface,
        color: active ? SOC_COLORS.brand : SOC_COLORS.ink,
        font: 'inherit',
        cursor: 'pointer',
      }}
    >
      <div style={{ fontWeight: 500 }}>{title}</div>
      <div style={{ fontSize: 12, color: SOC_COLORS.inkSecondary, marginTop: 2 }}>{hint}</div>
    </button>
  );
}

export function RegistrationModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [form] = Form.useForm<FormValues>();
  const [kind, setKind] = useState<Kind>('client');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const register = useRegister();
  // Наблюдение за полем — хук, и вызывать его внутри ветки разметки
  // нельзя: порядок хуков обязан совпадать от отрисовки к отрисовке.
  const typedPassword = Form.useWatch<string>('password', form);

  const close = (): void => {
    setSent(false);
    setError(null);
    form.resetFields();
    onClose();
  };

  const submit = (values: FormValues): void => {
    setError(null);
    const input: RegistrationInput = {
      kind,
      contactName: values.contactName,
      email: values.email,
      password: values.password,
      companyName: values.companyName,
      ...(values.phone ? { phone: values.phone } : {}),
      ...(values.legalName ? { legalName: values.legalName } : {}),
      ...(values.country ? { country: values.country.toUpperCase() } : {}),
      ...(values.taxId ? { taxId: values.taxId } : {}),
      ...(values.website ? { website: values.website } : {}),
      ...(kind === 'vendor'
        ? {
            specializations: values.specializations ?? [],
            coverageAirports: values.coverageAirports ?? [],
            comment: values.comment ?? '',
          }
        : {}),
    };

    register.mutate(input, {
      onSuccess: () => {
        setSent(true);
      },
      onError: (cause) => {
        setError(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
      },
    });
  };

  return (
    <Modal
      open={open}
      onCancel={close}
      title={t('register.title')}
      footer={null}
      width={sent ? 460 : 560}
      destroyOnClose
    >
      {sent ? (
        <Result
          status="success"
          title={t('register.sentTitle')}
          subTitle={
            kind === 'client' ? t('register.sentClient') : t('register.sentVendor')
          }
          extra={
            <Button type="primary" onClick={close}>
              {t('common.close')}
            </Button>
          }
        />
      ) : (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Space size={8} style={{ width: '100%' }}>
            <KindCard
              kind="client"
              active={kind === 'client'}
              title={t('register.iAmClient')}
              hint={t('register.iAmClientHint')}
              onPick={setKind}
            />
            <KindCard
              kind="vendor"
              active={kind === 'vendor'}
              title={t('register.iAmVendor')}
              hint={t('register.iAmVendorHint')}
              onPick={setKind}
            />
          </Space>

          {kind === 'vendor' ? (
            <Alert type="info" showIcon message={t('register.vendorNotice')} />
          ) : null}

          {error ? <Alert type="error" showIcon message={error} /> : null}

          {/* Имя формы попадает в `id` полей: без него идентификаторы
              совпадают с формой входа под окном, и подпись указывает
              на чужое поле — в том числе для программы чтения с экрана. */}
          <Form
            form={form}
            name="register"
            layout="vertical"
            onFinish={submit}
            requiredMark={false}
          >
            <Form.Item
              label={t('register.companyName')}
              name="companyName"
              rules={[{ required: true, message: t('register.companyRequired') }]}
            >
              <Input placeholder={t('register.companyPlaceholder')} />
            </Form.Item>

            <Space size={8} style={{ width: '100%' }} align="start">
              <Form.Item label={t('register.legalName')} name="legalName" style={{ flex: 1 }}>
                <Input placeholder={t('register.legalPlaceholder')} />
              </Form.Item>
              <Form.Item label={t('register.country')} name="country">
                <CountrySelect
                  placeholder={t('register.countryPlaceholder')}
                  style={{ width: 240 }}
                />
              </Form.Item>
            </Space>

            {kind === 'vendor' ? (
              <>
                <Form.Item
                  label={t('register.specializations')}
                  name="specializations"
                  rules={[{ required: true, message: t('register.specializationsRequired') }]}
                  // Поставщик без категорий непонятно чем занимается,
                  // и решение о нём принять нельзя.
                  extra={t('register.specializationsHint')}
                >
                  <Select
                    mode="multiple"
                    placeholder={t('register.specializationsPlaceholder')}
                    options={CATEGORIES.map((code) => ({
                      value: code,
                      label: t(`serviceCategory.${code}`),
                    }))}
                  />
                </Form.Item>

                <Form.Item
                  label={t('register.coverageAirports')}
                  name="coverageAirports"
                  extra={t('register.coverageHint')}
                >
                  <Select
                    mode="tags"
                    tokenSeparators={[',', ' ']}
                    placeholder={t('register.coveragePlaceholder')}
                  />
                </Form.Item>

                <Form.Item label={t('register.taxId')} name="taxId">
                  <Input maxLength={32} placeholder={t('register.taxIdPlaceholder')} />
                </Form.Item>
              </>
            ) : null}

            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, display: 'block', marginBottom: 8 }}
            >
              {t('register.contactSection')}
            </Typography.Text>

            <Form.Item
              label={t('register.contactName')}
              name="contactName"
              rules={[{ required: true, message: t('register.contactRequired') }]}
            >
              <Input autoComplete="name" placeholder={t('register.contactPlaceholder')} />
            </Form.Item>

            <Space size={8} style={{ width: '100%' }} align="start">
              <Form.Item
                label={t('register.email')}
                name="email"
                style={{ flex: 1 }}
                rules={[
                  { required: true, message: t('register.emailRequired') },
                  { type: 'email', message: t('register.emailInvalid') },
                ]}
              >
                <Input autoComplete="email" placeholder={t('register.emailPlaceholder')} />
              </Form.Item>
              <Form.Item label={t('register.phone')} name="phone">
                <Input
                  autoComplete="tel"
                  style={{ width: 170 }}
                  placeholder={t('register.phonePlaceholder')}
                />
              </Form.Item>
            </Space>

            {/* Требования повторяют серверную политику
                (`accounts/password_policy.py`). Проверка здесь — чтобы
                не отправлять форму заведомо зря; решает всё равно сервер. */}
            <Form.Item
              label={t('register.password')}
              name="password"
              rules={[
                { required: true, message: t('register.passwordRequired') },
                {
                  validator: (_rule, value: string | undefined) => {
                    const problems = passwordProblems(value ?? '', t);
                    return problems.length > 0
                      ? Promise.reject(new Error(problems[0]))
                      : Promise.resolve();
                  },
                },
              ]}
              extra={<PasswordRules value={typedPassword} />}
            >
              <Input.Password
                autoComplete="new-password"
                placeholder={t('register.passwordPlaceholder')}
              />
            </Form.Item>

            <Form.Item
              label={t('register.passwordRepeat')}
              name="passwordRepeat"
              // Зависимость нужна, чтобы повтор перепроверялся при правке
              // самого пароля, а не только при вводе повтора.
              dependencies={['password']}
              rules={[
                { required: true, message: t('register.passwordRepeatRequired') },
                {
                  validator: (_rule, value: string | undefined) =>
                    value === form.getFieldValue('password')
                      ? Promise.resolve()
                      : Promise.reject(new Error(t('register.passwordMismatch'))),
                },
              ]}
            >
              <Input.Password
                autoComplete="new-password"
                placeholder={t('register.passwordRepeatPlaceholder')}
              />
            </Form.Item>

            {kind === 'vendor' ? (
              <Form.Item label={t('register.comment')} name="comment">
                <Input.TextArea rows={2} placeholder={t('register.commentPlaceholder')} />
              </Form.Item>
            ) : null}

            <Button type="primary" htmlType="submit" block loading={register.isPending}>
              {kind === 'client' ? t('register.submitClient') : t('register.submitVendor')}
            </Button>
          </Form>
        </Space>
      )}
    </Modal>
  );
}
