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
  // 免费生成渠道（详见 docs/specs/FREE-MEDIA-MODELS-RESEARCH.md）：
  // 智谱 BigModel（CogView-3-Flash 生图 / CogVideoX-Flash 生视频，长期免费）
  // 与魔搭 API-Inference（每日 2000 次免费，ms- 令牌）。
  zhipuApiKey: () => getEnvOptional("ZHIPU_API_KEY", ""),
  modelScopeApiKey: () => getEnvOptional("MODELSCOPE_API_TOKEN", ""),
  // Agnes AI（OpenAI 兼容多模态：文本 / 图像 / 视频，https://apihub.agnes-ai.com/v1）。
  agnesApiKey: () => getEnvOptional("AGNES_API_KEY", ""),
  // 未显式指定模型时使用的默认模型 id（contracts preset id，如 cogview-3-flash）。
  defaultImageModelId: () => getEnvOptional("DEFAULT_IMAGE_MODEL", ""),
  defaultVideoModelId: () => getEnvOptional("DEFAULT_VIDEO_MODEL", ""),
  // i2i（带参考图）默认档：默认生图模型不支持参考图时回退到它
  // （如 cogview-3-flash → modelscope-qwen-image-edit）。
  defaultI2IImageModelId: () => getEnvOptional("DEFAULT_I2I_IMAGE_MODEL", ""),
  // preset 未带 apiKey 时按 provider 选择注入的 env key。
  apiKeyFor: (provider?: string): string => {
    switch (provider) {
      case "zhipu":
        return config.zhipuApiKey();
      case "modelscope":
        return config.modelScopeApiKey();
      case "agnes":
        return config.agnesApiKey();
      default:
        return config.arkApiKey();
    }
  },
  apiPort: () => Number(getEnvOptional("API_PORT", "3001")),
  apiHost: () => getEnvOptional("API_HOST", "0.0.0.0"),
  // 本地化存储策略：未认领 generated 资产的远端二进制保留时长（小时），
  // 0 = 关闭清扫。默认 24h：给客户端足够的认领窗口。
  assetSweepTtlHours: () => Number(getEnvOptional("ASSET_SWEEP_TTL_HOURS", "24")),
  // 观测导出（Langfuse OTLP）。三项齐备才启用导出，缺省仅透传 traceparent。
  observability: {
    langfuseHost: () => process.env.LANGFUSE_HOST,
    langfusePublicKey: () => process.env.LANGFUSE_PUBLIC_KEY,
    langfuseSecretKey: () => process.env.LANGFUSE_SECRET_KEY,
  },
};
