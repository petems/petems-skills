# Devcontainer Configuration

This directory contains the devcontainer configuration for the petems-skills repository, optimized for agentic development workflows.

## Features

### Claude Code Feature
- **Feature**: `ghcr.io/stu-bell/devcontainer-features/claude-code:0`
- Provides Claude Code CLI integration within the devcontainer environment

### Automated Setup (setup.sh)

The `setup.sh` script automatically installs and configures the following tools when the devcontainer is created:

1. **zsh with oh-my-zsh**: Modern shell with powerful features
   - Installed and configured as the default shell
   - Includes the following plugins: git, rbenv, nodenv, sublime, brew, npm, yarn, dotnet, golang, web-search, claude
   - VS Code terminal automatically uses zsh

2. **agent-reviews**: Installed globally via npm for AI-powered code review capabilities
   - Automatically adds the `pbakaus/agent-reviews@resolve-agent-reviews` skill

3. **prek**: Pre-commit hook manager
   - Installed via official curl installer (not npm)
   - Initializes git hooks based on `prek.toml` configuration
   - Provides language-specific linting and validation

4. **markdownlint-cli**: Markdown linting tool
   - Ensures markdown files follow consistent formatting rules
   - Configured via `.markdownlintrc`

## Usage

### Opening in VS Code

1. Install the "Dev Containers" extension in VS Code
2. Open this repository in VS Code
3. Press `F1` and select "Dev Containers: Reopen in Container"
4. The container will build and run the setup script automatically

### Manual Setup

If you need to re-run the setup script manually:

```bash
bash .devcontainer/setup.sh
```

## Configuration Files

- `devcontainer.json`: Main devcontainer configuration
- `setup.sh`: Post-creation setup script
- `../prek.toml`: Pre-commit hooks configuration
- `../.markdownlintrc`: Markdown linting rules

## Customization

To modify the setup:

1. Edit `devcontainer.json` to add/remove features
2. Edit `setup.sh` to add/remove tools or change installation steps
3. Rebuild the container to apply changes
