import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOOT_MARK_PATH } from '../src/protocol';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.innerHTML = '';
});

/** Text of a jsdom `Blob`, which has no `text()`. */
function blobText(blob: Blob): Promise<string> {
  return new Promise(done => {
    const reader = new FileReader();
    reader.onload = () => done(reader.result as string);
    reader.readAsText(blob);
  });
}

/** A fresh `bootMark` module: each page load reports a phase once. */
async function bootMark() {
  return import('../src/bootMark');
}

describe('boot marks', () => {
  it("reads the source and build id the shell put on the page's root element", async () => {
    document.body.innerHTML = '<div id="app" data-ui-source="remote" data-ui-build="20261028T120000-abcdef"></div>';
    const { uiBuild, uiSource } = await bootMark();

    expect([uiSource(), uiBuild()]).toEqual(['remote', '20261028T120000-abcdef']);
  });

  it('says unknown on a page the shell did not serve', async () => {
    const { uiBuild, uiSource } = await bootMark();

    expect([uiSource(), uiBuild()]).toEqual(['unknown', 'unknown']);
  });

  it('sends each phase once, as a beacon to the shell', async () => {
    document.body.innerHTML = '<div data-ui-source="embedded" data-ui-build="20261028T120000-abcdef"></div>';
    const beacon = vi.fn((_path: string, _data: Blob) => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const { markBoot } = await bootMark();

    markBoot('mounted');
    markBoot('mounted');
    markBoot('data');

    expect(beacon.mock.calls.map(([path]) => path)).toEqual([BOOT_MARK_PATH, BOOT_MARK_PATH]);
    const first = JSON.parse(await blobText(beacon.mock.calls[0][1]));
    expect(first).toEqual({
      phase: 'mounted',
      epoch_ms: expect.any(Number),
      page_ms: expect.any(Number),
      source: 'embedded',
      build_id: '20261028T120000-abcdef',
    });
  });
});
