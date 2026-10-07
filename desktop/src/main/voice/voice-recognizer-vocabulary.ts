import * as path from 'path';
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';

const VOCAB_SHA256 = '41130ff456706304a1adec782ccc9e003c4d417e8e324353d281be958cac4e17';

/** WHY: native ONNX cannot read an asar member, and a utility process has no app API.
 * The host resolves this resource from Electron's app/resources paths, never cwd. */
export function voiceVocabularyAssetPath(appPath: string, resourcesPath?: string): string {
  return resourcesPath
    ? path.join(resourcesPath, 'voice', 'parakeet-tdt-v3.vocab')
    : path.join(appPath, 'resources', 'voice', 'parakeet-tdt-v3.vocab');
}

/** WHY: a mismatched BPE vocabulary can load but bias the wrong tokens. Check the
 * bundled original bytes before constructing the nonempty-vocabulary recognizer. */
export async function verifyVoiceVocabularyAsset(assetPath?: string): Promise<string> {
  if (!assetPath || !path.isAbsolute(assetPath)) throw new Error('The voice tokenizer asset path must be absolute.');
  const bytes = await readFile(assetPath);
  if (createHash('sha256').update(bytes).digest('hex') !== VOCAB_SHA256) {
    throw new Error(`Voice tokenizer checksum does not match: ${assetPath}`);
  }
  return assetPath;
}
