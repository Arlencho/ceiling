export function logLine(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

export function logError(message: string): void {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}
