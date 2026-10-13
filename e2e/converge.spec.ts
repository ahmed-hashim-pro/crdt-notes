import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

// Frames for docs/converge.gif, when RECORD=1.
const RECORD = !!process.env.RECORD;
let frame = 0;
async function snap(a: Page, b: Page, caption: string) {
  if (!RECORD) return;
  mkdirSync('frames', { recursive: true });
  const n = String(frame++).padStart(2, '0');
  await a.screenshot({ path: `frames/${n}-a.png` });
  await b.screenshot({ path: `frames/${n}-b.png` });
  writeFileSync(`frames/${n}.txt`, caption);
}

const body = (p: Page) => p.getByTestId('body');
const online = async (p: Page, on: boolean) => {
  const box = p.getByTestId('online');
  if ((await box.isChecked()) !== on) await box.click();
  await expect(p.getByTestId('state')).toHaveText(on ? 'online' : 'offline');
};

test('two replicas edit offline and converge when they reconnect', async ({ browser }) => {
  // Two contexts: two separate browsers as far as storage goes.
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await a.goto('/');
  await b.goto('/');
  await expect(a.getByTestId('state')).toHaveText('online');
  await expect(b.getByTestId('state')).toHaveText('online');

  await a.getByTestId('new').click();
  await a.getByTestId('title').fill('Groceries');
  await body(a).click();
  await body(a).pressSequentially('milk\neggs\n');
  await expect(body(b)).toHaveValue('milk\neggs\n');
  await expect(b.getByTestId('title')).toHaveValue('Groceries');
  await snap(a, b, 'Online: A writes, B sees it as it is typed');

  await online(a, false);
  await online(b, false);
  await body(a).click();
  await a.keyboard.press('Control+End');
  await body(a).pressSequentially('bread\n');
  await a.getByTestId('tag').fill('weekly');
  await a.getByTestId('tag').press('Enter');
  await body(b).click();
  await b.keyboard.press('Control+Home');
  await body(b).pressSequentially('TODO ');
  await b.keyboard.press('Control+End');
  await body(b).pressSequentially('coffee\n');
  await b.getByTestId('title').fill('Groceries for Sat');
  await expect(body(a)).toHaveValue('milk\neggs\nbread\n');
  await expect(body(b)).toHaveValue('TODO milk\neggs\ncoffee\n');
  await snap(a, b, 'Both offline: each edits its own copy');

  await online(a, true);
  await online(b, true);
  await expect(body(a)).toHaveValue(/^TODO milk\neggs\n/);
  const merged = await body(a).inputValue();
  await expect(body(b)).toHaveValue(merged);
  expect(merged).toContain('bread\n');
  expect(merged).toContain('coffee\n');
  expect(merged.length).toBe('TODO milk\neggs\nbread\ncoffee\n'.length);
  await expect(a.getByTestId('title')).toHaveValue('Groceries for Sat');
  await expect(b.getByText('weekly')).toBeVisible();
  await snap(a, b, 'Back online: both copies merge to the same note');

  // The notes live in IndexedDB: a reload while offline still has them.
  await online(a, false);
  await a.reload();
  await a.getByTestId('online').uncheck();
  await expect(body(a)).toHaveValue(merged);
});

test('an edit made while the relay is down reaches the other side later', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await a.goto('/');
  await a.getByTestId('new').click();
  await a.getByTestId('title').fill('Later');
  await online(a, false);
  await body(a).click();
  await body(a).pressSequentially('written offline');
  await b.goto('/');
  await expect(b.getByTestId('note').filter({ hasText: 'Later' })).toBeVisible();
  await online(a, true);
  await b.getByTestId('note').filter({ hasText: 'Later' }).click();
  await expect(body(b)).toHaveValue('written offline');
});
