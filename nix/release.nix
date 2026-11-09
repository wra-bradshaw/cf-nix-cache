# A cf-nix-cache binary that runs without /nix/store, for release downloads:
# static musl on Linux, and on macOS the Nix build relinked to the system's
# libiconv.
{
  inputs,
  pkgs,
  system,
  rust,
  cli,
}:
if pkgs.stdenv.hostPlatform.isLinux then
  let
    static = pkgs.pkgsStatic;
    fenix = inputs.fenix.packages.${system};
    toolchain = fenix.combine [
      (fenix.stable.withComponents [
        "cargo"
        "rustc"
      ])
      fenix.targets.${static.stdenv.hostPlatform.rust.rustcTarget}.stable.rust-std
    ];
    craneLib = (inputs.crane.mkLib static).overrideToolchain (_: toolchain);
  in
  craneLib.buildPackage (
    rust.commonArgs
    // {
      cargoExtraArgs = "--locked -p cf-nix-cache";
      doCheck = false;
    }
  )
else
  pkgs.runCommandCC "cf-nix-cache-${cli.version}-release"
    { nativeBuildInputs = [ pkgs.darwin.sigtool ]; }
    ''
      bin="$out/bin/cf-nix-cache"
      install -Dm755 ${cli}/bin/cf-nix-cache "$bin"
      for lib in $(otool -L "$bin" | tail -n +2 | awk '/\/nix\/store\// { print $1 }'); do
        install_name_tool -change "$lib" "/usr/lib/$(basename "$lib")" "$bin"
      done
      if otool -L "$bin" | tail -n +2 | grep /nix/store; then
        echo "still links libraries in /nix/store" >&2
        exit 1
      fi
      codesign -f -s - "$bin"
    ''
