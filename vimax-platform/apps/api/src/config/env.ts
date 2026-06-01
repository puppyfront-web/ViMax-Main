export function getEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

export function getEnvOptional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  databaseUrl: () => getEnvOptional("DATABASE_URL", "postgres://vimax:vimax@localhost:5432/vimax"),
  redisUrl: () => getEnvOptional("REDIS_URL", "redis://localhost:6379"),
  s3: {
    endpoint: () => getEnvOptional("S3_ENDPOINT", "http://localhost:9000"),
    bucket: () => getEnvOptional("S3_BUCKET", "vimax-assets"),
    accessKey: () => getEnvOptional("S3_ACCESS_KEY", "minioadmin"),
    secretKey: () => getEnvOptional("S3_SECRET_KEY", "minioadmin"),
    region: () => getEnvOptional("S3_REGION", "us-east-1"),
    forcePathStyle: () => getEnvOptional("S3_FORCE_PATH_STYLE", "true") === "true",
  },
  arkApiKey: () => getEnvOptional("ARK_API_KEY", ""),
  apiPort: () => Number(getEnvOptional("API_PORT", "3001")),
  apiHost: () => getEnvOptional("API_HOST", "0.0.0.0"),
};
