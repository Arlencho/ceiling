import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const JOURNEY_REPORT_NAME = 'last-run.md';
export const JOURNEY_PARTIAL_NAME = 'last-run.partial.md';
export const JOURNEY_TEMP_NAME = '.last-run.md.tmp';

export type JourneyReportPaths = {
  committed: string;
  partial: string;
  temporary: string;
};

export type JourneyReportStatus = 'writing' | 'complete' | 'failed';

export function journeyReportPaths(directory: string): JourneyReportPaths {
  return {
    committed: join(directory, JOURNEY_REPORT_NAME),
    partial: join(directory, JOURNEY_PARTIAL_NAME),
    temporary: join(directory, JOURNEY_TEMP_NAME),
  };
}

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}

// Writes the table to a temporary file. The committed summary is replaced only
// when the run completes. A failed run keeps its table in the gitignored partial file.
export function publishJourneyReport(paths: JourneyReportPaths, body: string, status: JourneyReportStatus): void {
  writeFileSync(paths.temporary, body);
  if (status === 'writing') return;
  if (status === 'complete') {
    renameSync(paths.temporary, paths.committed);
    try {
      unlinkSync(paths.partial);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    return;
  }
  renameSync(paths.temporary, paths.partial);
}
