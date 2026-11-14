import { beforeEach, describe, expect, it } from 'vitest';
import { closeDoc, finishClose, HOME_TAB, officeTabsNow, openDoc, putDocBack, resetOfficeStoreForTests, selectTab, tabPlace } from '../../src/renderer/components/office/office-store';
import type { OfficeFile } from '../../src/shared/office-types';

const f = (name: string): OfficeFile => ({ path: `/d/${name}`, name, kind: 'document', folder: 'd', at: '2026-11-14T00:00:00.000Z' });
const order = () => officeTabsNow().docs.map((d) => d.file.name);

beforeEach(() => { resetOfficeStoreForTests(); });

describe('putDocBack (a renamed file\'s tab returns where it was)', () => {
  function threeTabsHomeInFront() {
    openDoc(f('a.docx')); openDoc(f('b.docx')); openDoc(f('c.docx'));
    selectTab(HOME_TAB);
  }

  it('puts the tab back in its original spot under the new name, and Home stays in front', () => {
    threeTabsHomeInFront();
    const place = tabPlace('/d/b.docx')!;
    closeDoc('/d/b.docx'); finishClose('/d/b.docx');
    putDocBack('/d/b.docx', f('B2.docx'), place);
    expect(order()).toEqual(['a.docx', 'B2.docx', 'c.docx']);
    expect(officeTabsNow().active).toBe(HOME_TAB);
  });

  it('after a refused rename it returns under the old name in the same spot', () => {
    threeTabsHomeInFront();
    const place = tabPlace('/d/a.docx')!;
    closeDoc('/d/a.docx'); finishClose('/d/a.docx');
    putDocBack('/d/a.docx', f('a.docx'), place);
    expect(order()).toEqual(['a.docx', 'b.docx', 'c.docx']);
    expect(officeTabsNow().active).toBe(HOME_TAB);
  });

  it('keeps the renamed tab in front when it was in front', () => {
    threeTabsHomeInFront();
    selectTab('/d/b.docx');
    const place = tabPlace('/d/b.docx')!;
    closeDoc('/d/b.docx'); finishClose('/d/b.docx');
    putDocBack('/d/b.docx', f('B2.docx'), place);
    expect(officeTabsNow().active).toBe('/d/B2.docx');
  });
});
