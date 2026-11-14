#!/usr/bin/env bash
set -euo pipefail

# Run from any directory; all changes stay inside this project.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

echo "VetCloudPro Linux setup"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required. Install Node.js 24 LTS first:"
  echo "https://nodejs.org/en/download"
  echo "Then open a new terminal and rerun: bash setup-linux.sh"
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 24 )); then
  echo "Node.js 24 or newer is required for the project's image tests."
  echo "Your version: $(node --version)"
  echo "Install Node.js 24 LTS from https://nodejs.org/en/download, then rerun this script."
  exit 1
fi

echo "Using Node.js $(node --version) and npm $(npm --version)."

install_dependencies=yes
if [[ -e node_modules ]]; then
  echo "An existing node_modules directory was found."
  echo "npm ci replaces it. Reinstall dependencies? [y/N]"
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) install_dependencies=no ;;
  esac
fi

if [[ "$install_dependencies" == yes ]]; then
  npm ci
else
  echo "Kept existing node_modules; dependency installation skipped."
fi

if [[ -e .env.local || -L .env.local ]]; then
  echo "Kept your existing .env.local unchanged."
else
  cp -n .env.example .env.local
  echo "Created .env.local from .env.example."
  echo "To use R2 images, edit .env.local and set NEXT_PUBLIC_IMAGE_WORKER_URL"
  echo "to the deployed Worker URL. Leave it empty to use inline images."
fi

echo
echo "Setup finished. Start the app with:"
echo "  npm run dev"
echo "Then open http://localhost:3000 in your browser."
echo
echo "Optional checks: npm run test:images, npx tsc --noEmit, npm run build."
echo "The Firestore rules tests also require Java: npm run test:rules."
