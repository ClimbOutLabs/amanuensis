/**
 * Where focus should return after a dialog a button opened has closed. A menu row unmounts as it
 * opens the dialog, so for a row this is the menu's trigger; otherwise it is the button itself.
 */
export function menuTriggerFor(button: HTMLElement): HTMLElement {
  const menuId = button.closest('[role="menu"]')?.id;
  if (menuId == null || menuId === '') return button;
  return document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menuId)}"]`) ?? button;
}
