package com.destin.code.config

data class QuickChip(
    val label: String,
    val prompt: String,
    val needsCompletion: Boolean = false,
)

val defaultChips = listOf(
    QuickChip("Journal", "let's journal"),
    QuickChip("Inbox", "check my inbox"),
    QuickChip("Briefing", "brief me on ", needsCompletion = true),
    QuickChip("Draft Text", "help me draft a text to ", needsCompletion = true),
)
