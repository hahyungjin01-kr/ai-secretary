#!/usr/bin/env bash
# Traders AI → Firebase Hosting + Functions + Firestore + Scheduler
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .firebaserc ]]; then
  echo "Missing .firebaserc — set projects.default to your Firebase project id"
  exit 1
fi

PROJECT="$(node -e "console.log(require('./.firebaserc').projects.default)")"
if [[ "$PROJECT" == "YOUR_FIREBASE_PROJECT_ID" || -z "$PROJECT" ]]; then
  echo "Edit .firebaserc projects.default to your real Firebase project id"
  exit 1
fi

if ! command -v firebase >/dev/null 2>&1; then
  echo "Install Firebase CLI: npm i -g firebase-tools"
  exit 1
fi

echo "==> Building web (Hosting)"
npm run build

echo "==> Building functions"
npm run build:functions

echo "==> Deploying to project: $PROJECT"
firebase deploy --project "$PROJECT" --only hosting,functions,firestore

echo ""
echo "Done. Hosting URL: https://${PROJECT}.web.app"
echo "Secrets (once): see USAGE.md Firebase section"
echo "IMPORTANT: Firebase egress IPs rotate — register them in Toss OR use VPC+Cloud NAT static IP."
