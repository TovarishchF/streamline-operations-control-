import type { JSX } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { SOC_COLORS, SOC_DENSITY, SOC_RADIUS } from '@/app/theme';
import { usePermissionMap } from '@/shared/auth/session';
import { NAV_GROUPS } from './navigation';
import { activePath } from './NavRail';

/**
 * Вкладки внутри раздела.
 *
 * Рельс несёт девять пунктов — столько, сколько задано дизайн-системой.
 * Экраны раздела, не попавшие в рельс, живут здесь: длинный список разделов
 * диспетчер перечитывает каждый раз, а вкладки внутри раздела — один раз.
 *
 * Вкладка показывается по праву на её экран. Это видимость, а не доступ:
 * права проверяются на сервере в каждом эндпоинте.
 */
export function SectionTabs(): JSX.Element | null {
  const { t } = useTranslation();
  const location = useLocation();
  const permissions = usePermissionMap();

  const current = activePath(location.pathname);
  if (current === null) return null;

  const section = NAV_GROUPS.flatMap((group) => group.items).find(
    (item) => item.path === current || (item.children ?? []).some((c) => c.path === current),
  );
  const tabs = (section?.children ?? []).filter(
    (child) => permissions[child.permission] === true,
  );

  // Раздел из одного экрана вкладок не заводит: одна вкладка ничего
  // не переключает и только отнимает строку.
  if (tabs.length < 2) return null;

  return (
    <nav
      aria-label={t(section?.labelKey ?? 'nav.menu')}
      style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}
    >
      {tabs.map((tab) => {
        const isActive = tab.path === current;
        return (
          <Link
            key={tab.key}
            to={tab.path}
            aria-current={isActive ? 'page' : undefined}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              height: SOC_DENSITY.controlHeightSm,
              paddingInline: 12,
              borderRadius: SOC_RADIUS.control,
              background: isActive ? SOC_COLORS.brand100 : SOC_COLORS.surface,
              border: `1px solid ${isActive ? SOC_COLORS.brand200 : SOC_COLORS.border}`,
              color: isActive ? SOC_COLORS.brand : SOC_COLORS.inkSecondary,
              fontWeight: isActive ? 500 : 400,
              textDecoration: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            {t(tab.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}
