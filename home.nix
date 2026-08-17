{ config, pkgs, user, ... }:

let
  dotfiles = "${config.home.homeDirectory}/.dotfiles";
  androidSdk = "${config.home.homeDirectory}/Library/Android/sdk";
in

{
  home.username = user;
  home.homeDirectory = "/Users/${user}";
  home.stateVersion = "24.11";
  home.packages = with pkgs; [
    # cli i use constantly
    zsh
    ripgrep   # fast search
    fd        # fast find
    fzf       # fuzzy finder
    jq        # json on the command line
    lazygit
    neovim
    wget
    jq
    fzf
    ripgrep
    fd
    flashspace            # custom workspace management, allows switching between workspaces with a keyboard shortcut
    wakeonlan
    imagemagick
    ngrok
    gh
    cocoapods
    sops
    age
    terminal-notifier
    nerd-fonts.fira-code       # the font everything renders in
    fnm                        # fast node manager, NVM alternative
  ];
  fonts.fontconfig.enable = true;

  home.sessionVariables = {
    EDITOR = "nvim";
    ANDROID_HOME = androidSdk;
  };

  home.sessionPath = [
    "${config.home.homeDirectory}/.local/bin"
    "${androidSdk}/platform-tools"
    "${androidSdk}/tools"
    "${androidSdk}/tools/bin"
    "${androidSdk}/emulator"
  ];

  programs.fzf = {
    enable = true;
    enableZshIntegration = true;
  };

  programs.zsh = {
    enable = true;
    autosuggestion.enable = true;      # ghost text from history
    syntaxHighlighting.enable = true;  # commands turn green when valid
    initContent = ''
      bindkey '^f' autosuggest-accept

      # SDK Man Config
      if command -v brew >/dev/null 2>&1; then
        export SDKMAN_DIR="$(brew --prefix sdkman-cli)/libexec"
        [[ -s "$SDKMAN_DIR/bin/sdkman-init.sh" ]] &&
          source "$SDKMAN_DIR/bin/sdkman-init.sh"
      fi

      eval "$(${pkgs.fnm}/bin/fnm env --use-on-cd --shell zsh)"
    '';
    shellAliases = {
      "vim" = "nvim";
      "nvm" = "fnm";
      ".." = "cd ..";
      add = "git add .";
      push = "git push";
      pull = "git pull";
      m = "git switch main";
      cc = "claude --dangerously-skip-permissions";
      co = "codex --full-auto";
    };
  };

  programs.starship = {
    enable = true;
    settings = {
      add_newline = false;
      format = "$directory$git_branch$git_status$cmd_duration$line_break$character";
      character = {
        success_symbol = "[❯](purple)";
        error_symbol = "[❯](red)";
      };
      cmd_duration.format = "[$duration]($style) ";
    };
  };

  # Edit-in-place: the real file stays in my repo, ~/.config just points at it.
  home.file.".config/wezterm".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/wezterm";
  home.file.".config/sketchybar".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/sketchybar";
  home.file.".config/borders".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/borders";
  home.file.".config/htop".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/htop";
  home.file.".config/nvim".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/nvim";
  home.file.".config/herdr".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/herdr";
  home.file.".claude/settings.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.claude/settings.json";

  # Keep Pi's credential and runtime state local by linking only authored files and directories.
  home.file.".pi/agent/themes".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/themes";
  home.file.".pi/agent/extensions".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions";
  home.file.".pi/agent/models.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/models.json";
  home.file.".pi/agent/settings.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/settings.json";

  home.file.".claude/CLAUDE.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/AGENTS.md";
  home.file.".codex/AGENTS.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/AGENTS.md";
  home.file.".config/opencode/AGENTS.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/AGENTS.md";
}
