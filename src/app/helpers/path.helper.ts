/**
 * String path helpers that avoid Node's `path` module.
 */

import { toPosixPath } from './path-format.helper';

/**
 * Normalizes a path to forward slashes.
 */
export function normalizePath(input: string): string {
  return toPosixPath(input);
}

/**
 * Returns the last segment of a path.
 */
export function getBaseName(input: string): string {
  const normalizedPath = normalizePath(input).replace(/\/+$/, '');
  if (normalizedPath === '') {
    return '';
  }
  const indexOfLastSeparator = normalizedPath.lastIndexOf('/');
  return indexOfLastSeparator === -1
    ? normalizedPath
    : normalizedPath.slice(indexOfLastSeparator + 1);
}

/**
 * Returns the directory portion of a path.
 */
export function getDirName(input: string): string {
  const normalizedPath = normalizePath(input).replace(/\/+$/, '');
  if (normalizedPath === '') {
    return '.';
  }
  const indexOfLastSeparator = normalizedPath.lastIndexOf('/');
  if (indexOfLastSeparator === -1) {
    return '.';
  }
  const dir = normalizedPath.slice(0, indexOfLastSeparator);
  return dir === '' ? '.' : dir;
}
