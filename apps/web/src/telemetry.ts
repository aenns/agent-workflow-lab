export const correlationHeader = 'X-Correlation-ID';

type LogFields = Record<string, string | number | boolean | undefined>;
type LogLevel = 'info' | 'warn';

export type LogEntry = {
  time: string;
  msg: string;
  service?: string;
  component?: string;
  level?: string;
  correlation_id?: string;
};

const browserLogs: LogEntry[] = [];

export function readBrowserLogs(): LogEntry[] {
  return browserLogs.slice();
}

function log(level: LogLevel, message: string, fields: LogFields) {
  // Keep the browser fields compatible with the Go slog JSON handler.
  const entry = {
    ...fields,
    time: new Date().toISOString(),
    level,
    service: 'web',
    component: 'http-client',
    msg: message,
  };
  browserLogs.unshift(entry);
  if (browserLogs.length > 100) browserLogs.pop();
  console[level](JSON.stringify(entry));
}

export async function correlatedFetch(
  path: string,
  options: RequestInit = {},
  correlationId: string = crypto.randomUUID(),
  fields: LogFields = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set(correlationHeader, correlationId);
  const metadata = { ...fields, correlation_id: correlationId, route: path, method: options.method ?? 'GET' };
  const start = performance.now();
  log('info', 'http.request.started', metadata);
  try {
    const response = await fetch(path, { ...options, headers });
    log(response.ok ? 'info' : 'warn', 'http.request.completed', {
      ...metadata,
      correlation_id: response.headers.get(correlationHeader) ?? correlationId,
      status: response.status,
      duration_ms: Math.round(performance.now() - start),
    });
    return response;
  } catch (error) {
    if (!options.signal?.aborted) {
      log('warn', 'http.request.failed', { ...metadata, duration_ms: Math.round(performance.now() - start) });
    }
    throw error;
  }
}
