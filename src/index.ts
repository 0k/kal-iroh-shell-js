/**
 * kal-iroh-shell page kit.
 *
 * Call {@link installShellReload} once at startup and {@link restoreViewState}
 * after the app mounts.  Components register what they own with
 * {@link useShellReloadSave} / {@link useShellBusy}.
 */
export * from './protocol.js';
export {
  BUSY_CHECK_MS, BUSY_RENEW_MS, RESTORE_FOCUS_MS, VIEW_STATE_KEY,
  installShellReload, onShellReloadSave, prepareReload, registerShellBusy, restoreViewState,
  saveViewState, useShellBusy, useShellReloadSave,
} from './reload.js';
export type { BusyProbe } from './reload.js';
export { markBoot, uiBuild, uiSource } from './bootMark.js';
