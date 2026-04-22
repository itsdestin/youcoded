# Dev-only fake installers

These 1 MB zero-filled files are used by the `YOUCODED_DEV_FAKE_UPDATE` dev flag to exercise the in-app update download+launch flow without fetching from GitHub or actually launching a real installer.

The dev-mode launch handler calls `shell.showItemInFolder` on these files instead of spawning them — so setting the flag is safe.

Flag is gated on `!app.isPackaged`, so these files are never touched in a packaged build.
