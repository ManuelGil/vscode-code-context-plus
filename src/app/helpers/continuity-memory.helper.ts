import type { Uri } from 'vscode';

type ContextEntry = {
  id: string;
  uri: Uri;
  title?: string;
  type?: string;
  ts: number;
};

// Session-scoped in-memory continuity store (bounded)
const MAX_TRAIL = 50;
const trail: ContextEntry[] = [];

export function pushContext(entry: {
  id: string;
  uri: Uri;
  title?: string;
  type?: string;
}) {
  const now = Date.now();
  // remove existing same-uri entries to move to front
  for (let i = trail.length - 1; i >= 0; i--) {
    if (trail[i].uri.toString() === entry.uri.toString()) {
      trail.splice(i, 1);
    }
  }
  trail.unshift({ ...entry, ts: now });
  if (trail.length > MAX_TRAIL) {
    trail.splice(MAX_TRAIL);
  }
}

export function getTrail(limit = 10): ReadonlyArray<ContextEntry> {
  return trail.slice(0, limit);
}

export function getRecentUris(): string[] {
  return trail.map((t) => t.uri.toString());
}

export function getRecencyIndex(uri: Uri): number {
  const i = trail.findIndex((t) => t.uri.toString() === uri.toString());
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

export function getMostRecentType(): string | undefined {
  return trail[0]?.type;
}

export function clearTrail(): void {
  trail.length = 0;
}
