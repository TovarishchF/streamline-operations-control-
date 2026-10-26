import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { busiestFlightDay, signInAs } from './helpers/session';

/**
 * Сверка экранов с макетами дизайн-системы (`docs/design/mockups/README.md`).
 *
 * Для каждого экрана: снимок настоящего экрана на 1440 px и замер одних
 * и тех же свойств у пар элементов «макет ↔ приложение». Замер — тем же
 * запросом к обеим страницам: макет — настоящая страница, и сравнивать
 * размеры на глаз по картинке не нужно.
 *
 * Шаг задаётся `SOC_DESIGN_STEP` и экраны — `SOC_DESIGN_SCREENS`
 * (через запятую), чтобы прошлые проходы не перезаписывались.
 */
const STEP = process.env['SOC_DESIGN_STEP'] ?? 'pass';
const ONLY = (process.env['SOC_DESIGN_SCREENS'] ?? '').split(',').filter(Boolean);
const OUT = resolve(process.cwd(), `../artifacts/screenshots/design-v3/${STEP}`);
const MOCKUPS = resolve(process.cwd(), '../docs/design/mockups/screens');
const VIEWPORT = { width: 1440, height: 900 };

interface Screen {
  name: string;
  path: string;
  /** Роль входа; `null` — экран без входа (сам вход). */
  role?: string | null;
  /** Элемент, по которому экран считается отрисованным. */
  ready?: string;
  /** Действия на экране перед снимком. */
  prepare?: (page: Page) => Promise<void>;
  /** Пары селекторов: макет → приложение. */
  pairs: Array<[string, string, string]>;
}

const SCREENS: Screen[] = [
  {
    name: '01-login',
    path: '/login',
    role: null,
    ready: '.soc-login__form',
    pairs: [
      ['brand', '.ct-login__brand', '.soc-login__brand'],
      ['logo', '.ct-login__brand > img', '.soc-login__brand > img'],
      ['arcs', '.ct-login__arcs', '.soc-login__arcs'],
      ['claim', '.ct-login__claim', '.soc-login__claim'],
      ['claim title', '.ct-login__claim h1', '.soc-login__claim h1'],
      ['claim text', '.ct-login__claim p', '.soc-login__claim p'],
      ['stamp', '.ct-login__stamp', '.soc-login__stamp'],
      ['form wrap', '.ct-login__form-wrap', '.soc-login__form-wrap'],
      ['form', '.ct-login__form', '.soc-login__form'],
      ['form title', '.ct-login__form h2', '.soc-login__form h2'],
      ['form sub', '.ct-login__form p.sub', '.soc-login__sub'],
      ['label', '.ct-label', '.soc-login__form .ant-form-item-label > label'],
      ['input', '.ct-input--lg', '.soc-login__form input.ant-input-lg'],
      ['password', '.ct-login__form > label:nth-of-type(2) .ct-input', '.soc-login__form .ant-input-affix-wrapper-lg'],
      ['btn primary', '.ct-login__form .ct-btn--primary', '.soc-login__form .ant-btn-primary'],
      ['help', '.ct-login__form .ct-help', '.soc-login__help'],
      ['help link', '.ct-help a', '.soc-login__help .ant-btn-link'],
    ],
  },
  {
    name: '02-dashboard-dispatcher',
    path: '/dashboards/dispatcher',
    pairs: [
      ['rail', '.ct-rail', '.soc-rail'],
      ['rail brand', '.ct-rail__brand', '.soc-rail__brand'],
      ['rail brand img', '.ct-rail__brand img', '.soc-rail__brand img'],
      ['rail label', '.ct-rail__label', '.soc-rail__label'],
      ['rail item', '.ct-rail__item:not(.is-active)', '.soc-rail__item:not(.is-active)'],
      ['rail item active', '.ct-rail__item.is-active', '.soc-rail__item.is-active'],
      ['rail count', '.ct-rail__item .ct-count', '.soc-rail__item .soc-count'],
      ['rail foot', '.ct-rail__foot', '.soc-rail__toggle'],
      ['topbar', '.ct-topbar', '.soc-topbar'],
      ['crumbs', '.ct-crumbs', '.soc-crumbs'],
      ['crumbs page', '.ct-crumbs b', '.soc-crumbs__page'],
      ['search', '.ct-search', '.soc-search'],
      ['kbd', '.ct-search .ct-kbd', '.soc-search .soc-kbd'],
      ['clock', '.ct-clock', '.soc-clock'],
      ['bell', '.ct-iconbtn', '.soc-iconbtn'],
      ['avatar', '.ct-avatar', '.soc-avatar'],
      ['user name', '.ct-user__name', '.soc-user__name'],
      ['content', '.ct-content', '.soc-content'],
      ['page title', '.ct-page-title', '.soc-page-title'],
      ['page meta', '.ct-page-meta', '.soc-page-meta'],
      ['btn secondary', '.ct-page-actions .ct-btn:not(.ct-btn--primary)', '.soc-page-actions .ant-btn-default'],
      ['btn primary', '.ct-page-actions .ct-btn--primary', '.soc-page-actions .ant-btn-primary'],
      ['kpi', '.ct-kpi', '.soc-kpi'],
      ['kpi label', '.ct-kpi__label', '.soc-kpi__label'],
      ['kpi value', '.ct-kpi__value', '.soc-kpi__value'],
      ['kpi foot', '.ct-kpi__foot', '.soc-kpi__foot'],
      ['card', '.ct-card', '.soc-dash-cols .ant-card'],
      ['card head', '.ct-card__head', '.soc-dash-cols .ant-card-head'],
      ['card title', '.ct-card__title', '.soc-dash-cols .ant-card-head-title'],
      ['card body', '.ct-card__body', '.soc-dash-cols .ant-card-body'],
      ['strip', '.ct-strip', '.soc-strip'],
      ['strip id', '.ct-strip__id', '.soc-strip__id'],
      ['strip no', '.ct-strip__id .no', '.soc-strip__no'],
      ['strip icao', '.ct-strip__pt .icao', '.soc-strip__icao'],
      ['strip eta', '.ct-strip__eta', '.soc-strip__eta'],
      ['pill sm', '.ct-strip .ct-pill--sm', '.soc-strip .soc-pill--sm'],
      ['attention row', '.att li', '.soc-attention li'],
      ['attention btn', '.att .ct-btn--sm', '.soc-attention .ant-btn'],
    ],
  },
  {
    name: '03-schedule',
    path: '/schedule',
    // Планшет снимается на дне, где есть рейсы: полосы сверяются с макетом.
    prepare: async (page) => {
      const [year, month, day] = (await busiestFlightDay(page)).split('-');
      const input = page.locator('.soc-plan-date input');
      await input.click();
      await input.fill(`${day ?? ''}.${month ?? ''}.${year ?? ''}`);
      await input.press('Enter');
      await page.waitForLoadState('networkidle');
      await expect(page.locator('.soc-bar').first()).toBeVisible({ timeout: 15_000 });
    },
    pairs: [
      ['content', '.ct-content', '.soc-content'],
      ['page title', '.ct-page-title', '.soc-page-title'],
      ['page meta', '.ct-page-meta', '.soc-page-meta'],
      ['meta pill', '.ct-page-meta .ct-pill', '.soc-page-meta .soc-pill'],
      ['view seg', '.ct-page-actions .ct-seg', '.soc-page-actions .ant-segmented'],
      ['view seg item', '.ct-page-actions .ct-seg .is-active', '.soc-page-actions .ant-segmented-item-selected'],
      ['btn primary', '.ct-page-actions .ct-btn--primary', '.soc-page-actions .ant-btn-primary'],
      ['banner', '.ct-banner', '.soc-banner'],
      ['banner title', '.ct-banner__title', '.soc-banner__title'],
      ['banner item', '.ct-banner__list li', '.soc-banner__list li'],
      ['banner note', '.ct-banner__note', '.soc-banner__note'],
      ['banner btn', '.ct-banner .ct-btn', '.soc-banner .ant-btn'],
      ['filters', '.filters', '.soc-filters'],
      ['filter search', '.filters .ct-input', '.soc-filters .ant-input-affix-wrapper'],
      ['filter select', '.filters .ct-select', '.soc-filters .ant-select-selector'],
      ['filter chip', '.filters .ct-btn', '.soc-filters .ant-btn'],
      ['legend', '.ct-legend', '.soc-legend'],
      ['scale seg', '.toolbar .ct-seg', '.soc-gantt-toolbar .ant-segmented'],
      ['gantt', '.ct-gantt', '.soc-gantt'],
      ['gantt head', '.ct-gantt__head', '.soc-gantt__head'],
      ['gantt head label', '.ct-gantt__head .ct-gantt__label', '.soc-gantt__head .soc-gantt__label'],
      ['scale tick', '.ct-gantt__scale span', '.soc-gantt__scale span'],
      ['group row', '.ct-gantt__row--group', '.soc-gantt__row--group'],
      ['group label', '.ct-gantt__row--group .ct-gantt__label', '.soc-gantt__row--group .soc-gantt__label'],
      ['row', '.ct-gantt__row:not(.ct-gantt__row--group)', '.soc-gantt__row:not(.soc-gantt__row--group)'],
      ['row label', '.ct-gantt__row:not(.ct-gantt__row--group) .ct-gantt__label', '.soc-gantt__row:not(.soc-gantt__row--group) .soc-gantt__label'],
      ['bar', '.ct-bar', '.soc-bar'],
      ['bar number', '.ct-bar b', '.soc-bar b'],
      ['now', '.ct-now', '.soc-now'],
      ['now flag', '.ct-now span', '.soc-now span'],
    ],
  },
];

/** Замер из README макетов: размеры, отступы, радиус, шрифт, цвета, положение. */
async function probe(page: Page, selector: string): Promise<Record<string, string | number> | null> {
  const element = page.locator(selector).first();
  if ((await element.count()) === 0) return null;
  return element.evaluate((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      pad: s.padding, radius: s.borderRadius,
      font: `${s.fontWeight} ${s.fontSize}/${s.lineHeight} ${s.fontFamily.split(',')[0] ?? ''}`,
      color: s.color, bg: s.backgroundColor, border: `${s.borderTopWidth} ${s.borderTopColor}`,
    };
  });
}

mkdirSync(OUT, { recursive: true });

test.describe('Сверка с макетами', () => {
  for (const screen of SCREENS) {
    if (ONLY.length > 0 && !ONLY.includes(screen.name)) continue;

    test(screen.name, async ({ page, browser }) => {
      await page.setViewportSize(VIEWPORT);
      if (screen.role !== null) await signInAs(page, screen.role ?? 'usr_disp1');
      await page.goto(screen.path, { waitUntil: 'networkidle' });
      await expect(page.locator(screen.ready ?? '.ant-layout').first()).toBeVisible({ timeout: 15_000 });
      if (screen.prepare) await screen.prepare(page);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/${screen.name}.png` });
      await page.screenshot({ path: `${OUT}/${screen.name}.full.png`, fullPage: true });

      const mockup = await browser.newPage({ viewport: VIEWPORT });
      await mockup.goto(pathToFileURL(`${MOCKUPS}/${screen.name}.html`).href);
      await mockup.evaluate(() => document.fonts.ready);

      const rows: Array<{ pair: string; key: string; mockup: unknown; app: unknown }> = [];
      for (const [label, mockSel, appSel] of screen.pairs) {
        const a = await probe(mockup, mockSel);
        const b = await probe(page, appSel);
        for (const key of Object.keys(a ?? b ?? {})) {
          const left = a?.[key] ?? '∅';
          const right = b?.[key] ?? '∅';
          if (String(left) !== String(right)) rows.push({ pair: label, key, mockup: left, app: right });
        }
        if (!a || !b) rows.push({ pair: label, key: 'exists', mockup: Boolean(a), app: Boolean(b) });
      }
      await mockup.close();

      writeFileSync(`${OUT}/${screen.name}.probe.json`, JSON.stringify(rows, null, 2));
      const table = rows.map((r) => `${r.pair.padEnd(16)} ${r.key.padEnd(7)} ${String(r.mockup).padEnd(44)} │ ${String(r.app)}`);
      writeFileSync(`${OUT}/${screen.name}.probe.txt`, `${table.join('\n')}\n`);
    });
  }
});
