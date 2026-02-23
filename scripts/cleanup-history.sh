#!/bin/bash
# Security History Cleanup Script
# This script removes exposed secrets from git history
#
# IMPORTANT: This must be run from a FRESH CLONE of the repository
# Do NOT run this from a Google Drive synced folder
#
# Usage:
#   1. Clone fresh: git clone https://github.com/webglo-hq/studiox-website.git cleanup-repo
#   2. cd cleanup-repo
#   3. bash scripts/cleanup-history.sh
#   4. git push --force origin main
#
# After running, ALL collaborators must re-clone the repository

set -e

echo "=== Security History Cleanup ==="
echo ""

# Check if we're in the right directory
if [ ! -f "_config.yml" ]; then
    echo "ERROR: Must be run from the root of the studiox-website repository"
    exit 1
fi

# Check for git-filter-repo
if ! command -v git-filter-repo &> /dev/null; then
    echo "Installing git-filter-repo..."
    pip install git-filter-repo
fi

# Create expressions file for replacements
cat > /tmp/secret-replacements.txt << 'EOF'
AIzaSyAtZCIn4OyakDS31DQuzf6tdvCJam1XgKA==>REDACTED_API_KEY
EOF

echo "Removing secrets from git history..."
git filter-repo --replace-text /tmp/secret-replacements.txt --force

# Clean up
rm /tmp/secret-replacements.txt

echo ""
echo "=== Done! ==="
echo ""
echo "Next steps:"
echo "  1. Re-add the origin remote:"
echo "     git remote add origin https://github.com/webglo-hq/studiox-website.git"
echo ""
echo "  2. Force push to overwrite history:"
echo "     git push --force origin main"
echo ""
echo "  3. All collaborators must re-clone the repository"
echo ""
echo "  4. IMPORTANT: Rotate the Gemini API key at:"
echo "     https://aistudio.google.com/apikey"
