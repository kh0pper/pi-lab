#!/usr/bin/env bash
# install-bridges.sh — symlink Claude Code skills/commands and Crow skills into pi's auto-discovery dirs.
# Re-runnable: uses `ln -sfn` so existing symlinks are updated, not duplicated.
#
# Crow skills: uses dir-with-SKILL.md structure (parent dir name matches frontmatter name).
# Skills without `description:` frontmatter (Crow's older heading-style format) are skipped —
# pi refuses to load them and they'd just add startup noise.

set -euo pipefail

PI_SKILLS="$HOME/.pi/agent/skills"
PI_PROMPTS="$HOME/.pi/agent/prompts"
mkdir -p "$PI_SKILLS" "$PI_PROMPTS"

# Cleanup: remove legacy symlinks from earlier versions of this script.
# - crow-*.md  : flat Crow symlinks (replaced by dir-with-SKILL.md in step 3)
# - _plugin-*  : umbrella per-plugin symlinks (replaced by per-skill dirs in step 2)
# Both triggered "name does not match parent directory" warnings on pi startup
# whenever a plugin author chose a skill `name:` field that didn't match the
# directory the SKILL.md lived in (e.g. hookify's writing-rules → writing-hookify-rules).
for f in "$PI_SKILLS"/crow-*.md "$PI_SKILLS"/_plugin-*; do
  [ -L "$f" ] && rm -f "$f"
done

# Helper: link a SKILL.md as a frontmatter-named wrapper dir, with first-wins collision handling.
# Args: <skill_md_path> <fallback_name> <link_target_kind> <accumulator_prefix>
#   link_target_kind: "dir" (symlink the whole containing directory) or "file" (mkdir + symlink SKILL.md only)
# Side effects: increments _linked / _skipped / _collisions counters in the caller's scope.
link_skill() {
  local skill_md=$1 fallback_name=$2 link_kind=$3
  # Require description: field (pi rejects skills without it)
  if ! awk '/^---$/{c++; next} c==1 && /^description:/{found=1} END{exit !found}' "$skill_md"; then
    _skipped=$((_skipped+1)); return
  fi
  local fm_name name target src current
  fm_name=$(awk '/^---$/{c++; next} c==1 && /^name:/{sub(/^name:[[:space:]]*/,""); print; exit}' "$skill_md")
  name=${fm_name:-$fallback_name}
  target="$PI_SKILLS/$name"
  if [ "$link_kind" = "dir" ]; then
    src=$(dirname "$skill_md")
    if [ -L "$target" ]; then
      current=$(readlink "$target")
      if [ "$current" = "$src" ]; then return; fi  # idempotent re-run
      _collisions=$((_collisions+1)); return         # first-wins
    elif [ -e "$target" ]; then
      _collisions=$((_collisions+1)); return
    fi
    ln -sfn "$src" "$target"
  else
    # file mode: real dir + symlinked SKILL.md (used for Crow skills which are flat .md files)
    if [ -L "$target" ]; then _collisions=$((_collisions+1)); return; fi
    mkdir -p "$target"
    ln -sfn "$skill_md" "$target/SKILL.md"
  fi
  _linked=$((_linked+1))
}

# Skills that only make sense inside Claude Code (its sessions, hooks,
# plugins, CLAUDE.md tooling) — bridging them into pi is pure menu noise.
is_claude_code_only() {
  case "$1" in
    claude-session-recovery|claude-md-improver|claude-automation-recommender|\
    hook-development|writing-hookify-rules|plugin-settings|plugin-structure|\
    command-development|skill-development|skill-creator|example-command|example-skill)
      return 0 ;;
    *) return 1 ;;
  esac
}

# 1. Claude's per-user skills tree — per-skill links so Claude-Code-only
#    skills can be filtered (was previously one whole-tree symlink).
if [ -L "$PI_SKILLS/_claude" ]; then
  rm -f "$PI_SKILLS/_claude"; echo "removed legacy whole-tree link: _claude"
fi
if [ -d "$HOME/.claude/skills" ]; then
  _linked=0; _skipped=0; _collisions=0; _filtered=0
  for skill_dir in "$HOME"/.claude/skills/*/; do
    skill_md="${skill_dir%/}/SKILL.md"
    [ -f "$skill_md" ] || continue
    name="$(basename "${skill_dir%/}")"
    if is_claude_code_only "$name"; then _filtered=$((_filtered+1)); rm -f "$PI_SKILLS/$name" 2>/dev/null; continue; fi
    link_skill "$skill_md" "$name" dir
  done
  echo "linked: $_linked user skills ($_filtered Claude-Code-only filtered, $_collisions collisions)"
fi

# 2. Claude plugin skills — one wrapper dir per skill, named after frontmatter `name:`.
#    (Plugin authors sometimes namespace the skill name without renaming the dir;
#    pi's validator requires name == parent dir, so we rename via symlink target.)
_linked=0; _skipped=0; _collisions=0
for plugin_skills_dir in "$HOME"/.claude/plugins/marketplaces/*/plugins/*/skills \
                         "$HOME"/.claude/plugins/marketplaces/*/external_plugins/*/skills; do
  [ -d "$plugin_skills_dir" ] || continue
  # superpowers is wired in whole as a pi package (step 2b) — per-skill symlinks
  # here would dual-load its 14 skills if it ever appears under marketplaces/.
  case "$(basename "$(dirname "$plugin_skills_dir")")" in superpowers) continue ;; esac
  for skill_dir in "$plugin_skills_dir"/*/; do
    skill_md="${skill_dir%/}/SKILL.md"
    [ -f "$skill_md" ] || continue
    _pname="$(basename "${skill_dir%/}")"
    _fmname=$(awk '/^---$/{c++; next} c==1 && /^name:/{sub(/^name:[[:space:]]*/,""); print; exit}' "$skill_md")
    if is_claude_code_only "$_pname" || { [ -n "$_fmname" ] && is_claude_code_only "$_fmname"; }; then
      rm -f "$PI_SKILLS/$_pname" "$PI_SKILLS/$_fmname" 2>/dev/null; continue
    fi
    link_skill "$skill_md" "$_pname" dir
  done
done
echo "linked: $_linked plugin skills (skipped $_skipped no-description, $_collisions collisions)"

# 2b. Superpowers as a native pi package.
#     The superpowers Claude plugin ships first-class pi support (package.json
#     "pi" key -> .pi/extensions/superpowers.ts + skills/), so we load it as a
#     whole pi package instead of symlinking its skills individually — that way
#     we also get its session-start bootstrap injection. The Claude plugin cache
#     path is versioned, so a stable symlink absorbs updates: re-run this script
#     after a plugin update and the link repoints.
#     ORDER MATTERS: the package is inserted BEFORE pi-lab in settings.packages
#     so pi-lab's superpowers-guard `context` handler runs after superpowers'
#     injector and can strip the bootstrap from subagent/bot prompts.
PI_PKG="$HOME/.pi/agent/pkg"
sp_path="$(python3 - <<'PYEOF'
import json, os
path = ""
try:
    reg = os.path.expanduser("~/.claude/plugins/installed_plugins.json")
    entries = json.load(open(reg))["plugins"]["superpowers@claude-plugins-official"]
    for e in entries:
        p = e.get("installPath", "")
        if p and os.path.isdir(p):
            path = p
            break
except Exception:
    pass
if not path:
    cache = os.path.expanduser("~/.claude/plugins/cache/claude-plugins-official/superpowers")
    if os.path.isdir(cache):
        def vkey(v):
            return [int(x) if x.isdigit() else -1 for x in v.split(".")]
        versions = sorted((d for d in os.listdir(cache) if os.path.isdir(os.path.join(cache, d))), key=vkey)
        if versions:
            path = os.path.join(cache, versions[-1])
print(path)
PYEOF
)"
if [ -n "$sp_path" ] && [ -f "$sp_path/package.json" ]; then
  mkdir -p "$PI_PKG"
  ln -sfn "$sp_path" "$PI_PKG/superpowers"
  python3 - <<'PYEOF'
import json, os
p = os.path.expanduser("~/.pi/agent/settings.json")
d = json.load(open(p)) if os.path.exists(p) else {}
pkgs = d.setdefault("packages", [])
entry = "pkg/superpowers"  # relative to ~/.pi/agent, same convention as ../../pi-lab
if entry not in pkgs:
    pkgs.insert(0, entry)  # before pi-lab: superpowers-guard must run after the injector
    with open(p, "w") as f:
        json.dump(d, f, indent=2)
    print("settings.json: packages += pkg/superpowers (inserted before pi-lab)")
PYEOF
  echo "superpowers: pi package -> $sp_path"
else
  echo "superpowers: plugin not installed; skipped"
fi

# 3. Crow skills with proper frontmatter — one dir per skill so name matches parent dir.
#    Skip files lacking `description:` (Crow's heading-style format — pi can't load them).
if [ -d "$HOME/crow/skills" ]; then
  _linked=0; _skipped=0; _collisions=0
  for f in "$HOME"/crow/skills/*.md; do
    [ -f "$f" ] || continue
    link_skill "$f" "$(basename "$f" .md)" file
  done
  echo "linked: $_linked crow skills (skipped $_skipped no-description, $_collisions collisions)"
fi

# 4. Claude slash commands as pi prompt templates
if [ -d "$HOME/.claude/commands" ]; then
  for f in "$HOME"/.claude/commands/*.md; do
    [ -f "$f" ] || continue
    ln -sfn "$f" "$PI_PROMPTS/$(basename "$f")"
  done
  echo "linked: $(ls "$HOME"/.claude/commands/*.md 2>/dev/null | wc -l) claude commands"
fi

# 5. pi-lab subagent agents + prompt templates (this repo is the source of truth).
#    Cleanup first: the original install symlinked agents to @mariozechner example paths
#    that vanished when pi renamed scopes to @earendil-works, leaving dangling links
#    that made the subagent tool resolve zero user-scope agents.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_AGENTS="$HOME/.pi/agent/agents"
mkdir -p "$PI_AGENTS"

for f in "$PI_AGENTS"/*.md; do
  if [ -L "$f" ] && [ ! -e "$f" ]; then
    case "$(readlink "$f")" in
      */node_modules/@mariozechner/*) rm -f "$f"; echo "removed dangling: $f" ;;
    esac
  fi
  # Also retire symlinks into pi's managed git-package clones (~/.pi/agent/git/…):
  # machines that switched to a working ../../pi-lab checkout must not keep
  # loading agents from the stale package copy.
  if [ -L "$f" ]; then
    case "$(readlink "$f")" in
      */.pi/agent/git/*/pi-lab/*) rm -f "$f"; echo "removed stale package-clone link: $f" ;;
    esac
  fi
done

_linked=0; _collisions=0
for f in "$REPO_ROOT"/extensions/subagent/agents/*.md; do
  [ -f "$f" ] || continue
  target="$PI_AGENTS/$(basename "$f")"
  if [ -e "$target" ] && [ "$(readlink "$target" 2>/dev/null || true)" != "$f" ]; then
    _collisions=$((_collisions+1)); continue  # first-wins: don't clobber user-managed files
  fi
  ln -sfn "$f" "$target"; _linked=$((_linked+1))
done
echo "linked: $_linked pi-lab agents ($_collisions collisions)"

_linked=0; _collisions=0
for f in "$REPO_ROOT"/extensions/subagent/prompts/*.md; do
  [ -f "$f" ] || continue
  target="$PI_PROMPTS/$(basename "$f")"
  if [ -e "$target" ] && [ "$(readlink "$target" 2>/dev/null || true)" != "$f" ]; then
    _collisions=$((_collisions+1)); continue
  fi
  ln -sfn "$f" "$target"; _linked=$((_linked+1))
done
echo "linked: $_linked pi-lab prompts ($_collisions collisions)"

# 6. Keybindings: pi core binds shift+tab to thinking-level cycling; the
#    permission-modes extension wants it for Claude-Code-parity mode cycling.
#    Move thinking to ctrl+alt+t (only if the user hasn't remapped it already).
python3 - <<'PYEOF'
import json, os
p = os.path.expanduser("~/.pi/agent/keybindings.json")
d = json.load(open(p)) if os.path.exists(p) else {}
if "app.thinking.cycle" not in d:
    d["app.thinking.cycle"] = "ctrl+alt+t"
    json.dump(d, open(p, "w"), indent=2)
    print("keybindings: thinking cycle -> ctrl+alt+t (shift+tab freed for /mode)")
PYEOF

echo "done."
