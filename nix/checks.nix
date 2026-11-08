{
  inputs,
  lib,
  packages,
  forEachSupportedSystem,
}:

forEachSupportedSystem (
  { pkgs, system }:
  let
    rust = (import ./rust.nix { inherit inputs lib; }) {
      inherit pkgs system;
    };
    cargoVendorDir = rust.craneLib.vendorCargoDeps { src = rust.workspaceSrc; };
  in
  {
    cli = packages.${system}.cli;
    fmt = rust.craneLib.cargoFmt {
      src = rust.workspaceSrc;
      pname = "cf-nix-cache";
      version = rust.workspaceVersion;
    };
    clippy = rust.craneLib.cargoClippy {
      src = rust.workspaceSrc;
      strictDeps = true;
      pname = "cf-nix-cache";
      version = rust.workspaceVersion;
      cargoArtifacts = rust.cargoArtifacts;
      cargoClippyExtraArgs = "--all-targets -- --deny warnings";
    };
    test = rust.craneLib.cargoTest {
      src = rust.workspaceSrc;
      strictDeps = true;
      pname = "cf-nix-cache";
      version = rust.workspaceVersion;
      cargoArtifacts = rust.cargoArtifacts;
      cargoTestExtraArgs = "--workspace";
    };
    hakari =
      pkgs.runCommand "cf-nix-cache-hakari"
        {
          src = rust.hakariSrc;
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
