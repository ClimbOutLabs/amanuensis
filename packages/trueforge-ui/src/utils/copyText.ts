/**
 * Copies text to the clipboard. `navigator.clipboard` exists only on https and localhost; on a plain http address
 * on the home network it is missing, so the older select-and-copy path is used instead.
 */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && 'clipboard' in navigator) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  document.body.appendChild(area);
  try {
    area.select();
    if (!document.execCommand('copy')) {
      throw new Error('Copying is not available in this browser');
    }
  } finally {
    area.remove();
  }
}
