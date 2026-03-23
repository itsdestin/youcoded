package com.destin.code.config

/**
 * Package installation tiers. Each tier includes all packages from lower tiers.
 * Tier names and descriptions are user-facing (shown in tier picker).
 */
enum class PackageTier(
    val displayName: String,
    val description: String,
    val additionalPackages: List<String>,
) {
    CORE(
        displayName = "Core",
        description = "Claude Code essentials — git, python, curl, rclone, ripgrep",
        additionalPackages = emptyList(),
    ),
    DEVELOPER(
        displayName = "Developer Essentials",
        description = "fd, fzf, jq, bat, tmux, nano, micro",
        additionalPackages = listOf(
            "fd", "micro", "tree",
            // ripgrep + oniguruma moved to corePackages (Claude Code Grep/Glob depend on rg)
            "findutils", "ncurses-utils", "fzf",
            "jq",
            "libgit2", "bat", "eza",
            "libevent", "libandroid-glob", "tmux",
            "nano",
        ),
    ),
    FULL_DEV(
        displayName = "Full Dev Environment",
        description = "neovim, vim, make, cmake, sqlite",
        additionalPackages = listOf(
            "libsodium", "vim",
            "libmsgpack", "libunibilium", "libuv", "libvterm",
            "lua51", "lua51-lpeg", "luajit", "luv",
            "tree-sitter",
            "tree-sitter-c", "tree-sitter-lua", "tree-sitter-markdown",
            "tree-sitter-query", "tree-sitter-vimdoc", "tree-sitter-vim",
            "tree-sitter-parsers", "utf8proc", "neovim",
            "make",
            "libxml2", "libarchive", "jsoncpp", "rhash", "cmake",
            "sqlite",
        ),
    );

    /** Returns all packages for this tier (cumulative — includes lower tiers). */
    fun allAdditionalPackages(): List<String> {
        val result = mutableListOf<String>()
        for (tier in entries) {
            result.addAll(tier.additionalPackages)
            if (tier == this) break
        }
        return result
    }
}
