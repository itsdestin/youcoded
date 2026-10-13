# Parakeet TDT v3 tokenizer vocabulary

`parakeet-tdt-v3.vocab` is the original tokenizer vocabulary from **NVIDIA,
Parakeet TDT 0.6B v3**. The original NVIDIA model card identifies its model
license as Creative Commons Attribution 4.0 International (CC BY 4.0):
https://creativecommons.org/licenses/by/4.0/

Source model and model card, pinned revision:
https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/tree/541d1f99c6b0c3cd0b11a95167540bb8edefd82b

Source archive:
https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/resolve/541d1f99c6b0c3cd0b11a95167540bb8edefd82b/parakeet-tdt-0.6b-v3.nemo

Extracted member: `./0ee587b5d4b94f48993dcccf9868ea77_tokenizer.vocab`.
Extraction: recover the member from the first 2,097,152 bytes of the uncompressed
NeMo tar archive (HTTP Range `bytes=0-2097151`); its payload starts at byte 3072
and is 101,024 bytes long. The full weights/checkpoint are not needed.

Bundled SHA-256:
`41130ff456706304a1adec782ccc9e003c4d417e8e324353d281be958cac4e17`.

Changes: filename only. No vocabulary generation, token changes, score changes,
or numeric reformatting. These original 8192 SentencePiece pieces and scores
were checked against the model's original tokenizer; the model's additional
blank token in tokens.txt is not a SentencePiece vocabulary entry.

This attribution describes this tokenizer asset and its source only; it makes
no license claim about the rest of YouCoded or other speech runtime/model files.
