#!/bin/bash
# Run this on desktop to capture Claude Code's raw PTY output.
# Usage: ./capture-output.sh <scenario-name>
# Output: captures/<scenario-name>.raw

mkdir -p captures
script -q "captures/$1.raw" claude
