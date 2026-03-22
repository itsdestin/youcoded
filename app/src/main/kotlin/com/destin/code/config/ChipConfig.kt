package com.destin.code.config

data class QuickChip(
    val label: String,
    val prompt: String,
    val needsCompletion: Boolean = false,
)

val personalChips = listOf(
    QuickChip("Journal", "let's journal"),
    QuickChip("Inbox", "check my inbox"),
    QuickChip("Briefing", "brief me on ", needsCompletion = true),
    QuickChip("Draft Text", "help me draft a text to ", needsCompletion = true),
)

val developerChips = listOf(
    QuickChip("Git Status", "run git status and summarize what's changed"),
    QuickChip("Review PR", "review the latest PR on this repo"),
    QuickChip("Fix Tests", "run the tests and fix any failures"),
    QuickChip("Explain", "explain this error: ", needsCompletion = true),
)

fun chipsForTier(tier: PackageTier): List<QuickChip> {
    return when (tier) {
        PackageTier.CORE -> personalChips
        PackageTier.DEVELOPER, PackageTier.FULL_DEV -> developerChips + personalChips
    }
}
