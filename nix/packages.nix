{
  inputs,
  lib,
  forEachSupportedSystem,
}:

forEachSupportedSystem (
  { pkgs, system }:
  let
    rust = (import ./rust.nix { inherit inputs lib; }) {
      inherit pkgs system;
    };
    cli = rust.craneLib.buildPackage (
      rust.commonArgs
      // {
        cargoArtifacts = rust.cargoArtifacts;
        cargoExtraArgs = "--locked -p cf-nix-cache";
        doCheck = false;
      }
    );
    verifier = rust.wasmCraneLib.buildPackage (
      rust.wasmArgs
      // {
        cargoArtifacts = rust.wasmCargoArtifacts;
        CARGO_PROFILE = "release";
        doCheck = false;
        installPhaseCommand = ''
          mkdir -p $out
          cp "''${CARGO_TARGET_DIR:-target}/$CARGO_BUILD_TARGET/release/cf_nix_cache_verify.wasm" $out/verify.wasm
        '';
      }
    );
  in
  {
    inherit cli verifier;
    default = cli;
  }
)
