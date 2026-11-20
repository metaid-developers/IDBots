import React, { useEffect, useState } from 'react';
import { buildStyles, loginPlaceholderStyleTag } from './loginStyles';
import { initLoginTheme } from './theme';

const loginTheme = initLoginTheme();

function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(loginTheme.isDark());
  useEffect(
    () => loginTheme.subscribe(() => setIsDark(loginTheme.isDark())),
    [],
  );
  return isDark;
}

export function useLoginStyles(): Record<string, React.CSSProperties> {
  const isDark = useIsDark();
  return React.useMemo(() => buildStyles(isDark), [isDark]);
}

export function LoginPlaceholderStyle(): JSX.Element {
  const isDark = useIsDark();
  return <style>{loginPlaceholderStyleTag(isDark)}</style>;
}
