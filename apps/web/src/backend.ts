export const backendLabels = { go: 'Go', typescript: 'TypeScript', python: 'Python', java: 'Java' } as const;
export type Backend = keyof typeof backendLabels;

const jobPrefixes: Record<Backend, string> = { go: 'lab-job', typescript: 'lab-ts-job', python: 'lab-py-job', java: 'lab-java-job' };

// Vite proxies all backends on the same browser origin.
export function apiPath(backend: Backend, path: string) {
  return backend === 'go' ? path : '/' + backend + path;
}

export function jobCorrelationId(backend: Backend, key: string) {
  return jobPrefixes[backend] + '-' + key;
}

export function readBackend(): Backend {
  const stored = sessionStorage.getItem('workflow-lab:backend');
  return stored === 'typescript' || stored === 'python' || stored === 'java' ? stored : 'go';
}
