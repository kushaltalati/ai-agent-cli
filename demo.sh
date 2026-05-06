#!/usr/bin/env bash
# One-command demo: starts the agent, asks it to clone Scaler, opens the result.
# Designed so you can hit "Record" once in QuickTime, run this, then hit stop.

set -e
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "ERROR: .env not found. Copy .env.example to .env and add your GROQ_API_KEY first."
  exit 1
fi

echo
echo "==> Cleaning previous output..."
rm -rf scaler-clone

echo "==> Launching AI Agent CLI..."
echo

# Pipe the instruction; EOF after the line tells the agent to exit cleanly.
printf "clone the scaler academy website\n" | npm start

echo
echo "==> Opening generated site in default browser..."
sleep 1
open scaler-clone/index.html

echo
echo "==> Done. Demo complete."
