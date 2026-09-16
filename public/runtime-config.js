let config = null;

export async function loadRuntimeConfig() {
  if (config) return config;
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error('Runtime configuration could not be loaded');
  config = await response.json();
  return config;
}

export function runtimeConfig() {
  if (!config) throw new Error('Runtime configuration has not been loaded');
  return config;
}
