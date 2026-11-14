// Re-exports of the shared wire pieces the fake relay needs, so the fake imports them from ONE place.
export { CLOSE_AUTH_FAILED, CLOSE_DEVICE_REMOVED, CLOSE_VERSION_REFUSED, MESH_PROTOCOL_VERSION as MESH_MAX_VERSION_FOR_TESTS, packMessage, unpackMessage } from '../../src/shared/mesh-protocol';
