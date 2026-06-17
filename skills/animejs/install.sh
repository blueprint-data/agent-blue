#!/bin/bash

set -e

REPO_BASE="https://raw.githubusercontent.com/BowTiedSwan/animejs-skills/main"
CLAUDE_DIR="$HOME/.claude/skills"
SKILL_DIR="$CLAUDE_DIR/animejs"
REFS_DIR="$SKILL_DIR/references"

GREEN='\033[0;32m'
GRAY='\033[0;90m'
NC='\033[0m'

echo ""
echo -e "${GRAY}Detecting environment...${NC}"

if [ -d "$HOME/.claude" ]; then
    echo -e "${GREEN}> Claude Code detected${NC}"
else
    echo -e "${GRAY}Creating Claude Code directory...${NC}"
fi

mkdir -p "$REFS_DIR"

echo -e "${GRAY}Downloading skill definition...${NC}"
curl -sSL "$REPO_BASE/SKILL.md" -o "$SKILL_DIR/SKILL.md"

echo -e "${GRAY}Downloading API reference...${NC}"
curl -sSL "$REPO_BASE/references/api-reference.md" -o "$REFS_DIR/api-reference.md"

echo -e "${GRAY}Downloading examples...${NC}"
curl -sSL "$REPO_BASE/references/examples.md" -o "$REFS_DIR/examples.md"

echo ""
echo -e "${GREEN}> animejs skill installed successfully${NC}"
echo -e "${GRAY}  Location: $SKILL_DIR/${NC}"
echo -e "${GRAY}  Files:${NC}"
echo -e "${GRAY}    - SKILL.md${NC}"
echo -e "${GRAY}    - references/api-reference.md${NC}"
echo -e "${GRAY}    - references/examples.md${NC}"
echo ""
