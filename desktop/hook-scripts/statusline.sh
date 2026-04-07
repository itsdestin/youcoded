#!/usr/bin/env bash
# Claude Code status line script
# Line 1: Session name (bold, if named)
# Line 2: Sync status (from .sync-status file)
# Line 3: Model + context remaining
# Line 4: Rate limit info (from usage-fetch.js)
# Line 5: Toolkit version + announcement (if active)

# Source shared infrastructure (trap handlers, error capture, rotation)
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$HOOK_DIR/lib/hook-preamble.sh" ]] && source "$HOOK_DIR/lib/hook-preamble.sh"

STATUS_FILE="$HOME/.claude/.sync-status"

# Read session JSON from stdin and extract fields
SESSION=$(cat)

STATUSLINE_LOG="$HOME/.claude/statusline.log"
PARSED=$(echo "$SESSION" | node -e "
const SEP='\x1f';
let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
  try{const j=JSON.parse(d);
    const name=j.session_name||'';
    const sid=j.session_id||'';
    const m=j.model?.display_name||j.model?.id||'unknown';
    const rem=j.context_window?.remaining_percentage!=null?Math.round(j.context_window.remaining_percentage):100;
    console.log(name+SEP+m+SEP+rem+SEP+sid);
  }catch(e){console.error('statusline parse error: '+e.message);console.log(SEP+'unknown'+SEP+'100'+SEP)}
})" 2>>"$STATUSLINE_LOG")

IFS=$(printf '\037') read -r SESSION_NAME MODEL REMAINING SESSION_ID <<< "$PARSED"

# Defaults if node failed
MODEL=${MODEL:-unknown}
REMAINING=${REMAINING:-100}

# Persist context remaining for desktop app status bar
[[ -n "$SESSION_ID" ]] && printf '%s' "$REMAINING" > "$HOME/.claude/.context-${SESSION_ID}" 2>/dev/null

# Fall back to topic file if session_name is empty, default to "New Session"
if [[ -z "$SESSION_NAME" && -n "$SESSION_ID" ]]; then
    TOPIC_FILE="$HOME/.claude/topics/topic-${SESSION_ID}"
    if [[ -n "$TOPIC_FILE" && -f "$TOPIC_FILE" ]]; then
        SESSION_NAME=$(cat "$TOPIC_FILE" 2>/dev/null | tr -d '\n\r')
    fi
    SESSION_NAME="${SESSION_NAME:-New Session}"
fi

# ANSI colors (single-quoted for printf %b compatibility)
BOLD='\033[1m'
WHITE='\033[97m'
GREEN='\033[92m'
YELLOW='\033[33m'
RED='\033[31m'
DIM='\033[90m'
RESET='\033[0m'

# --- Git repo/branch detection ---
GIT_INFO=""
if command -v git &>/dev/null; then
    _BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || _BRANCH=""
    if [[ -n "$_BRANCH" ]]; then
        _REPO=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null) || _REPO=""
        if [[ -n "$_REPO" ]]; then
            GIT_INFO="${_REPO}/${_BRANCH}"
        else
            GIT_INFO="${_BRANCH}"
        fi
    fi
fi

# --- Sync status (computed first) ---
SYNC=""
if [ -f "$STATUS_FILE" ]; then
    SYNC=$(cat "$STATUS_FILE" 2>/dev/null)
fi

if [[ "$SYNC" == OK:* ]] || [[ "$SYNC" == "Changes Synced"* ]]; then
    SYNC_DISPLAY="${GREEN}${SYNC}${RESET}"
elif [[ "$SYNC" == WARN:* ]]; then
    SYNC_DISPLAY="${YELLOW}${SYNC}${RESET}"
elif [[ "$SYNC" == ERR:* ]]; then
    SYNC_DISPLAY="${RED}${SYNC}${RESET}"
else
    SYNC_DISPLAY="${DIM}No Sync Status${RESET}"
fi

# --- Sync warnings (from session-start health check) ---
WARNINGS_FILE="$HOME/.claude/.sync-warnings"
WARN_PARTS=""
if [[ -f "$WARNINGS_FILE" ]]; then
    _SEP_D="${RESET} | ${RED}"
    _SEP_W="${RESET} | ${YELLOW}"
    while IFS= read -r _LINE; do
        case "$_LINE" in
            OFFLINE) WARN_PARTS="${WARN_PARTS:+$WARN_PARTS${_SEP_D}}${RED}DANGER: No Internet Connection${RESET}" ;;
            PERSONAL:NOT_CONFIGURED) WARN_PARTS="${WARN_PARTS:+$WARN_PARTS${_SEP_D}}${RED}DANGER: No Sync Act. for Personal Data${RESET}" ;;
            PERSONAL:STALE) WARN_PARTS="${WARN_PARTS:+$WARN_PARTS${_SEP_W}}${YELLOW}WARN: No Recent Personal Sync (>24h)${RESET}" ;;
            SKILLS:*) WARN_PARTS="${WARN_PARTS:+$WARN_PARTS${_SEP_D}}${RED}DANGER: Unsynced Skills${RESET}" ;;
            PROJECTS:*) WARN_PARTS="${WARN_PARTS:+$WARN_PARTS${_SEP_D}}${RED}DANGER: Projects Excluded From Sync${RESET}" ;;
            GIT:PULL_FAILED) WARN_PARTS="${WARN_PARTS:+$WARN_PARTS${_SEP_W}}${YELLOW}WARN: Git Pull Failed${RESET}" ;;
            GIT:NOT_INITIALIZED) WARN_PARTS="${WARN_PARTS:+$WARN_PARTS${_SEP_W}}${YELLOW}WARN: Git Not Initialized${RESET}" ;;
            PERSONAL:PULL_FAILED:*) WARN_PARTS="${WARN_PARTS:+$WARN_PARTS${_SEP_W}}${YELLOW}WARN: Personal Pull Failed (${_LINE##*:})${RESET}" ;;
            MIGRATION:FAILED) WARN_PARTS="${WARN_PARTS:+$WARN_PARTS${_SEP_D}}${RED}DANGER: Migration Failed${RESET}" ;;
        esac
    done < "$WARNINGS_FILE"
fi

# Append warnings + /sync hint to sync display
if [[ -n "$WARN_PARTS" ]]; then
    SYNC_DISPLAY="${SYNC_DISPLAY}  |  ${WARN_PARTS}  ${DIM}/sync for info${RESET}"
fi

# --- Lines 1-2: Session name / sync status ---
if [[ -n "$SESSION_NAME" ]]; then
    printf '%b\n' "${BOLD}${WHITE}${SESSION_NAME}${RESET}"
    printf '%b\n' "$SYNC_DISPLAY"
else
    printf '%b\n' "$SYNC_DISPLAY"
fi

# --- Line 3: Model + Context Remaining ---
if [ "$REMAINING" -lt 20 ] 2>/dev/null; then
    CTX_COLOR="$RED"
elif [ "$REMAINING" -lt 50 ] 2>/dev/null; then
    CTX_COLOR="$YELLOW"
else
    CTX_COLOR="$GREEN"
fi

MODEL_LINE="${DIM}${MODEL}${RESET}"
CYAN='\033[36m'
[[ -n "$GIT_INFO" ]] && MODEL_LINE="${MODEL_LINE}  ${DIM}|${RESET}  ${CYAN}{${GIT_INFO}}${RESET}"
MODEL_LINE="${MODEL_LINE}  ${DIM}|${RESET}  ${CTX_COLOR}Context Remaining: ${REMAINING}%${RESET}"
printf '%b\n' "$MODEL_LINE"

# --- Line 4: Rate limit info (via usage-fetch.js) ---
# Find hooks directory: config-based lookup (works with copies on Windows), symlink fallback
# Check config.local.json first (machine-specific), then config.json (portable) — Design ref: D1
HOOKS_DIR=""
_TK=""
if command -v node &>/dev/null; then
    for _cfg in "$HOME/.claude/toolkit-state/config.local.json" "$HOME/.claude/toolkit-state/config.json"; do
        [[ ! -f "$_cfg" ]] && continue
        _TK=$(node -e "try{const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));if(c.toolkit_root)console.log(c.toolkit_root)}catch{}" "$_cfg" 2>/dev/null)
        [[ -n "$_TK" ]] && break
    done
fi
[[ -n "$_TK" && -d "$_TK/core/hooks" ]] && HOOKS_DIR="$_TK/core/hooks"
if [[ -z "$HOOKS_DIR" ]]; then
    _REAL="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || realpath "${BASH_SOURCE[0]}" 2>/dev/null || python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
    HOOKS_DIR="$(dirname "$_REAL")"
fi
USAGE_FETCH="$HOOKS_DIR/usage-fetch.js"

if [[ -f "$USAGE_FETCH" ]] && command -v node &>/dev/null; then
    USAGE_JSON=$(node "$USAGE_FETCH" 2>>"$STATUSLINE_LOG") || USAGE_JSON=""
    if [[ -n "$USAGE_JSON" ]]; then
        # Each timer gets its own ANSI color based on its own utilization percentage
        USAGE_LINE=$(node -e "
            const d = JSON.parse(process.argv[1]);
            const fiveH = d.five_hour;
            const sevenD = d.seven_day;
            const GREEN = '\x1b[92m';
            const DIM = '\x1b[90m';
            const YELLOW = '\x1b[33m';
            const RED = '\x1b[31m';
            const RESET = '\x1b[0m';

            function colorFor(pct) {
                if (pct >= 80) return RED;
                if (pct >= 50) return YELLOW;
                return GREEN;
            }

            const parts = [];

            if (fiveH && fiveH.utilization != null) {
                const pct = fiveH.utilization;
                const c = colorFor(pct);
                const resetsAt = new Date(fiveH.resets_at);
                const timeStr = resetsAt.toLocaleTimeString('en-US', {
                    hour: 'numeric', minute: '2-digit', hour12: true
                });
                parts.push(c + '5h (' + pct + '%): Resets at ' + timeStr + RESET);
            }

            if (sevenD && sevenD.utilization != null) {
                const pct = sevenD.utilization;
                const c = colorFor(pct);
                const resetsAt = new Date(sevenD.resets_at);
                const dayStr = resetsAt.toLocaleDateString('en-US', { weekday: 'long' });
                const timeStr = resetsAt.toLocaleTimeString('en-US', {
                    hour: 'numeric', minute: '2-digit', hour12: true
                });
                parts.push(c + '7d (' + pct + '%): Resets on ' + dayStr + ' at ' + timeStr + RESET);
            }

            if (parts.length > 0) {
                process.stdout.write(parts.join(RESET + ' | ' + RESET));
            }
        " "$USAGE_JSON" 2>/dev/null) || USAGE_LINE=""

        if [[ -n "$USAGE_LINE" ]]; then
            printf '%b\n' "$USAGE_LINE"
        fi
    fi
fi

# --- Line 5: Toolkit version + announcement ---
CACHE_FILE="$HOME/.claude/.announcement-cache.json"
ANNOUNCEMENT_FRAGMENT=""
if [[ -f "$CACHE_FILE" ]] && command -v node &>/dev/null; then
    ANNOUNCEMENT_FRAGMENT=$(node -e "
const fs = require('fs');
try {
    const cache = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    if (!cache.message) process.exit(0);
    const STALE_MS = 7 * 24 * 60 * 60 * 1000;
    if ((Date.now() - new Date(cache.fetched_at).getTime()) >= STALE_MS) process.exit(0);
    const d = new Date();
    const today = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    if (cache.expires && cache.expires < today) process.exit(0);
    process.stdout.write('| \x1b[1;33m\u2605 ' + cache.message + '\x1b[0m');
} catch (_) {}
" "$CACHE_FILE" 2>/dev/null) || ANNOUNCEMENT_FRAGMENT=""
fi

UPDATE_FILE="$HOME/.claude/toolkit-state/update-status.json"
if [[ -f "$UPDATE_FILE" ]] && command -v node &>/dev/null; then
    TOOLKIT_INFO=$(node -e "
        const fs = require('fs');
        try {
            const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
            const ver = s.current || 'unknown';
            console.log(ver + '\t' + (s.update_available ? '1' : '0'));
        } catch { console.log('unknown\t0'); }
    " "$UPDATE_FILE" 2>/dev/null) || TOOLKIT_INFO=""
    if [[ -n "$TOOLKIT_INFO" ]]; then
        IFS=$'\t' read -r TK_VER TK_UPD <<< "$TOOLKIT_INFO"
        if [[ "$TK_UPD" == "1" ]]; then
            printf '%b' "${YELLOW}DestinClaude v${TK_VER} (Update Available)${RESET}  | ${DIM}Run /update${RESET}  "
        else
            printf '%b' "${DIM}DestinClaude v${TK_VER}${RESET}  "
        fi
        # Announcement fragment contains raw ANSI bytes from node — use %s
        # (literal string) not %b (escape-interpreting) to avoid reinterpretation
        printf '%s\n' "$ANNOUNCEMENT_FRAGMENT"
    fi
fi
