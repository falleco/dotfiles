{ stdenvNoCC, fetchurl }:

stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "no-mistakes";
  version = "1.48.0";

  src = fetchurl {
    url = "https://github.com/kunchenguid/no-mistakes/releases/download/v${finalAttrs.version}/no-mistakes-v${finalAttrs.version}-darwin-arm64.tar.gz";
    hash = "sha256-r2v6/+yPlhKCqhkzPmTwz4LRvpW6s0riKQrm1XADInk=";
  };

  sourceRoot = ".";
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/bin"
    install -m755 no-mistakes "$out/bin/no-mistakes"

    runHook postInstall
  '';

  # Preserve the official Mach-O byte-for-byte. Besides keeping the pinned
  # release auditable, this avoids rewriting its embedded signing metadata.
  dontFixup = true;

  meta = {
    description = "AI-driven validation gate for Git pushes";
    homepage = "https://github.com/kunchenguid/no-mistakes";
    mainProgram = "no-mistakes";
    platforms = [ "aarch64-darwin" ];
  };
})
