#!/bin/bash
# PostToolUse hook: asks Claude to name the conversation, WHEN THE APP ASKS.
# App-owned — always deployed by YouCoded's install-hooks.js.
#
# The app owns naming policy (desktop/src/main/session-namer.ts). This script
# used to decide for itself on a 120s/600s timer, which cost about six title
# requests per conversation — 277 wasted round trips across 46 sessions in the
# 2026-08-28 study. It now asks only when it finds an ask-file the app wrote at
# a scheduled review (completed replies 1, 3, then every 25), and never at all
# unless naming is set to AI.
#
# TWO gate files, both written by the app, both cheap to read:
#   $TOPIC_DIR/naming-mode   one word: off | basic | ai
#   $TOPIC_DIR/ask-<id>      exists = the app wants a name for this session now
#
# A MISSING mode file falls back to the old timer. That is not laziness: this
# same script ships to Android, whose runtime does not write these files yet,
# and a hook that goes silent there would stop naming conversations on the
# phone altogether. Desktop writes the mode file at startup and on every
# settings change, so it always takes the scheduled path.

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).session_id||'')}catch{console.log('')}})" 2>/dev/null)

if [ -z "$SESSION_ID" ]; then
    exit 0
fi

TOPIC_DIR="$HOME/.claude/topics"
mkdir -p "$TOPIC_DIR"

# Prune topic files older than 30 days (matches conversation-index.json
# retention, so a session's name survives as long as its index entry).
# Runs at most once per day.
PRUNE_MARKER="$TOPIC_DIR/.prune-marker"
NOW=$(date +%s)
DO_PRUNE=false
if [ ! -f "$PRUNE_MARKER" ]; then
    DO_PRUNE=true
else
    LAST_PRUNE=$(head -1 "$PRUNE_MARKER" 2>/dev/null)
    [[ ! "$LAST_PRUNE" =~ ^[0-9]+$ ]] && LAST_PRUNE=0
    if [ $((NOW - ${LAST_PRUNE:-0})) -ge 86400 ]; then
        DO_PRUNE=true
    fi
fi
if [ "$DO_PRUNE" = true ]; then
    find "$TOPIC_DIR" -name "topic-*" -mtime +30 -delete 2>/dev/null
    find "$TOPIC_DIR" -name "marker-*" -mtime +30 -delete 2>/dev/null
    # Asks the app made for a session that never ran another tool call.
    find "$TOPIC_DIR" -name "ask-*" -mtime +30 -delete 2>/dev/null
    echo "$NOW" > "$PRUNE_MARKER"
fi

TOPIC_FILE="$TOPIC_DIR/topic-$SESSION_ID"
ASK_FILE="$TOPIC_DIR/ask-$SESSION_ID"

CURRENT_TOPIC=""
[ -f "$TOPIC_FILE" ] && CURRENT_TOPIC=$(head -1 "$TOPIC_FILE" 2>/dev/null)

MODE=$(head -1 "$TOPIC_DIR/naming-mode" 2>/dev/null)
if [ -n "$MODE" ]; then
    # Off and Basic must not merely discard the result: by the time a title
    # comes back the model has already been interrupted and asked to write one,
    # which is the whole cost this gate removes.
    [ "$MODE" = "ai" ] || exit 0
    # AI naming, but this reply is not one of the scheduled reviews.
    [ -f "$ASK_FILE" ] || exit 0
    # Consume the ask BEFORE emitting, so one review asks exactly once even
    # when several tool calls land inside the same reply.
    rm -f "$ASK_FILE"
else
    # No mode file — a runtime that does not schedule reviews (Android today).
    # Keep the original timer so conversations there still get named.
    MARKER="$TOPIC_DIR/marker-$SESSION_ID"
    if [ "$CURRENT_TOPIC" = "New Session" ] || [ -z "$CURRENT_TOPIC" ]; then
        INTERVAL=120
    else
        INTERVAL=600
    fi
    if [ -f "$MARKER" ]; then
        LAST=$(head -1 "$MARKER")
        ELAPSED=$((NOW - LAST))
        if [ "$ELAPSED" -lt "$INTERVAL" ]; then
            exit 0
        fi
    fi
    echo "$NOW" > "$MARKER"
fi

if [ ! -f "$TOPIC_FILE" ] || [ ! -s "$TOPIC_FILE" ]; then
    echo "New Session" > "$TOPIC_FILE"
fi

if [ -z "$CURRENT_TOPIC" ] || [ "$CURRENT_TOPIC" = "New Session" ]; then
    MSG="[Auto-Title] This conversation has no title yet. Run this Bash command NOW, before anything else: echo \"Topic Here\" > $TOPIC_FILE — replace Topic Here with a 3-5 word Title Case summary of this conversation. Do NOT skip this."
else
    MSG="[Auto-Title] This conversation is titled \"$CURRENT_TOPIC\". If that still describes it, do nothing at all — no tool call, no mention of this reminder. ONLY if the conversation has since moved to a genuinely different topic, run: echo \"New Title\" > $TOPIC_FILE (3-5 words, Title Case)."
fi
ESCAPED=$(echo "$MSG" | sed 's/\\/\\\\/g; s/"/\\"/g')
echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"$ESCAPED\"}}"
