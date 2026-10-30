import { effectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_GLOBAL } from '../src/protocol';
import {
  BUSY_CHECK_MS, BUSY_RENEW_MS, __resetShellReloadForTests, installShellReload, onShellReloadSave,
  prepareReload, registerShellBusy, restoreViewState, saveViewState, useShellBusy, useShellReloadSave,
} from '../src/reload';

/** Every answer the page sent to the shell. */
function acks(fetchMock: ReturnType<typeof vi.fn>): unknown[] {
  return fetchMock.mock.calls
    .filter(([url]) => url === '/__shell/reload-ack')
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

/** `CSS.escape`, which browsers have and jsdom lacks (enough for these tests). */
function cssEscape(value: string): string {
  return value.replace(/^\d/, digit => `\\3${digit} `).replace(/[^\w-]/g, char => `\\${char}`);
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal('CSS', { escape: cssEscape });
  vi.useFakeTimers();
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  __resetShellReloadForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  document.body.innerHTML = '';
});

describe('shell reload handshake (page side)', () => {
  it('saves everything then answers ready when nothing is in progress', () => {
    const order: string[] = [];
    onShellReloadSave(() => order.push('draft'));
    onShellReloadSave(() => { throw new Error('a broken saver'); });
    onShellReloadSave(() => order.push('scroll'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    prepareReload(3);

    expect(order).toEqual(['draft', 'scroll']);
    expect(acks(fetchMock)).toEqual([{ request: 3, status: 'ready' }]);
  });

  it('answers busy with the reason, renews it, and turns ready once it clears', () => {
    let recording = true;
    let saves = 0;
    registerShellBusy(() => (recording ? 'microphone on' : null));
    onShellReloadSave(() => { saves++; });

    prepareReload(1);
    expect(acks(fetchMock)).toEqual([{ request: 1, status: 'busy', reason: 'microphone on' }]);

    vi.advanceTimersByTime(BUSY_RENEW_MS);
    expect(acks(fetchMock)).toHaveLength(2);

    recording = false;
    vi.advanceTimersByTime(BUSY_CHECK_MS);
    expect(acks(fetchMock).at(-1)).toEqual({ request: 1, status: 'ready' });
    expect(saves).toBe(2);

    vi.advanceTimersByTime(BUSY_RENEW_MS * 2);
    expect(acks(fetchMock)).toHaveLength(3);
  });

  it('puts the cursor back in the field being typed in after the reload', () => {
    const page = '<main><div><textarea></textarea></div></main>';
    document.body.innerHTML = page;
    const before = document.querySelector('textarea')!;
    before.value = 'hello world';
    before.focus();
    before.setSelectionRange(6, 11);

    saveViewState();
    document.body.innerHTML = page;
    document.querySelector('textarea')!.value = 'hello world';
    restoreViewState();

    const after = document.querySelector('textarea')!;
    expect(document.activeElement).toBe(after);
    expect([after.selectionStart, after.selectionEnd]).toEqual([6, 11]);
  });

  it('refocuses the field itself, not an earlier field nested the same way', () => {
    const page = '<section><p></p><div><input class="decoy"></div></section><div><input class="field"></div>';
    document.body.innerHTML = page;
    document.querySelector<HTMLInputElement>('.field')!.focus();

    saveViewState();
    document.body.innerHTML = page;
    restoreViewState();

    expect(document.activeElement).toBe(document.querySelector('.field'));
  });

  it.each([
    ['inside an SVG foreignObject', '<svg><foreignObject><input class="field"></foreignObject></svg>'],
    ['inside a custom element with a dot in its name', '<x-a.b><input class="field"></x-a.b>'],
  ])('refocuses a field %s', (_, page) => {
    document.body.innerHTML = page;
    document.querySelector<HTMLInputElement>('.field')!.focus();

    saveViewState();
    document.body.innerHTML = page;
    restoreViewState();

    expect(document.activeElement).toBe(document.querySelector('.field'));
  });

  it('does not wait on a busy probe that throws: it counts as not busy', () => {
    registerShellBusy(() => { throw new Error('a broken probe'); });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    prepareReload(4);

    expect(acks(fetchMock)).toEqual([{ request: 4, status: 'ready' }]);
    expect(errors).toHaveBeenCalledWith('shell reload: a busy probe failed', expect.any(Error));
  });

  it('turns ready when a probe starts throwing while busy', () => {
    let state: 'busy' | 'broken' = 'busy';
    registerShellBusy(() => {
      if (state === 'broken') throw new Error('a broken probe');
      return 'uploading';
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    prepareReload(5);
    state = 'broken';
    vi.advanceTimersByTime(BUSY_CHECK_MS);

    expect(acks(fetchMock)).toEqual([
      { request: 5, status: 'busy', reason: 'uploading' },
      { request: 5, status: 'ready' },
    ]);
  });

  it('registers savers and busy probes for the lifetime of a Vue scope', () => {
    let saves = 0;
    let recording = true;
    const scope = effectScope();
    scope.run(() => {
      useShellReloadSave(() => { saves++; });
      useShellBusy('microphone on', () => recording);
    });

    prepareReload(6);
    expect(acks(fetchMock)).toEqual([{ request: 6, status: 'busy', reason: 'microphone on' }]);
    expect(saves).toBe(1);

    recording = false;
    vi.advanceTimersByTime(BUSY_CHECK_MS);
    scope.stop();
    recording = true;
    prepareReload(7);

    expect(acks(fetchMock).at(-1)).toEqual({ request: 7, status: 'ready' });
    expect(saves).toBe(2);
  });

  it('exposes prepareReload to the shell and saves the focused field on a reload', () => {
    document.body.innerHTML = '<main><input></main>';
    document.querySelector('input')!.focus();
    installShellReload();

    (window as unknown as Record<string, { prepareReload(n: number): void }>)[PAGE_GLOBAL].prepareReload(8);

    expect(acks(fetchMock)).toEqual([{ request: 8, status: 'ready' }]);
    document.body.innerHTML = '<main><input></main>';
    restoreViewState();
    expect(document.activeElement).toBe(document.querySelector('input'));
  });
});
