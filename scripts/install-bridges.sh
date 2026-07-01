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

# 1. Claude's per-user skills tree
if [ -d "$HOME/.claude/skills" ]; then
  ln -sfn "$HOME/.claude/skills" "$PI_SKILLS/_claude"
  echo "linked: ~/.claude/skills → $PI_SKILLS/_claude"
fi

# 2. Claude plugin skills — one wrapper dir per skill, named after frontmatter `name:`.
#    (Plugin authors sometimes namespace the skill name without renaming the dir;
#    pi's validator requires name == parent dir, so we rename via symlink target.)
_linked=0; _skipped=0; _collisions=0
for plugin_skills_dir in "$HOME"/.claude/plugins/marketplaces/*/plugins/*/skills \
                         "$HOME"/.claude/plugins/marketplaces/*/external_plugins/*/skills; do
  [ -d "$plugin_skills_dir" ] || continue
  for skill_dir in "$plugin_skills_dir"/*/; do
    skill_md="${skill_dir%/}/SKILL.md"
    [ -f "$skill_md" ] || continue
    link_skill "$skill_md" "$(basename "${skill_dir%/}")" dir
  done
done
echo "linked: $_linked plugin skills (skipped $_skipped no-description, $_collisions collisions)"

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

echo "done."
