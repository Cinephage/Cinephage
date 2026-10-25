{
  self,
  inputs,
  ...
}: {
  imports = [
  ];
  perSystem = {
    pkgs,
    self',
    system,
    lib,
    ...
  }: {
  packages.default = pkgs.buildNpmPackage {
  pname = "cinephage";
  version = "0.0.1";

  src = lib.cleanSourceWith {
    filter = (
      path: type:
      let
        baseName = baseNameOf path;
        relPath = lib.removePrefix (toString ./..) path;
      in
      # Include essential source files
      (lib.hasPrefix "src/" relPath)
      || (lib.hasPrefix "static/" relPath)
      || (lib.hasPrefix "data/indexers/" relPath)
      || (baseName == "package.json")
      || (baseName == "package-lock.json")
      || (baseName == "vite.config.ts")
      || (baseName == "vite.config.js")
      || (baseName == "tsconfig.json")
      || (baseName == "tailwind.config.js")
      || (baseName == "tailwind.config.ts")
      || (baseName == "eslint.config.js")
      || (baseName == ".npmrc")
      || (baseName == ".prettierrc")
      || (baseName == ".prettierignore")
      || (baseName == ".gitignore")
      || (baseName == "server.js")
      ||
        # Exclude unnecessary files and directories
        !(
          lib.hasPrefix "." baseName
          && baseName != ".npmrc"
          && baseName != ".prettierrc"
          && baseName != ".prettierignore"
          && baseName != ".gitignore"
        )
        && !(
          type == "directory"
          && (
            baseName == "node_modules"
            || baseName == "build"
            || baseName == ".output"
            || baseName == ".svelte-kit"
            || baseName == ".git"
            || baseName == ".github"
            || baseName == ".vscode"
            || baseName == "docs"
            || baseName == "scripts"
            || baseName == "Inspiration"
            || baseName == ".claude"
            || baseName == ".opencode"
            || baseName == "logs"
            || baseName == "tmp"
            || baseName == "temp"
            || baseName == ".tmp"
          )
        )
        &&
          # Exclude database files, logs, and environment files
          !(lib.hasSuffix ".db" baseName)
        && !(lib.hasSuffix ".log" baseName)
        && !(lib.hasPrefix ".env" baseName)
        && !(lib.hasSuffix ".bak" baseName)
        && !(lib.hasSuffix ".backup" baseName)
        && !(lib.hasSuffix ".swp" baseName)
        && !(lib.hasSuffix ".swo" baseName)
        && !(lib.hasSuffix "~" baseName)
        && !(lib.hasSuffix ".sqlite" baseName)
        && !(lib.hasSuffix ".sqlite3" baseName)
        && !(lib.hasSuffix ".tsbuildinfo" baseName)
    );
    src = ../.;
  };

  npmDepsHash = "sha256-ui0odlVImAMTzYGPJGbYl3osUj+bDkGo8fylKkNGYlo=";

  buildPhase = ''
    runHook preBuild
    npm run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    # Install the built application
    mkdir -p $out/lib
    cp -r build $out/lib/
    cp -r static $out/lib/
    cp -r data $out/lib/
    cp server.js $out/lib/
    cp -r node_modules $out/lib/

    # Create the wrapper script
    mkdir -p $out/bin
    makeWrapper ${pkgs.nodejs}/bin/node $out/bin/cinephage \
      --add-flags "$out/lib/server.js" \
      --chdir "$out/lib" \
      --set NODE_PATH "$out/lib/node_modules"

    runHook postInstall
  '';

  meta = with lib; {
    description = "A media management application";
    homepage = "https://github.com/cinephage/cinephage";
    license = licenses.gpl3Plus;
    platforms = platforms.linux ++ platforms.darwin;
    mainProgram = "cinephage";
  };
  };
  };
}
