#!/bin/bash
set -e

echo "🚀 Setting up devcontainer baseline features..."

# Install and configure zsh with oh-my-zsh
echo "🐚 Installing and configuring zsh with oh-my-zsh..."
# Install oh-my-zsh (unattended mode)
if [ ! -d "$HOME/.oh-my-zsh" ]; then
    sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
fi

# Configure .zshrc with requested plugins
if [ -f "$HOME/.zshrc" ]; then
    # Update plugins line in .zshrc
    sed -i 's/plugins=(git)/plugins=(git rbenv nodenv sublime brew npm yarn dotnet golang web-search claude)/' "$HOME/.zshrc"
    echo "✅ Configured zsh plugins"
fi

# Set zsh as default shell for the user
if [ "$SHELL" != "$(which zsh)" ]; then
    sudo chsh -s "$(which zsh)" "$(whoami)" || echo "⚠️  Could not change default shell, but zsh is available"
fi

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
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/j178/prek/releases/download/v0.3.6/prek-installer.sh | sh

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
