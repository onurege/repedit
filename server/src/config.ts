const DEFAULT_DB_URL = 'postgres://district:district@localhost:5432/business_district';

export const config = {
  port: parseInt(process.env.PORT || '2567', 10),
  databaseUrl: process.env.DATABASE_URL || DEFAULT_DB_URL,
  // Dev tools (add money / inventory, time warp, reset) are ALWAYS off in
  // production, and can be turned off in development with DEV_TOOLS=0.
  devTools:
    process.env.NODE_ENV !== 'production' && process.env.DEV_TOOLS !== '0',
  isProduction: process.env.NODE_ENV === 'production',
  // Optional comma-separated allowlist of browser origins (e.g.
  // "https://play.example.com"). Unset = allow all (fine behind a proxy).
  corsOrigins: (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

/** Warn loudly if production is running with insecure development defaults. */
export function warnInsecureDefaults(): void {
  if (!config.isProduction) return;
  if (config.databaseUrl === DEFAULT_DB_URL) {
    console.warn('[server] WARNING: using the default development DATABASE_URL in production.');
  }
}
