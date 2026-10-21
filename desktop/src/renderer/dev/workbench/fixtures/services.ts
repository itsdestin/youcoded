// AI services the Add provider form offers by name (custom-providers, 2026-10-20).
// Real rows from models.dev/api.json, fetched 2026-10-20: name, published API
// address and model count, for services reached through an OpenAI-compatible
// endpoint. The real list is ~190 rows; this is a representative slice so the
// workbench's search behaves the way the real one will.
import type { ServiceEntry } from '../../../../shared/provider-types';

export function services(): ServiceEntry[] {
  return [
    { id: 'alibaba', label: 'Alibaba', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', modelCount: 59 },
    { id: 'baseten', label: 'Baseten', baseUrl: 'https://inference.baseten.co/v1', modelCount: 26 },
    { id: 'chutes', label: 'Chutes', baseUrl: 'https://llm.chutes.ai/v1', modelCount: 40 },
    { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', modelCount: 4, models: [
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextLength: 1048576, priceIn: 0.66, priceOut: 1.98, tools: true },
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', contextLength: 1048576, priceIn: 0.15, priceOut: 0.6, tools: true },
    ] },
    { id: 'fireworks-ai', label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', modelCount: 24 },
    { id: 'huggingface', label: 'Hugging Face', baseUrl: 'https://router.huggingface.co/v1', modelCount: 82 },
    // models.dev, 2026-10-20: Mercury Edit 2 is listed without tool use, so it reads
    // that way in the Models fold rather than being left out.
    { id: 'inception', label: 'Inception', baseUrl: 'https://api.inceptionlabs.ai/v1', modelCount: 4, models: [
      { id: 'mercury-3', label: 'Mercury 3', contextLength: 1000000, priceIn: 0.1, priceOut: 0.35, tools: true },
      { id: 'mercury-2.5', label: 'Mercury 2.5', contextLength: 260000, priceIn: 0.04, priceOut: 0.15, tools: true },
      { id: 'mercury-2', label: 'Mercury 2', contextLength: 128000, priceIn: 0.25, priceOut: 0.75, tools: true },
      { id: 'mercury-edit-2', label: 'Mercury Edit 2', contextLength: 32000, priceIn: 0.25, priceOut: 0.75, tools: false },
    ] },
    { id: 'moonshotai', label: 'Moonshot AI', baseUrl: 'https://api.moonshot.ai/v1', modelCount: 4 },
    { id: 'nebius', label: 'Nebius Token Factory', baseUrl: 'https://api.tokenfactory.nebius.com/v1', modelCount: 30 },
    { id: 'nvidia', label: 'Nvidia', baseUrl: 'https://integrate.api.nvidia.com/v1', modelCount: 107 },
    { id: 'ollama-cloud', label: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', modelCount: 28 },
    { id: 'requesty', label: 'Requesty', baseUrl: 'https://router.requesty.ai/v1', modelCount: 60 },
    { id: 'scaleway', label: 'Scaleway', baseUrl: 'https://api.scaleway.ai/v1', modelCount: 15 },
    { id: 'siliconflow', label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.com/v1', modelCount: 50 },
    { id: 'zai', label: 'Z.AI', baseUrl: 'https://api.z.ai/api/paas/v4', modelCount: 18 },
  ];
}
