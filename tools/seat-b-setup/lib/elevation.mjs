import { parseElevation } from './detect.mjs';

/** Runs `whoami /groups` through the given exec and reports elevation. */
export function detectElevation(exec) {
  try {
    return parseElevation(exec('whoami /groups'));
  } catch {
    return false;
  }
}
