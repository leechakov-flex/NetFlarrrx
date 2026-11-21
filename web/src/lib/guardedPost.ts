import { useCallback } from 'react';
import { ApiError, postJson, savedPasscode, useMeta } from './api';
import { useAskPasscode } from '../components/Feedback';

/**
 * POST that asks for the passcode when the server needs one (once, then kept on
 * this device), and asks again if the saved one is wrong. Resolves null if you cancel.
 */
export function useGuardedPost() {
  const meta = useMeta();
  const askPasscode = useAskPasscode();
  return useCallback(async <T,>(path: string, body: unknown = {}): Promise<T | null> => {
    const needs = meta.data?.passcodeRequired;
    let code = needs ? savedPasscode.get() : null;
    if (needs && !code) {
      code = await askPasscode();
      if (!code) return null;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await postJson<T>(path, body, code);
        if (code) savedPasscode.set(code);
        return res;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401 && attempt < 3) {
          savedPasscode.clear();
          code = await askPasscode({ wrong: attempt > 0 || !!code });
          if (!code) return null;
          continue;
        }
        throw err;
      }
    }
  }, [meta.data?.passcodeRequired, askPasscode]);
}
