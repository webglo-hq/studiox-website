import { expect, test } from '@playwright/test';
import { addPersonAndEnrol, signInAs } from '../support';

/**
 * BH-C1 through the browser against the real server: an administrator adds a person without ever seeing a
 * password or link, the person enrols with the single-use link from their own (demo) delivery log, and the role
 * that carries approval authority applies only when the Controller approves it.
 */

test('BH-C1: an admin adds a person who enrols with their own link, and the Controller approves the role', async ({ page }) => {
  test.setTimeout(5 * 60_000);
  await page.goto('/');
  await signInAs(page, 'tom');
  await addPersonAndEnrol(page, { name: 'Rosa Field', email: 'rosa.field@brambleway.example', role: 'Senior Accountant', entity: 'BW-UK', password: 'quiet-harbour-lantern-42' });
  await expect(page.getByText('You have no roles yet')).toBeVisible();
  expect(((await (await page.request.get('/api/session')).json()) as { roles: unknown[] }).roles).toEqual([]);

  // The Controller decides the request from My close; she sees who asked and that Rosa enrolled.
  await signInAs(page, 'hannah');
  await page.getByRole('link', { name: /Decide 1 access request/ }).click();
  const request = page.getByRole('listitem').filter({ hasText: 'Grant Senior Accountant (BW-UK only) to Rosa Field' });
  await expect(request).toContainText('asked by Tom Ridley');
  await expect(request).toContainText('has chosen a password');
  await request.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Approved: Grant Senior Accountant \(BW-UK only\) to Rosa Field/ })).toBeVisible();

  // Rosa now holds the role, limited to the UK entity.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByLabel('Work email').fill('rosa.field@brambleway.example');
  await page.getByLabel('Password', { exact: true }).fill('quiet-harbour-lantern-42');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  const me = (await (await page.request.get('/api/session')).json()) as { roles: Array<{ key: string; entity: string | null }> };
  expect(me.roles.map((r) => r.key)).toEqual(['senior_accountant']);
  expect(me.roles[0]!.entity).toBeTruthy();
});
