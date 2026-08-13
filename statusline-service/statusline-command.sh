#!/bin/sh
input=$(cat)

model=$(echo "$input" | jq -r '.model.display_name // "Claude"')
ctx=$(echo "$input" | jq -r '.context_window.remaining_percentage // empty')
fivehr=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
fivehr_resets=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')
weekly=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
weekly_resets=$(echo "$input" | jq -r '.rate_limits.seven_day.resets_at // empty')
dir=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty')

RESET=$(printf '\033[0m')
YELLOW=$(printf '\033[33m')
RED=$(printf '\033[31m')
GREEN=$(printf '\033[32m')
CYAN=$(printf '\033[36m')
MAGENTA=$(printf '\033[35m')
GRAY=$(printf '\033[90m')
ESC=$(printf '\033')

# Logged-in Claude account email (not in the statusline JSON; read from ~/.claude.json).
account=$(jq -r '.oauthAccount.emailAddress // empty' "$HOME/.claude.json" 2>/dev/null)

# Terminal width (Claude Code sets COLUMNS; fall back to 80 on older versions).
# Reserve a 2-column margin so a row never lands exactly at the edge.
COLS=$(( ${COLUMNS:-80} - 2 ))
[ "$COLS" -lt 18 ] 2>/dev/null && COLS=18

# Visible length of a string, ignoring ANSI color codes.
vlen() {
  s=$(printf '%s' "$1" | sed "s/${ESC}\[[0-9;]*m//g")
  printf '%s' "${#s}"
}

# Greedily pack newline-delimited segments (from stdin) into rows no wider than
# COLS, joined by the separator in $1. A segment wider than COLS goes on its own
# row. Emits one row per line.
pack() {
  sep="$1"
  seplen=${#sep}
  line=""; linelen=0
  while IFS= read -r seg; do
    [ -z "$seg" ] && continue
    slen=$(vlen "$seg")
    if [ -z "$line" ]; then
      line="$seg"; linelen=$slen
    elif [ $(( linelen + seplen + slen )) -le "$COLS" ]; then
      line="$line$sep$seg"; linelen=$(( linelen + seplen + slen ))
    else
      printf '%s\n' "$line"
      line="$seg"; linelen=$slen
    fi
  done
  [ -n "$line" ] && printf '%s\n' "$line"
}

# Color a "used %" value: red >=90, yellow >=70, plain otherwise.
color_used() {
  v=$1
  n=$(printf '%.0f' "$v")
  if [ "$n" -ge 90 ]; then printf '%s%s%%%s' "$RED" "$n" "$RESET"
  elif [ "$n" -ge 70 ]; then printf '%s%s%%%s' "$YELLOW" "$n" "$RESET"
  else printf '%s%%' "$n"
  fi
}

# Color a "remaining %" value (inverted: low remaining = bad).
color_remaining() {
  v=$1
  n=$(printf '%.0f' "$v")
  if [ "$n" -le 10 ]; then printf '%s%s%%%s' "$RED" "$n" "$RESET"
  elif [ "$n" -le 30 ]; then printf '%s%s%%%s' "$YELLOW" "$n" "$RESET"
  else printf '%s%%' "$n"
  fi
}

# Format seconds into "Xd" when >=1 day, otherwise "Xh".
fmt_duration_days() {
  secs=$1
  if [ "$secs" -le 0 ]; then
    printf 'now'
  elif [ "$secs" -ge 86400 ]; then
    printf '%dd' "$(( secs / 86400 ))"
  else
    printf '%dh' "$(( secs / 3600 ))"
  fi
}

# Format seconds into "Xh" when >=1 hour, otherwise "Xm" (or "now").
fmt_duration_hours() {
  secs=$1
  if [ "$secs" -le 0 ]; then
    printf 'now'
  elif [ "$secs" -lt 3600 ]; then
    printf '%dm' "$(( secs / 60 ))"
  else
    printf '%dh' "$(( secs / 3600 ))"
  fi
}

# $1234.56 -> "$1,234" (comma-grouped, no cents, signed).
fmt_money() {
  awk -v v="$1" 'BEGIN{
    v=v+0; s=(v<0)?"-":""; if(v<0)v=-v;
    n=sprintf("%.0f", v); x=n; out="";
    while(length(x)>3){ out=","substr(x,length(x)-2)out; x=substr(x,1,length(x)-3) }
    printf "%s$%s", s, x out
  }'
}
# 5000 -> "$5K", 20833 -> "$21K", 826459 -> "$826K"; <1000 stays "$NNN".
fmt_k() {
  awk -v v="$1" 'BEGIN{ v=v+0; if(v>=1000) printf "$%.0fK", v/1000; else printf "$%d", v }'
}
# 42.14 -> "+$42", -80.5 -> "-$80"
fmt_pnl() {
  awk -v v="$1" 'BEGIN{ v=v+0; if(v>=0) printf "+$%.0f", v; else printf "-$%.0f", -v }'
}

# Collect display segments (one per line in $segs). They are joined by " | "
# when they fit the terminal, or wrapped across rows when they do not.
segs=""
add_seg() {
  if [ -z "$segs" ]; then segs="$1"; else segs="$segs
$1"; fi
}

# betterclaude badge, deliberately the FIRST segment so it is leftmost. The
# launcher `exec`s claude, so ps shows `claude` and nothing else distinguishes a
# betterclaude session from a plain one. The exported marker is the only
# evidence that survives, which makes this the sole mid-session answer to
# "am I actually in betterclaude, and at which stage?".
if [ "${BETTERCLAUDE_ACTIVE:-}" = "1" ]; then
  add_seg "${CYAN}>>bc${RESET} ${BETTERCLAUDE_STAGE:-0}"
fi

# Money/trading segments (goal bar, cash, Nautilus P&L) are collected separately
# so they always render on their OWN line, below the meta row.
money=""
add_money() {
  if [ -z "$money" ]; then money="$1"; else money="$money
$1"; fi
}

# Segment 1: project name (cyan) + git branch/dirty state, kept together.
head_seg=""
if [ -n "$dir" ]; then
  proj=$(basename "$dir")
  head_seg="${CYAN}${proj}${RESET}"
fi
if [ -n "$dir" ] && git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "$branch" = "HEAD" ]; then
    branch="@$(git -C "$dir" rev-parse --short HEAD 2>/dev/null)"
  fi
  if [ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ]; then
    branch_label="${YELLOW}${branch} ✱${RESET}"
  else
    branch_label="${GREEN}${branch}${RESET}"
  fi
  # A per-session free-text label (what THIS terminal is working on, written as we
  # work to /tmp/.claude-label-<session>) REPLACES the branch in the display: many
  # terminals share one checkout/branch, so the label is the real differentiator.
  # Falls back to the branch when no label is set.
  session=$(echo "$input" | jq -r '.session_id // empty')
  label=""
  [ -n "$session" ] && [ -f "/tmp/.claude-label-$session" ] && \
    label=$(head -c 60 "/tmp/.claude-label-$session" 2>/dev/null | tr -d '\n')
  if [ -n "$label" ]; then
    disp="${YELLOW}▸ ${label}${RESET}"
  else
    disp="$branch_label"
  fi
  [ -n "$head_seg" ] && head_seg="$head_seg $disp" || head_seg="$disp"
fi

# Issue the terminal is working on, appended to the head segment next to the
# branch. An explicit session marker (dropped by /build, /runbook,
# /issue-resolution) wins; otherwise the issue number embedded in an
# issue-style branch name (feat/155, fix/103, ship/566, 566-foo). Silent when
# neither applies (e.g. main), never a guessed number.
issue=""
session=$(echo "$input" | jq -r '.session_id // empty')
if [ -n "$session" ] && [ -f "/tmp/.claude-issue-$session" ]; then
  issue=$(tr -dc '0-9' < "/tmp/.claude-issue-$session" 2>/dev/null)
fi
if [ -z "$issue" ] && [ -n "$branch" ]; then
  case "$branch" in
    feat/*|fix/*|ship/*|issue/*|bug/*|chore/*|hotfix/*|feat-*|fix-*|ship-*|issue-*|bug-*|chore-*|hotfix-*|[0-9]*-*)
      issue=$(printf '%s' "$branch" | grep -oE '[0-9]+' | head -n1)
      ;;
  esac
fi
if [ -n "$issue" ]; then
  # If the free-text label already carries this issue (e.g. "#560"), don't also
  # append a duplicate chip.
  case "$label" in
    *"#${issue}"*) : ;;
    *)
      issue_label="${MAGENTA}#${issue}${RESET}"
      [ -n "$head_seg" ] && head_seg="$head_seg $issue_label" || head_seg="$issue_label" ;;
  esac
fi

[ -n "$head_seg" ] && add_seg "$head_seg"

add_seg "$model"
[ -n "$account" ] && add_seg "${MAGENTA}${account}${RESET}"
[ -n "$ctx" ] && add_seg "ctx $(color_remaining "$ctx")"

if [ -n "$fivehr" ]; then
  fivehr_label="5h $(color_used "$fivehr")"
  if [ -n "$fivehr_resets" ]; then
    now=$(date +%s)
    secs_left=$(( fivehr_resets - now ))
    fivehr_label="$fivehr_label ($(fmt_duration_hours "$secs_left") left)"
  fi
  add_seg "$fivehr_label"
fi

if [ -n "$weekly" ]; then
  weekly_label="wk $(color_used "$weekly")"
  if [ -n "$weekly_resets" ]; then
    now=$(date +%s)
    secs_left=$(( weekly_resets - now ))
    weekly_label="$weekly_label ($(fmt_duration_days "$secs_left") left)"
  fi
  add_seg "$weekly_label"
fi

# Persist the account-wide rate limits for the omnigent web status bar, which has
# no other way to see them. Only the four quota fields plus a write-time epoch are
# stored (never the full stdin payload). Atomic temp-file + mv so a reader never
# sees a partial file. Fully silent: nothing here may touch stdout or fail the
# script, so it runs in a subshell with all output and errors discarded. Skipped
# entirely when any field is absent, so a session without rate limits cannot
# blank out a good file.
if [ -n "$fivehr" ] && [ -n "$fivehr_resets" ] && [ -n "$weekly" ] && [ -n "$weekly_resets" ]; then
  (
    rl_now=${now:-$(date +%s)}
    rl_tmp="$HOME/.claude/.statusline-ratelimits.tmp.$$"
    printf '{"captured":%s,"five_hour":{"used_percentage":%s,"resets_at":%s},"seven_day":{"used_percentage":%s,"resets_at":%s}}\n' \
      "$rl_now" "$fivehr" "$fivehr_resets" "$weekly" "$weekly_resets" > "$rl_tmp" \
      && mv -f "$rl_tmp" "$HOME/.claude/statusline-ratelimits.json"
  ) >/dev/null 2>&1 || true
fi

# Business + trading metrics from the refresher cache (never live-called here).
# Stale (cache older than 30 min) renders the whole trio gray so a dead refresher
# is visible rather than showing confidently-wrong numbers.
data="$HOME/.claude/statusline-data.json"
if [ -f "$data" ]; then
  now=$(date +%s)
  updated=$(jq -r '.updated // 0' "$data" 2>/dev/null)
  stale=0
  [ -n "$updated" ] && [ $(( now - updated )) -gt 1800 ] && stale=1

  # Goal bar: recurring run-rate toward the active-rung target.
  gr=$(jq -r '.goal.runrate // empty' "$data" 2>/dev/null)
  gt=$(jq -r '.goal.target // empty' "$data" 2>/dev/null)
  if [ -n "$gr" ] && [ -n "$gt" ]; then
    pct=$(awk -v a="$gr" -v b="$gt" 'BEGIN{ if(b>0){p=a/b*100; if(p<0)p=0; if(p>100)p=100; printf "%d",p} else print 0 }')
    filled=$(( pct / 10 )); [ "$filled" -gt 10 ] && filled=10
    bar=""; i=0
    while [ $i -lt $filled ]; do bar="${bar}▓"; i=$((i+1)); done
    while [ $i -lt 10 ]; do bar="${bar}░"; i=$((i+1)); done
    goal_txt="Goal ${bar} ${pct}% $(fmt_money "$gr")/$(fmt_k "$gt")"
    if [ "$stale" = 1 ]; then add_money "${GRAY}${goal_txt}${RESET}"; else add_money "${CYAN}${goal_txt}${RESET}"; fi
  fi

  # Pipeline coverage: QUALIFIED open pipeline value (deals at replied-interested +
  # proposal-sent) toward the standing pipeline target (config pipelineGoal.target,
  # $275K), drawn as a bar like the Goal line. "Qualified" deliberately EXCLUDES the
  # untouched cold leads/prospects: the raw open total is ~95% unqualified cold import
  # (vanity). Falls back to the goal target if no pipeline target is cached yet.
  ptarget=$(jq -r '.pipeline.target // empty' "$data" 2>/dev/null)
  [ -z "$ptarget" ] && ptarget="$gt"
  # DO NOT divide this target by 12. Removed 2026-08-04 (Calvin). pipelineGoal.target is a
  # STOCK (qualified open pipeline value standing at any moment), not an annual FLOW, per
  # "Executive Team/active-goal.json": target 275000, rationale "12 retainer-shaped deals at
  # ~$23K first-year value each". So 275000/12 does not yield a monthly pipeline goal, it
  # yields ONE DEAL's first-year value, and the bar then over-reported coverage by 12x
  # (read 176% at $40,491 when true coverage was 14.7%) and disagreed with the exec-app CEO
  # tile, which rules its ring-gate on the full 275000 (coveragePct 0.168 same day).
  qtotal=$(jq -r '[.pipeline.stages[]? | select(.stage=="REPLIED_INTERESTED" or .stage=="PROPOSAL_SENT") | .value] | add // empty' "$data" 2>/dev/null)
  if [ -n "$qtotal" ] && [ -n "$ptarget" ]; then
    # Bar fill capped at 100%; label shows the true %, so >100% coverage stays visible.
    ppct=$(awk -v a="$qtotal" -v b="$ptarget" 'BEGIN{ if(b>0){p=a/b*100; if(p<0)p=0; if(p>100)p=100; printf "%d",p} else print 0 }')
    ppct_true=$(awk -v a="$qtotal" -v b="$ptarget" 'BEGIN{ if(b>0) printf "%d", a/b*100; else print 0 }')
    pfilled=$(( ppct / 10 )); [ "$pfilled" -gt 10 ] && pfilled=10
    pbar=""; i=0
    while [ $i -lt $pfilled ]; do pbar="${pbar}▓"; i=$((i+1)); done
    while [ $i -lt 10 ]; do pbar="${pbar}░"; i=$((i+1)); done
    pipe_txt="Pipeline ${pbar} ${ppct_true}% $(fmt_money "$qtotal")/$(fmt_k "$ptarget")"
    # Its own money segment: the packer keeps it on the Goal line when it fits and
    # wraps it to the next line when it does not.
    if [ "$stale" = 1 ]; then add_money "${GRAY}${pipe_txt}${RESET}"; else add_money "${CYAN}${pipe_txt}${RESET}"; fi
  fi

  # Cash on hand (red under $3K, yellow under $6K).
  cv=$(jq -r '.cash.value // empty' "$data" 2>/dev/null)
  if [ -n "$cv" ]; then
    cash_txt="Cash $(fmt_money "$cv")"
    ccol=$(awk -v v="$cv" 'BEGIN{ v=v+0; if(v<3000) print "R"; else if(v<6000) print "Y"; else print "G" }')
    if [ "$stale" = 1 ]; then cclr="$GRAY"
    elif [ "$ccol" = "R" ]; then cclr="$RED"
    elif [ "$ccol" = "Y" ]; then cclr="$YELLOW"
    else cclr="$GREEN"; fi
    add_money "${cclr}${cash_txt}${RESET}"
  fi

  # Nautilus daily P&L (green up, red down; flat when no position).
  ntd=$(jq -r '.nt.daily // empty' "$data" 2>/dev/null)
  ntp=$(jq -r '.nt.positions // 0' "$data" 2>/dev/null)
  if [ -n "$ntd" ]; then
    if [ "${ntp:-0}" -eq 0 ] 2>/dev/null; then
      nt_txt="NT flat"; ncol="$GRAY"
    else
      arrow=$(awk -v v="$ntd" 'BEGIN{ printf (v+0>=0)?"▲":"▼" }')
      nt_txt="NT $(fmt_pnl "$ntd") ${arrow}"
      ncol=$(awk -v v="$ntd" 'BEGIN{ print (v+0>=0)?"G":"R" }')
      [ "$ncol" = "G" ] && ncol="$GREEN" || ncol="$RED"
    fi
    [ "$stale" = 1 ] && ncol="$GRAY"
    add_money "${ncol}${nt_txt}${RESET}"
  fi
fi

# Verse of the day (rotates once per day, stable through the day), muted gray.
verses=$(cat <<'EOF'
I can do all things through Christ who strengthens me. (Phil 4:13)
And my God will supply every need of yours. (Phil 4:19)
The LORD is my shepherd; I shall not want. (Ps 23:1)
Seek first the kingdom of God, and all these things will be added. (Matt 6:33)
The LORD will provide. (Gen 22:14)
Every good and perfect gift is from above. (James 1:17)
He supplies seed to the sower and multiplies it. (2 Cor 9:10)
Be strong and courageous; do not be afraid. (Josh 1:9)
The joy of the LORD is your strength. (Neh 8:10)
With God all things are possible. (Matt 19:26)
He gives power to the faint and strength to the weak. (Isa 40:29)
They who wait on the LORD shall renew their strength. (Isa 40:31)
Fear not, for I am with you; I will strengthen you. (Isa 41:10)
The LORD is my strength and my shield. (Ps 28:7)
For I know the plans I have for you, declares the LORD. (Jer 29:11)
Commit your work to the LORD, and your plans will be established. (Prov 16:3)
In all your ways acknowledge Him, and He will make your paths straight. (Prov 3:6)
We are His workmanship, created for good works. (Eph 2:10)
Many are the plans of the heart, but the purpose of the LORD will stand. (Prov 19:21)
Whatever you do, work heartily, as for the Lord. (Col 3:23)
He who began a good work in you will complete it. (Phil 1:6)
Run with endurance the race set before you. (Heb 12:1)
Let us not grow weary of doing good. (Gal 6:9)
Trust in the LORD with all your heart. (Prov 3:5)
EOF
)
vcount=$(printf '%s\n' "$verses" | wc -l | tr -d ' ')
if [ "$vcount" -gt 0 ]; then
  # Pick once per terminal/session: hash the session id so the verse is
  # stable within a session but rolls to a new one on each new terminal.
  session=$(echo "$input" | jq -r '.session_id // empty')
  if [ -n "$session" ]; then
    seed=$(printf '%s' "$session" | cksum | cut -d' ' -f1)
  else
    seed=$(date +%j | sed 's/^0*//')
    [ -z "$seed" ] && seed=1
  fi
  vidx=$(( (seed % vcount) + 1 ))
  verse=$(printf '%s\n' "$verses" | sed -n "${vidx}p")
fi

# Assemble output as three fixed groups, each on its own row(s):
#   1. meta   (project/branch, model, ctx, rate limits)
#   2. money  (goal bar, cash, Nautilus P&L) — always its own line
#   3. verse  (word-wrapped, muted gray)
# Each group is packed to the terminal width so a narrow window wraps rather than
# truncating. printf without a trailing newline on the last row keeps the cursor tidy.
out=""
append_rows() {  # $1 = newline-delimited rows to append to $out
  while IFS= read -r r; do
    [ -z "$r" ] && continue
    if [ -z "$out" ]; then out="$r"; else out="$out
$r"; fi
  done <<INNER
$1
INNER
}

[ -n "$segs" ]  && append_rows "$(printf '%s\n' "$segs"  | pack " | ")"
[ -n "$money" ] && append_rows "$(printf '%s\n' "$money" | pack " | ")"
if [ -n "$verse" ]; then
  vrows=$(printf '%s\n' "$verse" | tr ' ' '\n' | pack " " | while IFS= read -r vr; do
    printf '%s%s%s\n' "$GRAY" "$vr" "$RESET"
  done)
  append_rows "$vrows"
fi

printf '%s' "$out"
