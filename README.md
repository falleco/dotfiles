# macOS dotfiles

![Desktop setup](./assets/screenshot.png)

<p align="center"><sub>FlashSpace + SketchyBar + JankyBorders + Raycast</sub></p>

Personal Apple Silicon macOS configuration managed with Nix, nix-darwin, Home
Manager, and Homebrew. The goal is a minimal desktop with fast virtual
workspaces, keyboard-driven app launching and window actions, and a custom
status bar.

The active setup no longer uses Aerospace. Workspace management is split between
[FlashSpace](https://github.com/wojciech-kulik/FlashSpace) and
[Raycast](https://www.raycast.com/), with SketchyBar reflecting the current
FlashSpace state.

## Desktop workflow

- **Workspaces:** FlashSpace groups applications into named virtual workspaces.
  Activating one presents its assigned apps and hides the other apps on that
  display, avoiding native macOS Spaces switching animations.
- **Launcher and window actions:** Raycast handles application launching,
  keyboard shortcuts, workflows, and window-management commands.
- **Status bar:** The custom [SketchyBar](https://github.com/FelixKratz/SketchyBar)
  configuration is written in Lua. It queries the FlashSpace CLI for workspaces
  and running applications, highlights active workspaces, reacts to workspace
  changes, and switches workspaces when an item is clicked. Home Manager installs
  the SbarLua module from nixpkgs; Homebrew provides the Lua runtime used by the
  SketchyBar service.
- **Window borders:** [JankyBorders](https://github.com/FelixKratz/JankyBorders)
  provides focused-window borders.
- **Terminal:** [WezTerm](https://wezfurlong.org/wezterm/) with Starship, Zsh,
  Neovim, and the CLI tools declared in `home.nix`.

FlashSpace workspace definitions and Raycast preferences remain app-managed.
Raycast settings should be restored through Cloud Sync or an encrypted
`.rayconfig` export rather than by copying its internal application database.

## Configuration management

- `flake.nix` pins nixpkgs, nix-darwin, Home Manager, and nix-homebrew.
- `configuration.nix` manages macOS defaults and the declarative Homebrew bundle.
- `home.nix` manages user packages, shell configuration, environment variables,
  and links into `home/`.
- `home/.config/sketchybar/` contains the Lua status-bar configuration and its
  FlashSpace integration.
- `home/.config/borders/` contains the JankyBorders configuration.
- `packages/` contains local Nix packages that are not available in nixpkgs.

Homebrew cleanup uses `zap`, so applications and formulae that should survive a
rebuild must be declared in `configuration.nix`.

## Installation

Requirements:

- Apple Silicon Mac running macOS 14 or later
- Xcode Command Line Tools and Git
- An administrator account for the initial nix-darwin activation

From the repository root, run:

```bash
./bootstrap.sh
```

The bootstrap installs Determinate Nix when needed, links the repository to
`~/.dotfiles`, verifies the configured macOS username, and performs the first
nix-darwin switch.

After changing the configuration, apply it with:

```bash
./rebuild.sh
```

The old `setup.sh` is retained only as a historical reference and should not be
used; it predates the Nix configuration and still describes the former Aerospace
setup.

## After the first rebuild

1. Enable **Displays have separate Spaces** in macOS Desktop & Dock settings.
2. Open FlashSpace and Raycast and grant the macOS permissions they request.
3. Configure or restore the FlashSpace workspaces.
4. Restore Raycast through Cloud Sync or import an encrypted `.rayconfig` backup.
5. Start SketchyBar as a Homebrew service:

   ```bash
   brew services start sketchybar
   ```

Future SketchyBar restarts should also be managed through `brew services`.
