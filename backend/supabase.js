function isServiceRoleKey(key) {
  if (/^(?:sb_secret_|service_role)/i.test(key)) return true;
  const payload = key.split('.')[1];
  if (!payload) return false;
  try {
    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decoded).role === 'service_role';
  } catch {
    return false;
  }
}

export async function connectSupabase() {
  const config = window.__SUPABASE_CONFIG__;
  const projectUrlValue = config && typeof config.url === 'string' ? config.url.trim() : '';
  const publicKey = config && typeof config.anonKey === 'string' ? config.anonKey.trim() : '';
  if (!projectUrlValue || !publicKey) {
    throw new Error('Supabase is not configured. In backend/config.js, set window.__SUPABASE_CONFIG__.url and window.__SUPABASE_CONFIG__.anonKey to your project URL and public anon/publishable key.');
  }
  if (isServiceRoleKey(publicKey)) {
    throw new Error('A service-role or secret key cannot be used in the browser. Configure the public anon or publishable key.');
  }
  let projectUrl;
  try {
    projectUrl = new URL(projectUrlValue);
  } catch {
    throw new Error('The Supabase project URL in backend/config.js is invalid.');
  }
  const localHttp = projectUrl.protocol === 'http:' &&
    (projectUrl.hostname === 'localhost' || projectUrl.hostname === '127.0.0.1');
  if (projectUrl.protocol !== 'https:' && !localHttp) {
    throw new Error('Use an HTTPS Supabase project URL (HTTP is allowed only for localhost development).');
  }
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  return createClient(projectUrl.origin, publicKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
}
