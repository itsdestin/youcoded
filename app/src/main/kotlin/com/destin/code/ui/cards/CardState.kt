package com.destin.code.ui.cards

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

class CardStateManager {
    var expandedCardId: String? by mutableStateOf(null)
        private set

    fun toggle(cardId: String) {
        expandedCardId = if (expandedCardId == cardId) null else cardId
    }
}
