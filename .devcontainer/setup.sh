#!/bin/bash
set -euo pipefail

echo "🚀 Setting up devcontainer baseline features..."

# Install and configure zsh with oh-my-zsh
echo "🐚 Installing and configuring zsh with oh-my-zsh..."
# Install oh-my-zsh (unattended mode)
if [ ! -d "$HOME/.oh-my-zsh" ]; then
    OHMYZSH_COMMIT="44394e7225cd2e2200fa2e6a0ed957fed6a4d5d0"
    OHMYZSH_SHA256="ce0b7c94aa04d8c7a8137e45fe5c4744e3947871f785fd58117c480c1bf49352"
    curl -fsSL -o /tmp/ohmyzsh-install.sh \
      "https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/${OHMYZSH_COMMIT}/tools/install.sh"
    echo "${OHMYZSH_SHA256}  /tmp/ohmyzsh-install.sh" | sha256sum -c -
    sh /tmp/ohmyzsh-install.sh --unattended
    rm -f /tmp/ohmyzsh-install.sh
fi

# Configure .zshrc with requested plugins
if [ -f "$HOME/.zshrc" ]; then
    # Update plugins line in .zshrc
    sed -i 's/^plugins=(.*)$/plugins=(git rbenv nodenv sublime brew npm yarn dotnet golang web-search claude)/' "$HOME/.zshrc"
    echo "✅ Configured zsh plugins"
fi

# Set zsh as default shell for the user
if [ "$SHELL" != "$(which zsh)" ]; then
    sudo chsh -s "$(which zsh)" "$(whoami)" || echo "⚠️  Could not change default shell, but zsh is available"
fi

# Install agent-reviews globally
echo "📦 Installing agent-reviews..."
npm install -g agent-reviews@1.0.1

# Add agent-reviews skill (unattended mode)
echo "🔧 Adding agent-reviews skill..."
# Use --yes flag or provide inputs automatically to avoid interactive prompts
echo "y" | npx skills add pbakaus/agent-reviews || {
    echo "⚠️  agent-reviews skill may already be installed or setup had an issue"
}

# Add petems-skills (unattended mode)
echo "🔧 Adding petems-skills..."
echo "y" | npx skills add petems/petems-skills || {
    echo "⚠️  petems-skills may already be installed or setup had an issue"
}

# Install prek (pre-commit hook manager)
echo "🪝 Installing prek..."
PREK_SHA256="9cb623a33efdc8c5478cc4b5c8b9958955f22a2452b29185c69fc760cd737ada"
curl --proto '=https' --tlsv1.2 -LsSf -o /tmp/prek-installer.sh \
  https://github.com/j178/prek/releases/download/v0.3.6/prek-installer.sh
echo "${PREK_SHA256}  /tmp/prek-installer.sh" | sha256sum -c -
sh /tmp/prek-installer.sh
rm -f /tmp/prek-installer.sh

# Install markdownlint-cli
echo "📝 Installing markdownlint-cli..."
npm install -g markdownlint-cli@0.48.0

# Initialize prek hooks if prek.toml exists
if [ -f "prek.toml" ]; then
    echo "🔨 Setting up prek git hooks..."
    prek install || {
        echo "⚠️  prek hooks may already be installed"
    }
fi

echo "✅ Devcontainer setup complete!"
