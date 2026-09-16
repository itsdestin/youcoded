// The PUBLIC half of the YouCoded update-signing key (ed25519, SPKI PEM).
//
// WHY (2026-09-10 security review, #7): the in-app updater used to install
// whatever it downloaded from GitHub after checking only the host. If a GitHub
// login or one of the thousands of build-time packages were ever compromised, a
// tampered installer would be trusted. Now each release ships a signed manifest
// of its files' fingerprints, and the app verifies that signature against THIS
// key before running anything.
//
// This is the PUBLIC key — safe to embed and publish. The matching PRIVATE key
// lives outside the repo (see ~/system/youcoded-release-signing/README.md) and
// signs the manifest in a locked-down release step. Rotating the key means
// replacing this constant, shipping a release, then updating the CI secret.
export const UPDATE_SIGNING_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAlErOYGRTiuNRoMZMdtVQsdWiGMcv2RTTUwtVLdwCL5I=
-----END PUBLIC KEY-----
`;
