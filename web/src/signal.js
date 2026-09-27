// Tiny observable value + Preact hook (keeps the bundle free of extra state libraries).
import { useEffect, useState } from 'preact/hooks';

export function signal(initial) {
  let value = initial;
  const subs = new Set();
  return {
    get value() { return value; },
    set value(v) { value = v; for (const s of [...subs]) s(v); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

export function useSignal(sig) {
  const [, force] = useState(0);
  useEffect(() => sig.subscribe(() => force(x => x + 1)), [sig]);
  return sig.value;
}
