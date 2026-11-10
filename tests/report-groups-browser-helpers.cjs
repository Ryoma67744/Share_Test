'use strict';

// Use the real options UI when an existing report test intentionally compares
// all its sections. The export default is now one independent group per section.
async function compareAllReportSections(page, name = 'Synthetic comparison') {
  await page.locator('[data-report-add-group]').click();
  const group = page.locator('[data-report-group-id]').last();
  const id = await group.getAttribute('data-report-group-id');
  await group.locator('[data-report-group-name]').fill(name);
  await group.locator('[data-report-group-name]').dispatchEvent('change');
  for (const row of await page.locator('[data-report-section-id]').all()) {
    await row.locator('[data-report-output]').check();
    await row.locator('[data-report-group]').selectOption(id);
  }
  return id;
}

module.exports = {compareAllReportSections};
