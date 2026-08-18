#!/bin/bash
# Pushes this folder to https://github.com/juliancalvoh-lab/nexusai
# Double-click to run.
cd "$(dirname "$0")"
set -e
rm -rf .git
git init -q
git add -A
git -c user.name="Julian Calvo" -c user.email="juliancalvoh@gmail.com" \
  commit -q -m "NexusAI capstone: contracts, tests, ML pipeline, testnet deployment"
git branch -M main
git remote add origin https://github.com/juliancalvoh-lab/nexusai.git
echo
echo "Pushing. If it asks for a password, use a GitHub personal access token,"
echo "not your account password. github.com/settings/tokens -> classic -> repo scope."
echo
git push -u origin main --force
echo
echo "Done: https://github.com/juliancalvoh-lab/nexusai"
