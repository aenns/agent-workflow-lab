export type Backend = 'go' | 'typescript';

export const backendLabels: Record<Backend, string> = { go: 'Go', typescript: 'TypeScript' };

// Vite proxies both backends on the same browser origin.
export function apiPath(backend: Backend, path: string) {
  return backend === 'typescript' ? '/typescript' + path : path;
}
