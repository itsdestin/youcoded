#!/usr/bin/env bash
# Claude Code status line script
# Line 1: Session name (bold, if named)
# Line 2: Sync status (from .sync-status file)
# Line 3: Model + context remaining
# Line 4: Rate limit info (from Claude Code's own rate_limits stdin payload)
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
const fs=require('fs');
const path=require('path');
let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
  try{const j=JSON.parse(d);
    const name=j.session_name||'';
    const sid=j.session_id||'';
    const m=j.model?.display_name||j.model?.id||'unknown';
    const rem=j.context_window?.remaining_percentage!=null?Math.round(j.context_window.remaining_percentage):100;
    const home=process.env.HOME||process.env.USERPROFILE||'';
    // --- Rate limits: Line 4 + ~/.claude/.usage-cache.json ---
    // Legal: Anthropic forbids third-party apps from collecting or using the
    // Claude.ai OAuth token (code.claude.com/docs/en/legal-and-compliance), so
    // the old usage-fetch.js call to api.anthropic.com/api/oauth/usage is gone.
    // Claude Code itself hands this script the same figures as rate_limits
    // (CC >= 2.1.80, docs: code.claude.com/docs/en/statusline#rate-limit-usage):
    //   rate_limits.<five_hour|seven_day>.used_percentage  0-100
    //   rate_limits.<five_hour|seven_day>.resets_at        Unix epoch SECONDS
    // It appears only for Pro/Max logins and only after the first API reply of a
    // session; each window may be absent on its own, and CC drops a window once
    // its reset time has passed. The cache keeps the shape every reader already
    // parses — {five_hour:{utilization, resets_at: ISO string}, seven_day:{...}}
    // (ipc-handlers buildStatusData, StatusBar chips, UsageCard, Android
    // SessionService) — so nothing downstream had to change.
    let usage=null;
    const cachePath=home?path.join(home,'.claude','.usage-cache.json'):'';
    try{
      const rl=j.rate_limits;
      if(rl&&typeof rl==='object'){
        usage={};
        for(const w of ['five_hour','seven_day']){
          const src=rl[w];
          if(!src||src.used_percentage==null)continue;
          const win={utilization:Math.round(src.used_percentage)};
          const n=Number(src.resets_at);
          // Seconds per the docs; a value already in milliseconds is left alone.
          if(Number.isFinite(n)&&n>0)win.resets_at=new Date(n>1e11?n:n*1000).toISOString();
          usage[w]=win;
        }
        if(cachePath){try{fs.writeFileSync(cachePath,JSON.stringify(usage))}catch(_){}}
      }else if(cachePath&&fs.existsSync(cachePath)){
        // No rate_limits yet (before the first reply, or not a Pro/Max login):
        // keep showing the last known figures, but drop any window whose reset
        // time has passed so yesterday's exhausted bar never reads as today's.
        // Nothing refreshes this file between sessions any more, so this is the
        // only place stale windows get cleared.
        const old=JSON.parse(fs.readFileSync(cachePath,'utf8'));
        usage={};let pruned=false;
        for(const w of ['five_hour','seven_day']){
          const win=old&&old[w];
          if(!win||win.utilization==null)continue;
          const t=win.resets_at?Date.parse(win.resets_at):NaN;
          if(Number.isFinite(t)&&t<=Date.now()){pruned=true;continue}
          usage[w]=win;
        }
        if(pruned){try{fs.writeFileSync(cachePath,JSON.stringify(usage))}catch(_){}}
      }
    }catch(_){usage=null}
    // Render Line 4 exactly as before: each window coloured by its own
    // percentage (green <50, yellow <80, red >=80), 12-hour reset times.
    let usageLine='';
    if(usage){
      const GREEN='\x1b[92m',YELLOW='\x1b[33m',RED='\x1b[31m',RESET='\x1b[0m';
      const colorFor=p=>p>=80?RED:p>=50?YELLOW:GREEN;
      const tfmt={hour:'numeric',minute:'2-digit',hour12:true};
      const parts=[];
      const f=usage.five_hour;
      if(f&&f.utilization!=null){
        const r=f.resets_at?new Date(f.resets_at):null;
        const when=r&&!isNaN(r)?': Resets at '+r.toLocaleTimeString('en-US',tfmt):'';
        parts.push(colorFor(f.utilization)+'5h ('+f.utilization+'%)'+when+RESET);
      }
      const sv=usage.seven_day;
      if(sv&&sv.utilization!=null){
        const r=sv.resets_at?new Date(sv.resets_at):null;
        const when=r&&!isNaN(r)?': Resets on '+r.toLocaleDateString('en-US',{weekday:'long'})+' at '+r.toLocaleTimeString('en-US',tfmt):'';
        parts.push(colorFor(sv.utilization)+'7d ('+sv.utilization+'%)'+when+RESET);
      }
      usageLine=parts.join(RESET+' | '+RESET);
    }
    console.log(name+SEP+m+SEP+rem+SEP+sid+SEP+usageLine);
    // Write session stats JSON for desktop/Android status bar widgets
    // Field mapping from Claude Code's actual status line JSON structure:
    //   cost.total_cost_usd, cost.total_duration_ms, cost.total_api_duration_ms,
    //   cost.total_lines_added, cost.total_lines_removed,
    //   context_window.total_input_tokens, context_window.total_output_tokens,
    //   context_window.current_usage.cache_read_input_tokens,
    //   context_window.current_usage.cache_creation_input_tokens,
    //   context_window.context_window_size
    //
    // WHAT THESE ACTUALLY MEAN (read out of the shipped CLI binary, v2.1.259,
    // 2026-09-03 — the `context_window` object is built by one function):
    //   total_input_tokens = input + cache_creation + cache_read of the CURRENT
    //                        request. It is the WHOLE prompt, cached part
    //                        INCLUDED — NOT Anthropic's raw `input_tokens`,
    //                        which is only the uncached remainder. Anything
    //                        that adds the cache reads back on top of this
    //                        counts them twice; that is exactly how the status
    //                        bar's Reuse chip got stuck under 50% (fixed in
    //                        renderer/state/cache-reuse.ts).
    //   total_output_tokens = the CURRENT request's output_tokens. Not a
    //                        session total — a 42-hour session read 713 here.
    //   current_usage      = that same current request's raw usage object, so
    //                        the cache numbers below share its scope.
    // Nothing under `context_window` accumulates across a session; only the
    // `cost.*` fields do.
    if(sid){
      const c=j.cost||{};const cw=j.context_window||{};const cu=cw.current_usage||{};
      const stats={
        costUsd:c.total_cost_usd??null,
        inputTokens:cw.total_input_tokens??null,
        outputTokens:cw.total_output_tokens??null,
        cacheReadTokens:cu.cache_read_input_tokens??null,
        cacheCreationTokens:cu.cache_creation_input_tokens??null,
        contextTokens:cw.context_window_size??null,
        duration:c.total_duration_ms!=null?c.total_duration_ms/1000:null,
        apiDuration:c.total_api_duration_ms!=null?c.total_api_duration_ms/1000:null,
        linesAdded:c.total_lines_added??null,
        linesRemoved:c.total_lines_removed??null,
      };
      if(home){
        const p=path.join(home,'.claude','.session-stats-'+sid+'.json');
        try{fs.writeFileSync(p,JSON.stringify(stats))}catch(_){}
      }
    }
  }catch(e){console.error('statusline parse error: '+e.message);console.log(SEP+'unknown'+SEP+'100'+SEP)}
})" 2>>"$STATUSLINE_LOG")

IFS=$(printf '\037') read -r SESSION_NAME MODEL REMAINING SESSION_ID USAGE_LINE <<< "$PARSED"

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

# Persist git branch for desktop app status bar (chat view widget)
[[ -n "$SESSION_ID" ]] && printf '%s' "$GIT_INFO" > "$HOME/.claude/.gitbranch-${SESSION_ID}" 2>/dev/null

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

# --- Line 4: Rate limit info (from Claude Code's rate_limits payload) ---
# Legal: this line used to shell out to usage-fetch.js, which read the user's
# Claude.ai OAuth token and called Anthropic's usage API — something Anthropic's
# Claude Code terms forbid third-party apps from doing. It is now rendered by the
# parser above straight from the stdin JSON; nothing here reads a token or
# touches the network. Empty until Claude Code sends rate_limits (after the
# first reply of a session, Pro/Max only) and no earlier figures are cached.
# USAGE_LINE carries raw ANSI bytes from node — %s, not %b, so they are not
# reinterpreted (same reason as the announcement fragment below).
if [[ -n "$USAGE_LINE" ]]; then
    printf '%s\n' "$USAGE_LINE"
fi

# --- Line 5: Announcement ---
# WHY announcement-only (2026-10-02): this line used to lead with the toolkit's
# version from toolkit-state/update-status.json. Only the archived youcoded-core
# toolkit ever wrote that file, so on old installs it froze on "Update Available
# | Run /update" — a command that no longer exists — and on new installs the
# announcement never showed at all, because it was printed inside that branch.
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
    process.stdout.write('\x1b[1;33m\u2605 ' + cache.message + '\x1b[0m');
} catch (_) {}
" "$CACHE_FILE" 2>/dev/null) || ANNOUNCEMENT_FRAGMENT=""
fi

if [[ -n "$ANNOUNCEMENT_FRAGMENT" ]]; then
    # Announcement fragment contains raw ANSI bytes from node — use %s
    # (literal string) not %b (escape-interpreting) to avoid reinterpretation
    printf '%s\n' "$ANNOUNCEMENT_FRAGMENT"
fi
