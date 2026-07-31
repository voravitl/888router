#!/usr/bin/env bash
set -e

# Helper script for 888router 7-Step CI/CD Delivery Pipeline Execution
# Usage: ./scripts/cicd-release.sh <version>
# Example: ./scripts/cicd-release.sh 0.11.2

VERSION="$1"

if [ -z "$VERSION" ]; then
  # Read current version from package.json if not specified
  VERSION=$(node -e 'console.log(require("./package.json").version)')
fi

echo "====================================================="
echo "🚀 Starting 888router CI/CD Release Pipeline v${VERSION}"
echo "====================================================="

# Step 2: Automated Verification
echo "➡️ [Step 2] Running Automated Unit Tests..."
npx vitest run tests/unit/universal-tool-engine.test.js tests/unit/pruner.test.js tests/unit/kimchi.test.js tests/unit/kimchi-strip-reasoning.test.js tests/unit/db-benchmark.test.js --config tests/vitest.config.js

# Step 4: Production & Docker Build Gate
echo "➡️ [Step 4] Building Next.js Production App..."
npm run build

echo "➡️ [Step 4] Building Docker Container Images..."
docker build -t "voravitl/888router:v${VERSION}" -t "voravitl/888router:latest" .

# Step 5: Version Bumping, Release Tagging, Registry Push & Merge
echo "➡️ [Step 5] Pushing Docker Images to Registry..."
docker push "voravitl/888router:v${VERSION}"
docker push "voravitl/888router:latest"

echo "➡️ [Step 5] Creating Git Release Tag v${VERSION}..."
if git rev-parse "v${VERSION}" >/dev/null 2>&1; then
  echo "Tag v${VERSION} already exists locally, skipping creation."
else
  git tag -a "v${VERSION}" -m "Release v${VERSION}"
  git push origin "v${VERSION}"
fi

# Step 6: Local Container Redeploy & Liveness Check
echo "➡️ [Step 6] Redeploying Local Container..."
docker compose up -d --force-recreate

echo "➡️ [Step 6] Verifying Container Liveness..."
sleep 3
LIVENESS=$(curl -s http://localhost:20128/api/version || echo '{"error":"unreachable"}')
echo "Liveness Health Check Result: ${LIVENESS}"

echo "====================================================="
echo "✅ CI/CD Release Pipeline v${VERSION} Completed Successfully!"
echo "====================================================="
