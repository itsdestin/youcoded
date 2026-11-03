// Tests of Destin's personal Home and Money pages, which never ship in the app (decision 2026-11-01).
// Run with `npm run test:personal-pages` after changing one of those pages or the workbench's pretend house.
// WHY reuse the main config's project(): the same sandboxed HOME, jsdom set-up and budgets as the app's suite.
import { defineConfig } from 'vitest/config';
import { PERSONAL_PAGES, project } from './vitest.config';

export default defineConfig({
  test: { projects: [project({ name: 'personal-pages', include: [`${PERSONAL_PAGES.replace('/**', '')}/**/*.test.ts`] })] },
});
