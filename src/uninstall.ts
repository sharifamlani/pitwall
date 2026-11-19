/**
 * The manifest's `vscode:uninstall` script (Q46 = A): the editor runs
 * `node ./out/uninstall.js` once Pitwall is fully uninstalled, with no
 * extension host and no `vscode` API. It removes the one per-user registry key
 * Pitwall writes, `HKCU\Software\Classes\AppUserModelId\sharifamlani.pitwall`.
 * Elsewhere than Windows it does nothing.
 *
 * The key is per Windows user, so another editor profile that still has
 * Pitwall installed writes it again on its next start.
 */
import { WindowsToast } from './core/notify/WindowsToast';

export async function removeRegistration(toast: Pick<WindowsToast, 'unregisterAumid'> = new WindowsToast()): Promise<void> {
  await toast.unregisterAumid();
}

// Run only as the uninstall entry point, never when a bundle that imports this file loads it.
if (/[\\/]uninstall\.js$/.test(process.argv[1] ?? '')) {
  removeRegistration().catch(() => undefined);
}
