{
  inputs,
  lib,
  packages,
  forEachSupportedSystem,
}:

forEachSupportedSystem (
  { pkgs, system }:
  let
    workspaceSrc = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../Cargo.toml
        ../Cargo.lock
        ../crates
        ../schemas
      ];
    };
    rustToolchain = inputs.fenix.packages.${system}.stable.withComponents [ "cargo" ];
    craneLib = (inputs.crane.mkLib pkgs).overrideToolchain rustToolchain;
    cargoVendorDir = craneLib.vendorCargoDeps { src = workspaceSrc; };
  in
  {
    cli = packages.${system}.cli;
    processor = packages.${system}.processor;
    hakari =
      pkgs.runCommand "cf-nix-cache-hakari"
        {
          src = ../.;
          nativeBuildInputs = [
            pkgs.cargo-hakari
            pkgs.cargo
          ];
        }
        ''
          export CARGO_HOME="$TMPDIR/cargo-home"
          mkdir -p "$CARGO_HOME"
          cp ${cargoVendorDir}/config.toml "$CARGO_HOME/config.toml"
          cd "$src"
          cargo hakari generate --diff
          cargo hakari manage-deps --dry-run
          cargo hakari verify
          touch "$out"
        '';
  }
)
