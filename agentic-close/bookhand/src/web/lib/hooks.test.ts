import { describe, expect, it } from 'vitest';
import { keyBelongsToFocusedControl } from './hooks';

/** A stand-in for a focused DOM element: `closest` answers whether it sits inside an interactive control. */
const focused = (interactive: boolean) => ({ closest: (selector: string) => (interactive && selector.includes('button') ? {} : null) }) as unknown as EventTarget;

describe('keyboard shortcuts', () => {
  it('B-3: Enter and Space belong to the focused control, not to a page shortcut', () => {
    expect(keyBelongsToFocusedControl('Enter', focused(true))).toBe(true);
    expect(keyBelongsToFocusedControl(' ', focused(true))).toBe(true);
    // With nothing interactive focused (the page body), Enter is the "open the current item" shortcut.
    expect(keyBelongsToFocusedControl('Enter', focused(false))).toBe(false);
    expect(keyBelongsToFocusedControl('Enter', null)).toBe(false);
    // Letter shortcuts still work while a control has focus.
    expect(keyBelongsToFocusedControl('j', focused(true))).toBe(false);
  });
});
