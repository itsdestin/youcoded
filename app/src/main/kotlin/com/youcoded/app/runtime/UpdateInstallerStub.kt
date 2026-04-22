package com.youcoded.app.runtime

import org.json.JSONObject

// Android stub for the desktop in-app update installer.
// Mirrors the five IPC message types declared in
// desktop/src/shared/update-install-types.ts. Android updates via Play Store or
// direct APK sideload; this feature is desktop-only.
//
// Keep message type strings in sync with:
//   desktop/src/main/preload.ts (exposeInMainWorld: 'claude')
//   desktop/src/renderer/remote-shim.ts (claude.update.*)
//   desktop/src/main/ipc-handlers.ts (ipcMain.handle)
//   desktop/tests/update-install-ipc.test.ts (parity assertion)
object UpdateInstallerStub {
    fun unsupported(): JSONObject {
        return JSONObject().apply {
            put("success", false)
            put("error", "not-supported")
        }
    }
}
