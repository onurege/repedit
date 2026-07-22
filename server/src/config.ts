export const config = {
  port: parseInt(process.env.PORT || '2567', 10),
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://district:district@localhost:5432/business_district',
  devTools:
    process.env.NODE_ENV !== 'production' && process.env.DEV_TOOLS !== '0',
  isProduction: process.env.NODE_ENV === 'production',
};
