#!/usr/bin/env bash
# Bash companion for WSL / Git Bash. The centre uses the Windows Docker Desktop daemon.
set -euo pipefail
cd "$(dirname "$0")"
command -v powershell.exe >/dev/null || { echo 'Run this file in WSL or Git Bash on Windows; see README_WINDOWS.md.'; exit 1; }
if command -v wslpath >/dev/null; then
  hf_script=$(wslpath -w "$PWD/scripts/windows/HoneyForge.ps1")
elif command -v cygpath >/dev/null; then
  hf_script=$(cygpath -w "$PWD/scripts/windows/HoneyForge.ps1")
else
  echo 'Windows path conversion unavailable. Use START_WINDOWS.cmd.'; exit 1
fi
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$hf_script" "$@"
