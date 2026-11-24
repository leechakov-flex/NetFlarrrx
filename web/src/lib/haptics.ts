/**
 * A light haptic tap for actions you confirm (request, grab, delete…).
 *
 * Android: the Vibration API. iPhone: Safari has no Vibration API, but since iOS 18
 * toggling a native `<input type="checkbox" switch>` plays the system haptic. Clicking
 * a hidden label for one does the same, so that's what this does. It's undocumented
 * behaviour, so it may stop working in a future iOS; nothing breaks if it does.
 *
 * Must be called synchronously inside a tap/click handler, or iOS ignores it.
 */
let label: HTMLLabelElement | null = null;

export function haptic() {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function' && !/iP(hone|ad|od)/.test(navigator.userAgent)) {
      navigator.vibrate(10);
      return;
    }
    if (!label) {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      input.id = 'ms-haptic';
      input.tabIndex = -1;
      input.setAttribute('aria-hidden', 'true');
      label = document.createElement('label');
      label.htmlFor = input.id;
      label.setAttribute('aria-hidden', 'true');
      const box = document.createElement('div');
      box.setAttribute('data-keep-active', '');   // useModal leaves it usable while a panel is open
      box.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
      box.append(input, label);
      document.body.append(box);
    }
    const had = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    label.click();
    had?.focus({ preventScroll: true });   // the hidden switch never keeps focus
  } catch { /* no haptics here */ }
}
