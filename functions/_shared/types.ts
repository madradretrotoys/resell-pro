// Minimal shared Env type used by functions
export type Env = {
  DATABASE_URL?: string;
  RP_ENCRYPTION_KEY?: string;
  APP_BASE_URL?: string;
  PUBLIC_APP_URL?: string;
};
