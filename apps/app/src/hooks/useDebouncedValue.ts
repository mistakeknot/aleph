import { useEffect, useRef, useState } from "react";

export function useDebouncedValue<T>(
  value: T,
  delay: number | ((settledValue: T) => number),
): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(() => value);
  const delayRef = useRef(delay);
  delayRef.current = delay;

  useEffect(() => {
    if (Object.is(value, debouncedValue)) {
      return;
    }

    const currentDelay = delayRef.current;
    const delayMs =
      typeof currentDelay === "function"
        ? currentDelay(debouncedValue)
        : currentDelay;
    const timeoutId = window.setTimeout(() => {
      setDebouncedValue(() => value);
    }, delayMs);

    return () => window.clearTimeout(timeoutId);
  }, [debouncedValue, value]);

  return debouncedValue;
}
