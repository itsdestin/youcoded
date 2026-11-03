// A REAL `GET /models` response from the PINNED llama-server (b10665), spawned with --models-dir over a directory holding
// SmolVLM-256M twice: beside its mmproj-*.gguf (the vision layout) and as a lone flat .gguf. The cache path in
// status.args/preset is shortened. Live check: test-engine/probe-vision.mjs; schema: docs/engine-dependencies.md.
export const REAL_MODELS_RESPONSE = {
  data: [
    {
      id: 'SmolVLM-256M-Instruct-Q8_0',
      aliases: [], tags: [], object: 'model', owned_by: 'llamacpp', created: 1788656122,
      status: {
        value: 'unloaded',
        args: ['/engine/llama-server', '--host', '127.0.0.1', '--jinja', '--port', '0', '--no-webui',
          '--alias', 'SmolVLM-256M-Instruct-Q8_0', '--ctx-size', '4096',
          '--model', '/cache/SmolVLM-256M-Instruct-Q8_0/SmolVLM-256M-Instruct-Q8_0.gguf',
          '--mmproj', '/cache/SmolVLM-256M-Instruct-Q8_0/mmproj-SmolVLM-256M-Instruct-f16.gguf'],
        preset: '[SmolVLM-256M-Instruct-Q8_0]\njinja = 1\nwebui = 0\nctx-size = 4096\n',
      },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      source: 'models_dir', can_remove: false,
    },
    {
      id: 'SmolVLM-256M-TextOnly-Q8_0',
      aliases: [], tags: [], object: 'model', owned_by: 'llamacpp', created: 1788656122,
      status: {
        value: 'unloaded',
        args: ['/engine/llama-server', '--host', '127.0.0.1', '--jinja', '--port', '0', '--no-webui',
          '--alias', 'SmolVLM-256M-TextOnly-Q8_0', '--ctx-size', '4096',
          '--model', '/cache/SmolVLM-256M-TextOnly-Q8_0.gguf'],
        preset: '[SmolVLM-256M-TextOnly-Q8_0]\njinja = 1\nwebui = 0\nctx-size = 4096\n',
      },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      source: 'models_dir', can_remove: false,
    },
  ],
  object: 'list',
};
