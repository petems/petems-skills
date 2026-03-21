#!/bin/bash
set -e

echo "🚀 Setting up devcontainer baseline features..."

# Install agent-reviews globally
echo "📦 Installing agent-reviews..."
npm install -g agent-reviews

# Add agent-reviews skill (unattended mode)
echo "🔧 Adding agent-reviews skill..."
# Use --yes flag or provide inputs automatically to avoid interactive prompts
echo "y" | npx skills add pbakaus/agent-reviews@resolve-agent-reviews || {
    echo "⚠️  agent-reviews skill may already be installed or setup had an issue"
}

# Install prek (pre-commit hook manager)
echo "🪝 Installing prek..."
npm install -g prek

# Install markdownlint-cli
echo "📝 Installing markdownlint-cli..."
npm install -g markdownlint-cli

# Initialize prek hooks if prek.toml exists
if [ -f "prek.toml" ]; then
    echo "🔨 Setting up prek git hooks..."
    prek install || {
        echo "⚠️  prek hooks may already be installed"
    }
fi

echo "✅ Devcontainer setup complete!"
