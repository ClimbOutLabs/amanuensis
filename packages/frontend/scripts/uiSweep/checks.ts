/** What the look-over measures on a screen by itself, before a person looks at the picture. */
import type { Page } from 'playwright-core';

/** The smallest side a control a finger presses should have, in CSS pixels. */
const SMALLEST_TAP = 24;
/** How many examples one finding names. */
const EXAMPLES = 4;

/** Plain sentences about what is wrong on the screen as it stands. An empty list means nothing was measured wrong. */
export async function measure({ page, phone }: { page: Page; phone: boolean }): Promise<string[]> {
  // The tool that runs this file wraps named functions in a helper the page does not have, so the page is given one.
  await page.evaluate('globalThis.__name ??= value => value');
  return page.evaluate(
    ({ smallestTap, examples, onPhone }) => {
      const findings: string[] = [];
      const width = window.innerWidth;
      const visible = (element: Element): boolean => {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
      };
      const describe = (element: Element): string => {
        const words = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().replace(/\s+/g, ' ');
        const tag = element.tagName.toLowerCase();
        return words === '' ? `<${tag}>` : `<${tag}> "${words.slice(0, 50)}"`;
      };
      const list = (elements: Element[]): string => {
        const shown = elements.slice(0, examples).map(describe).join('; ');
        return elements.length > examples ? `${shown}; and ${String(elements.length - examples)} more` : shown;
      };
      /** True when something above the element scrolls sideways on purpose, so sticking out is expected. */
      const insideSidewaysScroller = (element: Element): boolean => {
        for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
          const overflow = getComputedStyle(parent).overflowX;
          if ((overflow === 'auto' || overflow === 'scroll') && parent.scrollWidth > parent.clientWidth) return true;
        }
        return false;
      };

      if (document.documentElement.scrollWidth > width + 1) {
        findings.push(
          `The page scrolls sideways: it is ${String(document.documentElement.scrollWidth)} wide in a ${String(width)} window.`,
        );
      }

      const all = [...document.querySelectorAll('body *')].filter(visible);
      const stickingOut = all.filter(element => {
        const box = element.getBoundingClientRect();
        if (box.right <= width + 1 && box.left >= -1) return false;
        if (box.bottom < 0 || box.top > window.innerHeight) return false;
        return element.children.length === 0 && !insideSidewaysScroller(element);
      });
      if (stickingOut.length > 0) findings.push(`Parts stick out past the side of the window: ${list(stickingOut)}.`);

      const cutOff = all.filter(element => {
        const ownText = [...element.childNodes].some(
          node => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
        );
        if (!ownText || element.scrollWidth <= element.clientWidth + 1) return false;
        const style = getComputedStyle(element);
        return style.overflowX === 'hidden' && style.textOverflow !== 'ellipsis';
      });
      if (cutOff.length > 0) findings.push(`Words are cut off with no "..." to show it: ${list(cutOff)}.`);

      const controls = [
        ...document.querySelectorAll(
          'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="switch"]',
        ),
      ].filter(visible);
      const nameless = controls.filter(control => {
        const labelled = control.getAttribute('aria-labelledby');
        const named =
          (control.getAttribute('aria-label') ?? '').trim() !== '' ||
          (control.getAttribute('title') ?? '').trim() !== '' ||
          (control.textContent ?? '').trim() !== '' ||
          (labelled !== null && document.getElementById(labelled.split(' ')[0] ?? '') !== null) ||
          [...control.querySelectorAll('img[alt], svg[aria-label], svg title')].some(
            child => (child.getAttribute('alt') ?? child.getAttribute('aria-label') ?? child.textContent ?? '') !== '',
          );
        return !named;
      });
      if (nameless.length > 0) {
        findings.push(
          `${String(nameless.length)} control(s) have no name for a screen reader: ${nameless
            .slice(0, examples)
            .map(control => control.outerHTML.slice(0, 90))
            .join('; ')}.`,
        );
      }

      if (onPhone) {
        const small = controls.filter(control => {
          const box = control.getBoundingClientRect();
          if (box.bottom < 0 || box.top > window.innerHeight) return false;
          // A link inside a sentence is as tall as its line, which is fine.
          if (control.tagName === 'A' && getComputedStyle(control).display === 'inline') return false;
          return box.width < smallestTap || box.height < smallestTap;
        });
        if (small.length > 0) {
          findings.push(`Controls too small for a finger (under ${String(smallestTap)} px): ${list(small)}.`);
        }
      }

      const broken = [...document.querySelectorAll('img')].filter(
        image => visible(image) && image.complete && image.naturalWidth === 0,
      );
      if (broken.length > 0) {
        findings.push(`Pictures that did not load: ${broken.map(image => image.src.slice(-60)).join('; ')}.`);
      }
      return findings;
    },
    { smallestTap: SMALLEST_TAP, examples: EXAMPLES, onPhone: phone },
  );
}
