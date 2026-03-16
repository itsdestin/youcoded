'use strict';

// Android SELinux exec bypass for Claude Code.
//
// Binaries extracted to app_data_file contexts can't be exec'd directly
// (SELinux denies execute permission). This wrapper patches Node's
// child_process and fs modules to route embedded binary execution through
// /system/bin/linker64, which loads ELF binaries via mmap instead of exec.
//
// This complements the termux-exec LD_PRELOAD approach:
// - termux-exec intercepts exec() at the libc level (handles bash subprocesses)
// - This wrapper intercepts at the Node.js level (handles validation + spawn)
// If termux-exec is working, these patches are redundant but harmless.

var child_process = require('child_process');
var fs = require('fs');
var path = require('path');

var LINKER64 = '/system/bin/linker64';
var PREFIX = process.env.PREFIX || '';

function isEmbeddedBinary(file) {
    if (!file || !PREFIX) return false;
    // Check if the file is under the embedded runtime prefix
    return file.startsWith(PREFIX + '/');
}

// --- fs.accessSync patch ---
// Claude Code's shell validator (iJ$) calls fs.accessSync(shell, X_OK).
// SELinux denies X_OK on app_data_file, so downgrade to R_OK for embedded
// binaries. Executability is handled by linker64 at runtime.
var _accessSync = fs.accessSync;
fs.accessSync = function(p, mode) {
    if (isEmbeddedBinary(p) && mode !== undefined && (mode & fs.constants.X_OK)) {
        return _accessSync.call(this, p, fs.constants.R_OK);
    }
    return _accessSync.apply(this, arguments);
};

// --- child_process patches ---
// Route all exec/spawn calls for embedded binaries through linker64.

var _execFileSync = child_process.execFileSync;
child_process.execFileSync = function(file) {
    if (isEmbeddedBinary(file)) {
        var args = arguments.length > 1 && Array.isArray(arguments[1]) ? arguments[1] : [];
        var opts = arguments.length > 1 && Array.isArray(arguments[1]) ? arguments[2] : arguments[1];
        return _execFileSync.call(this, LINKER64, [file].concat(args), opts);
    }
    return _execFileSync.apply(this, arguments);
};

var _execFile = child_process.execFile;
child_process.execFile = function(file) {
    if (isEmbeddedBinary(file)) {
        var rest = Array.prototype.slice.call(arguments, 1);
        var args = rest.length > 0 && Array.isArray(rest[0]) ? rest[0] : [];
        var remaining = rest.length > 0 && Array.isArray(rest[0]) ? rest.slice(1) : rest;
        return _execFile.apply(this, [LINKER64, [file].concat(args)].concat(remaining));
    }
    return _execFile.apply(this, arguments);
};

var _spawn = child_process.spawn;
child_process.spawn = function(command, args, options) {
    if (isEmbeddedBinary(command)) {
        var actualArgs = Array.isArray(args) ? args : [];
        var actualOpts = Array.isArray(args) ? options : args;
        return _spawn.call(this, LINKER64, [command].concat(actualArgs), actualOpts);
    }
    return _spawn.call(this, command, args, options);
};

var _spawnSync = child_process.spawnSync;
child_process.spawnSync = function(command, args, options) {
    if (isEmbeddedBinary(command)) {
        var actualArgs = Array.isArray(args) ? args : [];
        var actualOpts = Array.isArray(args) ? options : args;
        return _spawnSync.call(this, LINKER64, [command].concat(actualArgs), actualOpts);
    }
    return _spawnSync.call(this, command, args, options);
};

// --- Launch Claude Code ---
var cliPath = process.argv[2];
if (!cliPath) {
    process.stderr.write('claude-wrapper: missing CLI path argument\n');
    process.exit(1);
}

// Fix argv so Claude Code sees: ["node", "cli.js", ...rest]
process.argv = [process.argv[0], cliPath].concat(process.argv.slice(3));

require(cliPath);
