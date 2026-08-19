{ config, lib, pkgs, user, ... }:

let
  dotfiles = "${config.home.homeDirectory}/.dotfiles";
  androidSdk = "${config.home.homeDirectory}/Library/Android/sdk";
  nodeVersion = "24.16.0";
  agentDeviceVersion = "0.20.9";
  piCodingAgentVersion = "0.84.2";
  herdrPlugins = [
    {
      id = "herdr-sidebar";
      version = "0.7.0";
      source = "alexarthurs/herdr-sidebar/plugins/herdr-sidebar";
      ref = "dd5cc28aeae5860cffc11080c7613bf829286c72";
    }
    {
      id = "herdr-focus-notify";
      version = "0.4.0";
      source = "yankewei/herdr-focus-notify";
      ref = "f931db5090ded54086e365dfb8db896c3a3e1a05";
    }
  ];
  sbarLuaAbi = lib.versions.majorMinor pkgs.sbarlua.luaModule.version;
  noMistakes = pkgs.callPackage ./packages/no-mistakes.nix { };
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
    pnpm                       # fast, disk-efficient Node.js package manager
    eza                        # better ls
    htop                       # better top
    noMistakes                 # AI-driven validation gate for Git pushes
    bat                        # better cat
  ];
  fonts.fontconfig.enable = true;

  home.sessionVariables = {
    EDITOR = "nvim";
    ANDROID_HOME = androidSdk;
    NO_MISTAKES_NO_UPDATE_CHECK = "1";
    NO_MISTAKES_TELEMETRY = "0";
    HOMEBREW_NO_ENV_HINTS = "1";
  };

  home.sessionPath = [
    "${config.home.homeDirectory}/.local/bin"
    "${androidSdk}/platform-tools"
    "${androidSdk}/tools"
    "${androidSdk}/tools/bin"
    "${androidSdk}/emulator"
  ];

  # Keep the default fnm runtime and global Node CLI versions consistent.
  home.activation.installGlobalNodeTools = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    (
      export FNM_LOGLEVEL="quiet"

      eval "$(${pkgs.fnm}/bin/fnm env --shell bash)"
      ${pkgs.fnm}/bin/fnm install "${nodeVersion}" --progress never
      ${pkgs.fnm}/bin/fnm default "${nodeVersion}"
      ${pkgs.fnm}/bin/fnm use "${nodeVersion}"

      global_packages="$(npm list --global --depth=0 --json 2>/dev/null || true)"
      agent_device_installed="$(
        printf '%s' "$global_packages" |
          ${pkgs.jq}/bin/jq -r '.dependencies["agent-device"].version // empty'
      )"
      pi_installed="$(
        printf '%s' "$global_packages" |
          ${pkgs.jq}/bin/jq -r '.dependencies["@earendil-works/pi-coding-agent"].version // empty'
      )"

      if [ "$agent_device_installed" != "${agentDeviceVersion}" ]; then
        npm install --global "agent-device@${agentDeviceVersion}" --no-audit --no-fund
      fi

      if [ "$pi_installed" != "${piCodingAgentVersion}" ]; then
        npm install --global --ignore-scripts \
          "@earendil-works/pi-coding-agent@${piCodingAgentVersion}" \
          --no-audit --no-fund
      fi
    )
  '';

  # Herdr stores installed plugins as user state, so make the declared version
  # part of Home Manager activation. Reinstalling replaces a managed checkout.
  home.activation.installHerdrPlugins = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    (
      herdr_bin="/opt/homebrew/opt/herdr/bin/herdr"

      if [ ! -x "$herdr_bin" ]; then
        echo "Herdr is not installed at $herdr_bin" >&2
        exit 1
      fi

      export PATH="${lib.makeBinPath [ pkgs.cargo pkgs.git pkgs.rustc ]}:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

      ${lib.concatMapStringsSep "\n" (plugin: ''
        plugin_state="$(
          "$herdr_bin" plugin list --plugin "${plugin.id}" --json
        )"
        installed_version="$(
          printf '%s' "$plugin_state" |
            ${pkgs.jq}/bin/jq -r '.result.plugins[0].version // empty'
        )"
        installed_commit="$(
          printf '%s' "$plugin_state" |
            ${pkgs.jq}/bin/jq -r '.result.plugins[0].source.resolved_commit // empty'
        )"

        if [ "$installed_version" != "${plugin.version}" ] || \
           [ "$installed_commit" != "${plugin.ref}" ]; then
          run "$herdr_bin" plugin install \
            "${plugin.source}" \
            --ref "${plugin.ref}" \
            --yes
        fi
      '') herdrPlugins}
    )
  '';

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
      ls = "eza --color=always --long --git --icons=always --no-time --no-user --no-permissions";
      cat = "bat";
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
  home.file.".local/lib/lua/sketchybar.so".source =
    "${pkgs.sbarlua}/lib/lua/${sbarLuaAbi}/sketchybar.so";
  home.file.".config/borders".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/borders";
  home.file.".config/htop".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/htop";
  home.file.".config/nvim".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/nvim";
  # Only the authored config belongs in the repo. Herdr keeps plugins, session
  # state, logs, and sockets beside it under ~/.config/herdr at runtime.
  home.file.".config/herdr/config.toml".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/herdr/config.toml";
  home.file.".claude/settings.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.claude/settings.json";

  # Keep Pi's credential and runtime state local by linking only authored files and directories.
  home.file.".pi/agent/AGENTS.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/AGENTS.md";
  home.file.".pi/agent/skills".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.agents/skills";
  home.file.".pi/agent/themes".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/themes";
  home.file.".pi/agent/extensions".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions";
  home.file.".pi/agent/models.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/models.json";
  home.file.".pi/agent/settings.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/settings.json";

  # OMP
  home.file.".omp/agent/AGENTS.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/AGENTS.md";
  home.file.".omp/agent/skills".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.agents/skills";
  home.file.".omp/agent/extensions".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.omp/agent/extensions";
  home.file.".omp/agent/models.yml".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.omp/agent/models.yml";
  home.file.".omp/agent/mcp.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.omp/agent/mcp.json";
  home.file.".omp/agent/config.yml".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.omp/agent/config.yml";

  home.file.".claude/CLAUDE.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/AGENTS.md";
  home.file.".claude/skills".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.agents/skills";
  home.file.".codex/AGENTS.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/AGENTS.md";
  home.file.".config/opencode/AGENTS.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/AGENTS.md";
  home.file.".agents/AGENTS.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/AGENTS.md";
  home.file.".agents/skills".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.agents/skills";
}
