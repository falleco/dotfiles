{ user, ... }:

{
  # Determinate already manages the Nix daemon, so nix-darwin shouldn't.
  nix.enable = false;
  
  nixpkgs.config.allowUnfree = true;
  nixpkgs.hostPlatform = "aarch64-darwin"; # use x86_64-darwin for Intel CPU

  system.primaryUser = user;
  users.users.${user} = {
    home = "/Users/${user}";
  };
  system.stateVersion = 6;
  system.defaults = {
    NSGlobalDomain = {
      AppleInterfaceStyle = "Dark";
      KeyRepeat = 2;          # fast key repeat
      InitialKeyRepeat = 15;  # short delay before repeat
      _HIHideMenuBar = true;  # auto-hide the menu bar
      AppleShowAllExtensions = true;
    };
    dock.autohide = true;
    finder.FXPreferredViewStyle = "Nlsv";  # list view by default
    finder.CreateDesktop = false;          # clean desktop
  };
  nix-homebrew = {
    enable = true;
    # autoMigrate = true; # If you are comming from an existing brew setup
    inherit user;
  };
  homebrew = {
    enable = true;
    onActivation.cleanup = "zap";  # remove anything not listed here
    onActivation.autoUpdate = true;
    onActivation.extraFlags = [ "--force" ];
    brews = [
      "herdr"
      "stripe"
      "sketchybar"
      "sdkman-cli"
      "lua" # runtime used by the Homebrew SketchyBar service; SbarLua comes from Nix
      "starship"
    ];
    taps = [
      "FelixKratz/formulae"
      "sdkman/tap"
    ];
    casks = [
      "wezterm"
      "1password-cli"
      "claude-code"
      "codex"
      "my-monkeys/tap/opensuperwhisper"
      "raycast"
    ];
  };
}
