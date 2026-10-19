import { useCallback, useEffect, useState } from 'react';
import { safeStorage } from '../storage';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'evenkeel.theme';

export function storedTheme(): ThemeChoice {
  const v = safeStorage.get('local', KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
}

/** Light and dark come from CSS tokens; this only records an explicit choice. */
export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [theme, setTheme] = useState<ThemeChoice>(storedTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const set = useCallback((t: ThemeChoice) => {
    setTheme(t);
    if (t === 'system') safeStorage.remove('local', KEY);
    else safeStorage.set('local', KEY, t);
  }, []);
  return [theme, set];
}
