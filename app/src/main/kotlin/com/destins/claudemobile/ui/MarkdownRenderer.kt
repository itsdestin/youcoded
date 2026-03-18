package com.destins.claudemobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.ui.cards.CodeCard
import com.destins.claudemobile.ui.theme.CascadiaMono
import org.commonmark.node.*
import org.commonmark.parser.Parser

private val URL_PATTERN = Regex("""https?://[^\s)>\]"'`]+""")
private val LINK_COLOR = Color(0xFF66AAFF)
private val INLINE_CODE_BG = Color(0xFF222222)
private val INLINE_CODE_COLOR = Color(0xFFc96442)
private val BLOCKQUOTE_BORDER = Color(0xFFc96442)
private val BLOCKQUOTE_TEXT = Color(0xFF999999)
private val HR_COLOR = Color(0xFF333333)

@Composable
fun MarkdownRenderer(
    markdown: String,
    textColor: Color = MaterialTheme.colorScheme.onSurface,
    expandedCardId: String? = null,
    onToggleCard: (String) -> Unit = {},
) {
    val parser = remember { Parser.builder().build() }
    val document = remember(markdown) { parser.parse(markdown) }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        var node = document.firstChild
        var blockIndex = 0
        while (node != null) {
            RenderBlock(node, textColor, blockIndex++, expandedCardId, onToggleCard)
            node = node.next
        }
    }
}

@Composable
private fun RenderBlock(
    node: Node,
    textColor: Color,
    blockIndex: Int,
    expandedCardId: String?,
    onToggleCard: (String) -> Unit,
) {
    when (node) {
        is org.commonmark.node.Paragraph -> {
            RenderInlineContent(node, textColor)
        }
        is Heading -> {
            val fontSize = when (node.level) {
                1 -> 18.sp
                2 -> 16.sp
                else -> 14.sp
            }
            val annotated = buildInlineAnnotatedString(node, textColor)
            Text(
                text = annotated,
                fontSize = fontSize,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(top = 4.dp, bottom = 2.dp),
            )
        }
        is FencedCodeBlock -> {
            val lang = node.info?.takeIf { it.isNotBlank() } ?: ""
            val code = node.literal.trimEnd('\n')
            val cardId = "code_${blockIndex}"
            CodeCard(
                cardId = cardId,
                language = lang,
                code = code,
                isExpanded = expandedCardId == cardId,
                onToggle = onToggleCard,
            )
        }
        is IndentedCodeBlock -> {
            val code = node.literal.trimEnd('\n')
            val cardId = "code_${blockIndex}"
            CodeCard(
                cardId = cardId,
                language = "",
                code = code,
                isExpanded = expandedCardId == cardId,
                onToggle = onToggleCard,
            )
        }
        is BlockQuote -> {
            val borderColor = BLOCKQUOTE_BORDER
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .drawBehind {
                        drawLine(
                            color = borderColor,
                            start = Offset(0f, 0f),
                            end = Offset(0f, size.height),
                            strokeWidth = 2.dp.toPx(),
                        )
                    }
                    .padding(start = 12.dp),
            ) {
                Column {
                    var child = node.firstChild
                    var childIdx = 0
                    while (child != null) {
                        RenderBlock(child, BLOCKQUOTE_TEXT, blockIndex * 100 + childIdx++, expandedCardId, onToggleCard)
                        child = child.next
                    }
                }
            }
        }
        is BulletList -> {
            Column(modifier = Modifier.padding(start = 8.dp)) {
                var item = node.firstChild
                var childIdx = 0
                while (item != null) {
                    if (item is ListItem) {
                        Row(modifier = Modifier.padding(vertical = 1.dp)) {
                            Text("•  ", color = textColor, fontSize = 14.sp)
                            Column(modifier = Modifier.weight(1f)) {
                                var child = item.firstChild
                                while (child != null) {
                                    RenderBlock(child, textColor, blockIndex * 100 + childIdx++, expandedCardId, onToggleCard)
                                    child = child.next
                                }
                            }
                        }
                    }
                    item = item.next
                }
            }
        }
        is OrderedList -> {
            Column(modifier = Modifier.padding(start = 8.dp)) {
                var index = node.startNumber
                var item = node.firstChild
                var childIdx = 0
                while (item != null) {
                    if (item is ListItem) {
                        Row(modifier = Modifier.padding(vertical = 1.dp)) {
                            Text("$index. ", color = textColor, fontSize = 14.sp)
                            Column(modifier = Modifier.weight(1f)) {
                                var child = item.firstChild
                                while (child != null) {
                                    RenderBlock(child, textColor, blockIndex * 100 + childIdx++, expandedCardId, onToggleCard)
                                    child = child.next
                                }
                            }
                        }
                    }
                    index++
                    item = item.next
                }
            }
        }
        is ThematicBreak -> {
            HorizontalDivider(
                color = HR_COLOR,
                thickness = 1.dp,
                modifier = Modifier.padding(vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun RenderInlineContent(node: Node, textColor: Color) {
    val annotated = buildInlineAnnotatedString(node, textColor)
    Text(text = annotated, style = MaterialTheme.typography.bodyMedium)
}

private val LINK_STYLES = TextLinkStyles(
    style = SpanStyle(color = LINK_COLOR, textDecoration = TextDecoration.Underline),
)

private fun buildInlineAnnotatedString(
    node: Node,
    textColor: Color,
): AnnotatedString = buildAnnotatedString {
    appendInlineChildren(node, textColor, isBold = false, isItalic = false)
    val text = toAnnotatedString()
    // Collect ranges already linked by markdown [text](url) syntax
    val linkedRanges = text.getLinkAnnotations(0, text.length)
    val urlMatches = URL_PATTERN.findAll(text.text)
    for (match in urlMatches) {
        val url = match.value.trimEnd('.', ',', ';', ':', '!')
        val end = match.range.first + url.length
        val alreadyLinked = linkedRanges.any { ann ->
            match.range.first >= ann.start && match.range.first < ann.end
        }
        if (!alreadyLinked) {
            addLink(LinkAnnotation.Url(url, LINK_STYLES), match.range.first, end)
        }
    }
}

private fun AnnotatedString.Builder.appendInlineChildren(
    node: Node,
    textColor: Color,
    isBold: Boolean,
    isItalic: Boolean,
) {
    var child = node.firstChild
    while (child != null) {
        when (child) {
            is org.commonmark.node.Text -> {
                val style = SpanStyle(
                    color = textColor,
                    fontWeight = if (isBold) FontWeight.Bold else null,
                    fontStyle = if (isItalic) FontStyle.Italic else null,
                )
                withStyle(style) { append(child.literal) }
            }
            is SoftLineBreak -> append(" ")
            is HardLineBreak -> append("\n")
            is Code -> {
                withStyle(SpanStyle(
                    color = INLINE_CODE_COLOR,
                    background = INLINE_CODE_BG,
                    fontFamily = CascadiaMono,
                )) { append(child.literal) }
            }
            is Emphasis -> {
                appendInlineChildren(child, textColor, isBold, isItalic = true)
            }
            is StrongEmphasis -> {
                appendInlineChildren(child, textColor, isBold = true, isItalic)
            }
            is Link -> {
                val linkUrl = (child as Link).destination
                val start = this.length
                appendInlineChildren(child, LINK_COLOR, isBold, isItalic)
                val end = this.length
                addLink(LinkAnnotation.Url(linkUrl, LINK_STYLES), start, end)
            }
            else -> {
                appendInlineChildren(child, textColor, isBold, isItalic)
            }
        }
        child = child.next
    }
}
